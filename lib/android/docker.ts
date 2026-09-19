import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Every container this system creates carries these labels. They are the only
 * thing the reaper needs in order to recognise its own containers after a
 * worker restart, which is what stops a SIGKILLed worker from leaking Android
 * instances that each hold a gigabyte of RAM.
 */
export const OWNER_LABEL = 'redroid-organico.owner';
export const OWNER_VALUE = 'redroid-organico';
export const JOB_LABEL = 'redroid-organico.jobId';
export const ACCOUNT_LABEL = 'redroid-organico.accountId';
export const CREATED_AT_LABEL = 'redroid-organico.createdAt';

/**
 * What the container is for. The reaper needs it because the two roles are not
 * interchangeable at teardown: a device shares its gateway's network namespace,
 * and Docker refuses to remove a container another one is still borrowing the
 * namespace of.
 */
export const ROLE_LABEL = 'redroid-organico.role';
export const DEVICE_ROLE = 'device';
export const GATEWAY_ROLE = 'egress-gateway';
export const CAMERA_ROLE = 'camera-bridge';

/**
 * Which host `/dev/videoN` a job was lent, written on both the device and its
 * camera bridge.
 *
 * A label rather than a registry of its own, because that makes the question
 * "which cameras are taken" a `docker ps` and the answer survives a worker
 * restart. The Redis lease in lib/android/cameraSlots.ts exists only to settle
 * races between workers; this is the durable record it reconciles against, and
 * the reason removing a container is all it takes to free the device.
 */
export const CAMERA_LABEL = 'redroid-organico.cameraIndex';

export class DockerError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DockerError';
    this.stderr = stderr;
  }
}

export interface DockerExecOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function docker(
  dockerCommand: string,
  args: string[],
  options: DockerExecOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(dockerCommand, args, {
      signal: options.signal,
      // Teardown must not be able to hang forever. Without a timeout a wedged
      // daemon turns "remove the container" into a job that never returns.
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return String(stdout).trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    const stderr = String(failure.stderr ?? '').trim();

    throw new DockerError(
      `docker ${args.join(' ')} failed: ${stderr || failure.message || String(error)}`,
      stderr,
      error,
    );
  }
}

export interface RunContainerSpec {
  image: string;
  name: string;
  labels: Record<string, string>;
  /** Container port to publish on an ephemeral host port, e.g. 5555 for adb. */
  publishContainerPort?: number;
  volumes?: Array<{ source: string; target: string }>;
  env?: Record<string, string>;
  privileged?: boolean;
  /** Linux capabilities to add — `NET_ADMIN` for anything that builds a tun device. */
  capAdd?: string[];
  /** Host devices to expose, e.g. `/dev/net/tun`. */
  devices?: string[];
  /**
   * Passed straight to `--network`. Two forms are in use: a network name, and
   * `container:<name>` to run inside another container's network namespace,
   * which is how a device is pinned to its proxy gateway.
   */
  network?: string;
  /**
   * Namespaced kernel parameters, e.g. `net.ipv6.conf.all.disable_ipv6`. A
   * container sharing this one's namespace inherits them, which is the only way
   * to reach Android's stack: the gateway image ships no ip6tables.
   */
  sysctls?: Record<string, string>;
  memoryLimit?: string;
  /** ReDroid takes its configuration as kernel-style command arguments. */
  command?: string[];
}

export interface DockerClient {
  run(spec: RunContainerSpec, options?: DockerExecOptions): Promise<string>;
  /** Host port mapped to `containerPort`, or null when it is not published yet. */
  hostPort(nameOrId: string, containerPort: number, options?: DockerExecOptions): Promise<number | null>;
  isRunning(nameOrId: string, options?: DockerExecOptions): Promise<boolean>;
  logs(nameOrId: string, tailLines: number, options?: DockerExecOptions): Promise<string>;
  remove(nameOrId: string, options?: DockerExecOptions): Promise<void>;
  listByLabel(label: string, value: string, options?: DockerExecOptions): Promise<ContainerSummary[]>;
  ensureVolume(name: string, labels: Record<string, string>, options?: DockerExecOptions): Promise<void>;
  /**
   * Runs a command inside a container. Used to reconfigure the network
   * namespace after Android's netd has finished rearranging it, which is a
   * moment `docker run` cannot express.
   */
  exec(nameOrId: string, command: string[], options?: DockerExecOptions): Promise<string>;
  /**
   * Attaches a running container to a second network. `docker run` takes only
   * one, and the gateway needs two: egress for the proxy, control for ADB.
   */
  connectNetwork(network: string, nameOrId: string, options?: DockerExecOptions): Promise<void>;
  /** CIDRs configured on a network, so the egress ACL can name the control plane. */
  networkSubnets(network: string, options?: DockerExecOptions): Promise<string[]>;
}

export interface ContainerSummary {
  id: string;
  name: string;
  labels: Record<string, string>;
}

function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const entry of raw.split(',')) {
    const index = entry.indexOf('=');
    if (index > 0) {
      labels[entry.slice(0, index)] = entry.slice(index + 1);
    }
  }

  return labels;
}

