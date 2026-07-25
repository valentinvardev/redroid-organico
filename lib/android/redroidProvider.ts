import { z } from 'zod';
import { adbConnect, adbDisconnect, type AdbTarget } from './adb';
import { AdbDevice, type AndroidDevice } from './device';
import {
  ACCOUNT_LABEL,
  CREATED_AT_LABEL,
  DockerCli,
  JOB_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  type DockerClient,
} from './docker';
import { ensurePackageInstalled, type AcquireContext, type AcquiredDevice, type DeviceProvider } from './deviceProvider';

export const redroidConfigSchema = z.object({
  /**
   * The golden image: ReDroid with the app under test already installed.
   * Must match the host architecture — an arm64 image on an x86 host either
   * refuses to start or crawls under qemu.
   */
  image: z.string().min(1),

  /**
   * Named Docker volume mounted at /data, which is where Android keeps
   * everything that must survive between runs: the logged-in session, app
   * databases, shared preferences. Defaults to one volume per account so two
   * accounts can never see each other's state.
   */
  sessionVolume: z.string().min(1).optional(),

  /**
   * How ADB reaches the container.
   *  - `published-port`: Docker maps 5555 to a free host port. Right when the
   *    worker and the adb server share a host.
   *  - `container-name`: reach the container directly at <name>:5555 over a
   *    shared Docker network. Right when the worker runs in a container too.
   */
  connectVia: z.enum(['published-port', 'container-name']).default('published-port'),
  /** Host that a published port is reachable on. */
  connectHost: z.string().min(1).default('127.0.0.1'),

  /** Passed to `docker run --network`, so an external egress gateway can be joined. */
  network: z.string().min(1).optional(),

  memoryLimit: z.string().min(1).default('4g'),
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  dpi: z.number().int().positive().default(480),
  /** `guest` is software rendering — the only option on a server with no GPU. */
  gpuMode: z.enum(['guest', 'host', 'auto']).default('guest'),

  /**
   * Host path where binderfs is mounted, bind-mounted into the container.
   *
   * Kernels from 5.x on set CONFIG_ANDROID_BINDER_DEVICES="" and create no
   * static /dev/binder; the devices live in binderfs instead. Mount it on the
   * host first:
   *
   *   sudo mount -t binder binder /dev/binderfs
   *
   * Set to null on a host that still exposes /dev/binder directly.
   */
  binderfsPath: z.string().min(1).nullable().default('/dev/binderfs'),

  /**
   * Android's shared memory. Modern kernels dropped ashmem entirely — a 26.04
   * AWS kernel has no CONFIG_ASHMEM at all — and ReDroid 12+ falls back to
   * memfd, but only when told to. Without this the container boots and then
   * hangs with no obvious error.
   */
  useMemfd: z.boolean().default(true),

  /** Extra `androidboot.*` arguments appended verbatim. */
  extraArgs: z.array(z.string()).default([]),

  startTimeoutSeconds: z.number().int().positive().max(900).default(120),
});

export type RedroidConfig = z.infer<typeof redroidConfigSchema>;

export interface RedroidProviderOptions {
  config: RedroidConfig;
  /** adb server to route through — normally the one Appium uses. */
  adbCommand: string;
  adbServer?: AdbTarget;
  bootTimeoutSeconds: number;
  docker?: DockerClient;
  /** Test seams. Production uses the real adb client and AdbDevice. */
  connect?: (serial: string, signal: AbortSignal) => Promise<void>;
  disconnect?: (serial: string) => Promise<void>;
  createDevice?: (serial: string) => AndroidDevice;
}

function containerName(jobId: string): string {
  // Docker names must start alphanumeric; a cuid always does.
  return `redroid-job-${jobId}`.slice(0, 60);
}

function sessionVolumeName(config: RedroidConfig, accountId: string): string {
  return config.sessionVolume ?? `redroid-session-${accountId}`;
}

/**
 * Creates one throwaway Android container per job, waits until it is genuinely
 * usable, and guarantees it is destroyed afterwards.
 *
 * Three independent mechanisms keep containers from leaking, because any one of
 * them can be bypassed:
 *  1. `release()` in the publisher's `finally` — the normal path, and the one
 *     that runs even when Appium blows up mid-flow.
 *  2. Timeouts on every docker call, so teardown cannot hang forever on a
 *     wedged daemon.
 *  3. The reaper in lib/android/reaper.ts, which is the only thing that helps
 *     when the worker is SIGKILLed and no `finally` ever runs.
 */
export class EphemeralRedroidProvider implements DeviceProvider {
  readonly kind = 'redroid';
  private readonly docker: DockerClient;

  constructor(private readonly options: RedroidProviderOptions) {
    this.docker = options.docker ?? new DockerCli();
  }

