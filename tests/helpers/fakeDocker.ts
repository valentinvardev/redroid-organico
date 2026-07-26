import type { ContainerSummary, DockerClient, RunContainerSpec } from '@/lib/android/docker';

interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
  publishedPort?: number;
  /** Verbatim `--network` value, so `container:<name>` dependencies are visible. */
  network?: string;
}

export interface FakeDockerOptions {
  /** Container reports no published port until this many `hostPort` calls have happened. */
  portAppearsAfter?: number;
  /** `docker run` throws. */
  failRun?: Error;
  /** `docker rm` throws, simulating a wedged daemon. */
  failRemove?: Error;
  /** The container exits on its own right after starting. */
  exitsImmediately?: boolean;
  /** Names whose containers exit right after starting, e.g. a gateway with a bad proxy. */
  exitsImmediatelyByName?: string[];
}

/** An in-memory Docker daemon: enough to drive the container lifecycle in tests. */
export class FakeDocker implements DockerClient {
  readonly containers = new Map<string, FakeContainer>();
  readonly volumes = new Map<string, Record<string, string>>();
  readonly runs: RunContainerSpec[] = [];
  readonly removed: string[] = [];
  private hostPortCalls = 0;
  private nextPort = 33000;

  constructor(private readonly options: FakeDockerOptions = {}) {}

  private find(nameOrId: string): FakeContainer | undefined {
    return (
      this.containers.get(nameOrId) ??
      Array.from(this.containers.values()).find((container) => container.id === nameOrId)
    );
  }

  async run(spec: RunContainerSpec): Promise<string> {
    if (this.options.failRun) {
      throw this.options.failRun;
    }

    if (this.containers.has(spec.name)) {
      throw new Error(`Conflict. The container name "/${spec.name}" is already in use`);
    }

    const container: FakeContainer = {
      id: `id-${this.containers.size + 1}`,
      name: spec.name,
      labels: { ...spec.labels },
      running:
        !this.options.exitsImmediately &&
        !(this.options.exitsImmediatelyByName ?? []).includes(spec.name),
      publishedPort: spec.publishContainerPort !== undefined ? this.nextPort++ : undefined,
      network: spec.network,
    };

    this.containers.set(spec.name, container);
    this.runs.push(spec);

    return container.id;
  }

  async hostPort(nameOrId: string, _containerPort: number): Promise<number | null> {
    this.hostPortCalls += 1;

    if (this.options.portAppearsAfter && this.hostPortCalls < this.options.portAppearsAfter) {
      return null;
    }

    return this.find(nameOrId)?.publishedPort ?? null;
  }

  async isRunning(nameOrId: string): Promise<boolean> {
    return this.find(nameOrId)?.running ?? false;
  }

  async logs(): Promise<string> {
    return 'redroid: fake container logs';
  }

  async remove(nameOrId: string): Promise<void> {
    if (this.options.failRemove) {
      throw this.options.failRemove;
    }

    const container = this.find(nameOrId);

    if (!container) {
      return;
    }

    // Docker's own rule, and the reason teardown is ordered: a container whose
    // network namespace another one is sharing cannot be removed.
    const dependant = Array.from(this.containers.values()).find(
      (other) => other.network === `container:${container.name}`,
    );

    if (dependant) {
      throw new Error(
        `cannot remove container "${container.name}": container ${dependant.name} is using its network namespace`,
      );
    }

    this.containers.delete(container.name);
    this.removed.push(container.name);
  }

  async listByLabel(label: string, value: string): Promise<ContainerSummary[]> {
    return Array.from(this.containers.values())
      .filter((container) => container.labels[label] === value)
      .map((container) => ({ id: container.id, name: container.name, labels: container.labels }));
  }

  async ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    this.volumes.set(name, labels);
  }

  /** Simulates a container that was left behind by a worker that never shut down. */
  seedOrphan(name: string, labels: Record<string, string>, network?: string): void {
    this.containers.set(name, {
      id: `id-${name}`,
      name,
      labels,
      running: true,
      network,
    });
  }
}
