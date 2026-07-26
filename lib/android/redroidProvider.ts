import { z } from 'zod';
import type { ProxyRuntimeConfig } from '@/lib/proxy/config';
import { adbConnect, adbDisconnect, type AdbTarget } from './adb';
import { AdbDevice, type AndroidDevice } from './device';
import {
  ACCOUNT_LABEL,
  CREATED_AT_LABEL,
  DEVICE_ROLE,
  DockerCli,
  JOB_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  ROLE_LABEL,
  type DockerClient,
} from './docker';
import { proxyGatewayConfigSchema, startProxyGateway, type RunningGateway } from './proxyGateway';
import { applyEgressPolicy, policyFromEnv, resolveProxyEndpoints } from './egressPolicy';
import { assertProxiedEgress, egressCheckHost, ensureProbeBinary } from './egressCheck';
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

  /**
   * Passed to `docker run --network`. When the account has a proxy this is the
   * network the *gateway* joins, since the device then lives inside the
   * gateway's namespace and cannot be given one of its own. It is also the
   * network the proxy is reached over, so it must have a way off the host.
   */
  network: z.string().min(1).optional(),

  /**
   * A second network carrying only ADB, joined by the gateway after it starts.
   * Create it with `internal: true` — see docker-compose.yml. Then the subnet
   * the egress ACL has to leave open is one with no route to the internet, and
   * the control plane stops being a hole in the isolation.
   *
   * Only meaningful together with a proxy.
   */
  controlNetwork: z.string().min(1).optional(),

  /**
   * How the per-job tun2socks gateway is built. Unused by accounts with no
   * proxy. `prefault` rather than `default`: a default is handed straight out
   * without being parsed, so `{}` would have to spell out every field the inner
   * schema already has a default for.
   */
  proxyGateway: proxyGatewayConfigSchema.prefault({}),

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
  /**
   * The account's egress, already decrypted. Present means every job for this
   * account runs inside a tun2socks namespace; absent means it leaves through
   * the host's own address.
   */
  proxy?: ProxyRuntimeConfig | null;
  /** adb server to route through — normally the one Appium uses. */
  adbCommand: string;
  adbServer?: AdbTarget;
  bootTimeoutSeconds: number;
  docker?: DockerClient;
  /** Test seams. Production uses the real adb client and AdbDevice. */
  connect?: (serial: string, signal: AbortSignal) => Promise<void>;
  disconnect?: (serial: string) => Promise<void>;
  createDevice?: (serial: string) => AndroidDevice;
  /**
   * The address this host is seen as, which is what a leaked packet would show.
   * A seam as well: without it the egress check would reach the internet from
   * the test suite.
   */
  resolveDirectIp?: () => Promise<string | null>;
  /** Same reason: resolving the proxy host is a DNS query the suite must not make. */
  lookupHost?: (host: string) => Promise<string[]>;
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
    const { config, proxy } = this.options;
    const name = containerName(context.jobId);
    const volume = sessionVolumeName(config, context.accountId);
    const publishesPort = config.connectVia === 'published-port';

    await this.refuseConcurrentRunForAccount(context);

    await this.docker.ensureVolume(volume, {
      [OWNER_LABEL]: OWNER_VALUE,
      [ACCOUNT_LABEL]: context.accountId,
    });

    // A container left over from a previous attempt at the same job would make
    // `docker run` fail on the name. Removing it is safe: the job is being
    // started now, so nothing can legitimately be using it. The device goes
    // first — Docker refuses to remove a gateway whose network namespace
    // another container is still borrowing.
    await this.docker.remove(name).catch(() => undefined);

    // Started before the device, because the device is placed *inside* its
    // namespace and there is nothing to join otherwise.
    const gateway = proxy
      ? await startProxyGateway({
          docker: this.docker,
          proxy,
          jobId: context.jobId,
          accountId: context.accountId,
          config: config.proxyGateway,
          network: config.network,
          controlNetwork: config.controlNetwork,
          // Publishing has to happen on whichever container owns the network
          // stack, and with a gateway that is not the device.
          publishContainerPort: publishesPort ? 5555 : undefined,
          log: context.log,
          signal: context.signal,
        })
      : null;

    // What the rest of the world addresses. With a gateway the device has no
    // network identity of its own: no name to resolve, no ports to map.
    const networkHost = gateway?.name ?? name;

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

      // Strictly after the device: while the device exists, Docker will not
      // remove the container it borrows its network namespace from.
      if (gateway) {
        await gateway.remove();
      }
    };

    try {
      await context.log.info('Starting ephemeral Android container', {
        container: name,
        image: config.image,
        sessionVolume: volume,
        egressGateway: gateway?.name,
      });

      await this.docker.run(
        {
          image: config.image,
          name,
          labels: {
            [OWNER_LABEL]: OWNER_VALUE,
            [JOB_LABEL]: context.jobId,
            [ACCOUNT_LABEL]: context.accountId,
            [ROLE_LABEL]: DEVICE_ROLE,
            [CREATED_AT_LABEL]: new Date().toISOString(),
          },
          privileged: true,
          network: gateway?.networkMode ?? config.network,
          memoryLimit: config.memoryLimit,
          publishContainerPort: publishesPort && !gateway ? 5555 : undefined,
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

      serial = await this.resolveSerial(networkHost, context);
      const device = await this.waitUntilUsable(serial, name, gateway, context);

      // Both of these run before the app is touched, and in this order: pin the
      // namespace while nothing is using the network, then prove the pin worked.
      // Doing it after `ensurePackageInstalled` would mean downloading an APK
      // through a route that may not be the proxy's.
      if (gateway && proxy) {
        await this.pinEgress(gateway, proxy, device, context);
      }

      await ensurePackageInstalled(device, context);

      await context.log.info('Android container ready', { container: name, serial });

      return { device, serial, release };
    } catch (error) {
      // Read the logs before tearing anything down. Doing this after release()
      // means every failure report says "No such container" instead of showing
      // why the container was unhappy — the diagnostic destroyed by the cleanup
      // it was meant to explain.
      const enriched = await this.enrich(error, name, gateway);

      // Acquisition failed, so nobody downstream will ever call release().
      await release();
      throw enriched;
    }
  }

  /**
   * Makes the device use the gateway, and then proves that it does.
   *
   * Deliberately two steps rather than one. Applying the rules is a statement
   * about what the worker asked for; the check is the only evidence about what
   * Android actually did with them — and Android's routing is exactly the thing
   * that cannot be taken on trust here.
   */
  private async pinEgress(
    gateway: RunningGateway,
    proxy: ProxyRuntimeConfig,
    device: AndroidDevice,
    context: AcquireContext,
  ): Promise<void> {
    const { proxyGateway } = this.options.config;

    if (proxyGateway.harden) {
      // Resolved out here, where a failure can be reported, rather than inside
      // the gateway's shell. The ACL opens these addresses so that the gateway
      // can reach its own proxy without depending on a kernel module.
      const proxyEndpoints = await resolveProxyEndpoints(proxy, this.options.lookupHost);

      if (proxyEndpoints.length === 0) {
        await context.log.warn(
          'Could not resolve the proxy host, so the firewall can only recognise the gateway’s ' +
            'traffic by its fwmark. On a kernel without xt_mark the run will fail the egress check.',
          { host: proxy.host },
        );
      }

      await applyEgressPolicy({
        docker: this.docker,
        gatewayName: gateway.name,
        policy: policyFromEnv({
          env: proxyGateway.env,
          controlSubnets: gateway.controlSubnets,
          proxyEndpoints,
        }),
        log: context.log,
        signal: context.signal,
      });
    }

    if (!proxyGateway.egressCheck.enabled) {
      await context.log.warn('Egress check disabled; nothing has verified where this device exits');
      return;
    }

    if (proxyGateway.egressCheck.probeBinary) {
      await ensureProbeBinary(device, proxyGateway.egressCheck.probeBinary, context.log, context.signal);
    }

    // Resolved here so the device never has to: DNS is UDP and does not survive
    // a SOCKS5 proxy with no UDP ASSOCIATE. An endpoint already written as an
    // address needs nothing.
    const checkHost = egressCheckHost(proxyGateway.egressCheck.url);
    const resolved = checkHost
      ? await resolveProxyEndpoints({ host: checkHost, port: 80 }, this.options.lookupHost)
      : [];

    await assertProxiedEgress({
      device,
      docker: this.docker,
      gatewayName: gateway.name,
      url: proxyGateway.egressCheck.url,
      timeoutSeconds: proxyGateway.egressCheck.timeoutSeconds,
      resolveDirectIp: this.options.resolveDirectIp,
      resolvedAddress: resolved[0]?.address ?? null,
      log: context.log,
      signal: context.signal,
    });
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

  /**
   * `host` is the container that owns the network stack: the device normally,
   * its gateway when there is one. Addressing the device by name in that case
   * would resolve to nothing — a container in another's namespace has no
   * network alias of its own.
   */
  private async resolveSerial(host: string, context: AcquireContext): Promise<string> {
    const { config } = this.options;
    const name = host;

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
  private async waitUntilUsable(
    serial: string,
    name: string,
    gateway: RunningGateway | null,
    context: AcquireContext,
  ): Promise<AndroidDevice> {
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

      // Checked separately because it fails differently: the device keeps
      // running with a network namespace that no longer has a route out, so
      // ADB times out and every explanation points at Android.
      if (gateway && !(await this.docker.isRunning(gateway.name, { signal: context.signal }))) {
        throw new Error(
          `The egress gateway ${gateway.name} stopped while waiting for ADB, so the device has no network`,
        );
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

  /**
   * Container logs are the only explanation when ReDroid refuses to boot. The
   * gateway's are included whenever there is one: with the device inside its
   * namespace, half the ways a run can fail are visible only over there.
   */
  private async enrich(error: unknown, name: string, gateway: RunningGateway | null): Promise<unknown> {
    const message = error instanceof Error ? error.message : String(error);

    const sections = await Promise.all(
      [name, gateway?.name]
        .filter((container): container is string => Boolean(container))
        .map(async (container) => {
          const logs = await this.docker.logs(container, 40).catch(() => '');
          return logs ? `--- last lines of ${container} ---\n${logs}` : '';
        }),
    );

    const detail = sections.filter(Boolean).join('\n');

    if (!detail) {
      return error;
    }

    return new Error(`${message}\n${detail}`, { cause: error });
  }
}