  async acquire(context: AcquireContext): Promise<AcquiredDevice> {
    const { config } = this.options;
    const name = containerName(context.jobId);
    const volume = sessionVolumeName(config, context.accountId);

    await this.refuseConcurrentRunForAccount(context);

    await this.docker.ensureVolume(volume, {
      [OWNER_LABEL]: OWNER_VALUE,
      [ACCOUNT_LABEL]: context.accountId,
    });

    // A container left over from a previous attempt at the same job would make
    // `docker run` fail on the name. Removing it is safe: the job is being
    // started now, so nothing can legitimately be using it.
    await this.docker.remove(name).catch(() => undefined);

    await context.log.info('Starting ephemeral Android container', {
      container: name,
      image: config.image,
      sessionVolume: volume,
    });

    await this.docker.run(
      {
        image: config.image,
        name,
        labels: {
          [OWNER_LABEL]: OWNER_VALUE,
          [JOB_LABEL]: context.jobId,
          [ACCOUNT_LABEL]: context.accountId,
          [CREATED_AT_LABEL]: new Date().toISOString(),
        },
        privileged: true,
        network: config.network,
        memoryLimit: config.memoryLimit,
        publishContainerPort: config.connectVia === 'published-port' ? 5555 : undefined,
        volumes: [
          { source: volume, target: '/data' },
          ...(config.binderfsPath
            ? [{ source: config.binderfsPath, target: '/dev/binderfs' }]
            : []),
        ],
        command: [
          `androidboot.redroid_width=${config.width}`,
          `androidboot.redroid_height=${config.height}`,
          `androidboot.redroid_dpi=${config.dpi}`,
          `androidboot.redroid_gpu_mode=${config.gpuMode}`,
          ...(config.useMemfd ? ['androidboot.use_memfd=1'] : []),
          ...config.extraArgs,
        ],
      },
      { signal: context.signal },
    );

    let serial: string | undefined;

    const release = async () => {
      if (serial) {
        const disconnect =
          this.options.disconnect ??
          ((address: string) => adbDisconnect(this.options.adbCommand, this.options.adbServer, address));

        await disconnect(serial).catch(() => undefined);
      }

      try {
        await this.docker.remove(name);
        await context.log.info('Ephemeral Android container removed', { container: name });
      } catch (cause) {
        // Losing the container is bad but it is not this job's failure to
        // report, and the reaper will collect it on the next sweep.
        await context.log
          .warn('Could not remove the Android container; the reaper will collect it', {
            container: name,
            error: cause instanceof Error ? cause.message : String(cause),
          })
          .catch(() => undefined);
      }
    };

    try {
      serial = await this.resolveSerial(name, context);
      const device = await this.waitUntilUsable(serial, name, context);
      await ensurePackageInstalled(device, context);

      await context.log.info('Android container ready', { container: name, serial });

      return { device, serial, release };
    } catch (error) {
      // Read the logs before tearing anything down. Doing this after release()
      // means every failure report says "No such container" instead of showing
      // why the container was unhappy — the diagnostic destroyed by the cleanup
      // it was meant to explain.
      const enriched = await this.enrich(error, name);

      // Acquisition failed, so nobody downstream will ever call release().
      await release();
      throw enriched;
    }
  }

  /**
   * Two jobs for one account would mount the same session volume at the same
   * time and corrupt it. The per-account rate limiter already serialises this
   * when maxConcurrent is 1; this is the backstop for when it is not.
   */
  private async refuseConcurrentRunForAccount(context: AcquireContext): Promise<void> {
    const existing = await this.docker.listByLabel(ACCOUNT_LABEL, context.accountId);
    const others = existing.filter((container) => container.labels[JOB_LABEL] !== context.jobId);

    if (others.length > 0) {
      throw new Error(
        `Account ${context.accountId} already has a container running (${others
          .map((container) => container.name)
          .join(', ')}). Two runs would share one session volume and corrupt it.`,
      );
    }
  }

  private async resolveSerial(name: string, context: AcquireContext): Promise<string> {
    const { config } = this.options;

    if (config.connectVia === 'container-name') {
      return `${name}:5555`;
    }

    const deadline = Date.now() + config.startTimeoutSeconds * 1_000;

    // The port map stays empty for a moment after `docker run` returns.
    while (Date.now() < deadline) {
      if (context.signal.aborted) {
        throw new Error('Cancelled while waiting for the container to publish its ADB port');
      }

      const port = await this.docker.hostPort(name, 5555, { signal: context.signal });

      if (port) {
        return `${config.connectHost}:${port}`;
      }

      if (!(await this.docker.isRunning(name, { signal: context.signal }))) {
        throw new Error(`Container ${name} exited before publishing its ADB port`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Container ${name} never published its ADB port within ${config.startTimeoutSeconds}s`);
  }

  /**
   * Readiness in three gates, because each one can pass while the next fails:
   * the container runs, ADB accepts a connection, and Android has finished
   * booting. Handing a half-booted device to Appium is the classic source of
   * "element not found" runs that have nothing to do with the flow.
   */
  private async waitUntilUsable(serial: string, name: string, context: AcquireContext): Promise<AndroidDevice> {
    const { config, adbCommand, adbServer, bootTimeoutSeconds } = this.options;
    const connect =
      this.options.connect ??
      ((address: string, signal: AbortSignal) => adbConnect(adbCommand, adbServer, address, signal));
    const deadline = Date.now() + config.startTimeoutSeconds * 1_000;
    let lastError: unknown;

    for (;;) {
      if (context.signal.aborted) {
        throw new Error('Cancelled while connecting to the Android container');
      }

      if (!(await this.docker.isRunning(name, { signal: context.signal }))) {
        throw new Error(`Container ${name} stopped while waiting for ADB`);
      }

      try {
        await connect(serial, context.signal);
        break;
      } catch (error) {
        lastError = error;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `ADB never accepted a connection to ${serial} within ${config.startTimeoutSeconds}s` +
            (lastError instanceof Error ? `: ${lastError.message}` : ''),
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    const device =
      this.options.createDevice?.(serial) ?? new AdbDevice(adbCommand, { ...adbServer, serial });

    await device.waitUntilReady(bootTimeoutSeconds * 1_000, context.signal);

    return device;
  }

  /** Container logs are the only explanation when ReDroid refuses to boot. */
  private async enrich(error: unknown, name: string): Promise<unknown> {
    const message = error instanceof Error ? error.message : String(error);
    const logs = await this.docker.logs(name, 40).catch(() => '');

    if (!logs) {
      return error;
    }

    return new Error(`${message}\n--- last lines of ${name} ---\n${logs}`, { cause: error });
  }
}