export class DockerCli implements DockerClient {
  constructor(private readonly dockerCommand = 'docker') {}

  async run(spec: RunContainerSpec, options: DockerExecOptions = {}): Promise<string> {
    const args = ['run', '--detach', '--name', spec.name];

    for (const [key, value] of Object.entries(spec.labels)) {
      args.push('--label', `${key}=${value}`);
    }

    if (spec.privileged) {
      args.push('--privileged');
    }

    for (const capability of spec.capAdd ?? []) {
      args.push('--cap-add', capability);
    }

    for (const device of spec.devices ?? []) {
      args.push('--device', device);
    }

    if (spec.network) {
      args.push('--network', spec.network);
    }

    if (spec.memoryLimit) {
      args.push('--memory', spec.memoryLimit);
    }

    if (spec.publishContainerPort !== undefined) {
      // Port 0 asks Docker for a free host port. Letting the daemon allocate
      // removes the need for a port registry and the races that come with one
      // when several workers start containers at the same moment.
      args.push('--publish', `127.0.0.1::${spec.publishContainerPort}`);
    }

    for (const volume of spec.volumes ?? []) {
      args.push('--volume', `${volume.source}:${volume.target}`);
    }

    for (const [key, value] of Object.entries(spec.env ?? {})) {
      args.push('--env', `${key}=${value}`);
    }

    for (const [key, value] of Object.entries(spec.sysctls ?? {})) {
      args.push('--sysctl', `${key}=${value}`);
    }

    args.push(spec.image, ...(spec.command ?? []));

    return docker(this.dockerCommand, args, options);
  }

  async hostPort(nameOrId: string, containerPort: number, options: DockerExecOptions = {}): Promise<number | null> {
    const format = `{{ (index (index .NetworkSettings.Ports "${containerPort}/tcp") 0).HostPort }}`;

    try {
      const stdout = await docker(this.dockerCommand, ['inspect', '--format', format, nameOrId], options);
      const port = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(port) && port > 0 ? port : null;
    } catch {
      // The port map is empty until the container actually starts.
      return null;
    }
  }

  async isRunning(nameOrId: string, options: DockerExecOptions = {}): Promise<boolean> {
    try {
      const stdout = await docker(
        this.dockerCommand,
        ['inspect', '--format', '{{.State.Running}}', nameOrId],
        options,
      );
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async logs(nameOrId: string, tailLines: number, options: DockerExecOptions = {}): Promise<string> {
    try {
      // docker logs writes to stderr as well; execFile gives us stdout only,
      // which is enough for a diagnostic tail.
      return await docker(this.dockerCommand, ['logs', '--tail', String(tailLines), nameOrId], options);
    } catch (error) {
      return error instanceof DockerError ? error.stderr : '';
    }
  }

  async remove(nameOrId: string, options: DockerExecOptions = {}): Promise<void> {
    // -f kills and removes in one call. -v drops the container's anonymous
    // volumes; the named session volume is not anonymous, so it survives.
    await docker(this.dockerCommand, ['rm', '--force', '--volumes', nameOrId], {
      ...options,
      // Teardown gets its own short budget and, deliberately, no abort signal:
      // a cancelled job must still clean up after itself.
      signal: undefined,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }

  async listByLabel(label: string, value: string, options: DockerExecOptions = {}): Promise<ContainerSummary[]> {
    const stdout = await docker(
      this.dockerCommand,
      ['ps', '--all', '--filter', `label=${label}=${value}`, '--format', '{{.ID}}\t{{.Names}}\t{{.Labels}}'],
      options,
    );

    if (!stdout) {
      return [];
    }

    return stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((parts) => parts.length >= 2)
      .map(([id, name, labels]) => ({ id, name, labels: parseLabels(labels ?? '') }));
  }

  async exec(nameOrId: string, command: string[], options: DockerExecOptions = {}): Promise<string> {
    return docker(this.dockerCommand, ['exec', nameOrId, ...command], options);
  }

  async connectNetwork(network: string, nameOrId: string, options: DockerExecOptions = {}): Promise<void> {
    try {
      await docker(this.dockerCommand, ['network', 'connect', network, nameOrId], options);
    } catch (error) {
      // Re-connecting an already-attached container is not a failure; a retried
      // acquisition would otherwise die on its own previous success.
      if (error instanceof DockerError && /already exists in network|is already attached/i.test(error.stderr)) {
        return;
      }

      throw error;
    }
  }

  async networkSubnets(network: string, options: DockerExecOptions = {}): Promise<string[]> {
    const stdout = await docker(
      this.dockerCommand,
      ['network', 'inspect', network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'],
      options,
    );

    return stdout.split(/\s+/).filter((entry) => entry.includes('/'));
  }

  async ensureVolume(name: string, labels: Record<string, string>, options: DockerExecOptions = {}): Promise<void> {
    const args = ['volume', 'create'];

    for (const [key, value] of Object.entries(labels)) {
      args.push('--label', `${key}=${value}`);
    }

    args.push(name);

    // `volume create` is idempotent: it returns the existing volume's name.
    await docker(this.dockerCommand, args, options);
  }
}
