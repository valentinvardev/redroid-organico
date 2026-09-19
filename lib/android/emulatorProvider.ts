import { z } from 'zod';
import type { ProxyRuntimeConfig } from '@/lib/proxy/config';
import { adbConnect, adbDisconnect, type AdbTarget } from './adb';
import { AdbDevice, type AndroidDevice } from './device';
import {
  ACCOUNT_LABEL,
  CAMERA_LABEL,
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
import {
  cameraBridgeConfigSchema,
  startCameraBridge,
  waitForCameraPublisher,
  type RunningCameraBridge,
} from './cameraBridge';
import { acquireCameraSlot, type CameraSlot } from './cameraSlots';
import { applyEgressPolicy, policyFromEnv, resolveProxyEndpoints } from './egressPolicy';
import { assertProxiedEgress, egressCheckHost, ensureProbeBinary } from './egressCheck';
import { alignDeviceToEgress } from './devicePersona';
import {
  ensurePackageInstalled,
  type AcquireContext,
  type AcquiredDevice,
  type DeviceProvider,
} from './deviceProvider';

/**
 * The Android Emulator, in a container, for accounts that need a camera.
 *
 * ReDroid has no camera at all — upstream exposes no `androidboot.redroid_camera*`
 * and its images ship no HAL provider that enumerates V4L2, so passing
 * `--device /dev/video0` produces a device node Android never looks at. The
 * emulator reads a webcam in the *host* process, by ordinary userspace V4L2,
 * before Android is involved, which is why the same host device works here and
 * not there. It also presents the result as a normal front camera rather than
 * an external one.
 *
 * The cost is honest and permanent: an emulator is far easier to detect than
 * ReDroid — `ro.kernel.qemu`, goldfish devices, a generic build fingerprint, no
 * Play Integrity. And because the session volume is what onboarding produces,
 * and an AVD's is not portable to ReDroid, an account that onboards here stays
 * here. Choosing this provider is choosing it for that account's whole life.
 *
 * Containerising the emulator is not packaging convenience. It is what makes
 * the rest of the architecture keep working: the device still joins its egress
 * gateway's network namespace with `--network container:<gateway>`, exactly as
 * ReDroid does, and the camera it is lent is mapped to `/dev/video0` inside its
 * own namespace so the AVD never has to know which host slot it got.
 */

export const emulatorCameraSchema = z.object({
  /** How the operator's webcam reaches the host device. */
  bridge: cameraBridgeConfigSchema.prefault({}),

  /**
   * Passed to `-camera-front`. `webcam0` is the lent device, which inside this
   * container is the only one there is. `emulated` is the software-simulated
   * camera, useful for proving the app accepts an emulator before any of the
   * streaming machinery exists.
   */
  front: z.string().min(1).default('webcam0'),

  /** Off by default: a second camera is a second thing that can fail. */
  back: z.string().min(1).default('none'),
});

export const emulatorConfigSchema = z.object({
  /** Built from Dockerfile.emulator: SDK, system image and a prebuilt AVD. */
  image: z.string().min(1),

  /** Must match the AVD baked into the image. */
  avdName: z.string().min(1).default('onboarding'),

  /**
   * Named Docker volume holding the AVD directory, which is where the emulator
   * keeps userdata — and therefore the logged-in session. Defaults to one per
   * account so two accounts can never see each other's state.
   *
   * Note this is not ReDroid's `/data`: the artefact is the AVD's userdata
   * image, and the two are not interchangeable.
   */
  sessionVolume: z.string().min(1).optional(),

  /** Same meaning as ReDroid's; see lib/android/redroidProvider.ts. */
  connectVia: z.enum(['published-port', 'container-name']).default('published-port'),
  connectHost: z.string().min(1).default('127.0.0.1'),

  network: z.string().min(1).optional(),
  controlNetwork: z.string().min(1).optional(),

  /**
   * Where the camera bridge reaches the media server, and deliberately not the
   * network the device is on.
   *
   * Sharing one would let an automated device reach the media server and read
   * another job's webcam. Create it `internal: true` — see docker-compose.yml —
   * so the only things on it are bridges and the server they read from.
   */
  cameraNetwork: z.string().min(1).optional(),

  proxyGateway: proxyGatewayConfigSchema.prefault({}),

  /**
   * Hardware virtualisation. Without it QEMU falls back to TCG and an AVD takes
   * long enough to boot that every timeout here is wrong.
   *
   * On EC2 this needs either a bare metal instance or, since February 2026, a
   * virtual instance launched with `--cpu-options "NestedVirtualization=enabled"`
   * — available on the Intel families only (M7i/M8i, C7i/C8i, R7i/R8i, I7i, X8i).
   */
  kvmDevice: z.string().min(1).default('/dev/kvm'),

  /**
   * Public key of the adb server that will talk to this device, on the host.
   *
   * Not optional in practice. The system image is a `user` build, so the
   * device enforces adb authentication and only trusts keys the emulator
   * injected at boot — and the emulator injects whatever it finds in its own
   * container, which is a key nobody else has. Without this the device boots
   * perfectly, `adb connect` succeeds, and every command answers
   * `device unauthorized` until the job times out, with no dialog anywhere for
   * a person to accept.
   *
   * Extract it once from the shared adb server:
   *
   *   docker cp <adb-server>:/home/appuser/.android/adbkey.pub ./adbkey.pub
   */
  adbPublicKeyPath: z.string().min(1).optional(),

  /** Absent means a plain AVD with no camera and no bridge. */
  camera: emulatorCameraSchema.optional(),

  memoryLimit: z.string().min(1).default('6g'),
  width: z.number().int().positive().default(1080),
  height: z.number().int().positive().default(1920),
  dpi: z.number().int().positive().default(420),

  /** Extra `emulator` arguments, appended verbatim. */
  extraArgs: z.array(z.string()).default([]),

  /** Generous: a cold AVD boot is minutes, not the seconds ReDroid takes. */
  startTimeoutSeconds: z.number().int().positive().max(1_800).default(300),
});

export type EmulatorConfig = z.infer<typeof emulatorConfigSchema>;

export interface EmulatorProviderOptions {
  config: EmulatorConfig;
  proxy?: ProxyRuntimeConfig | null;
  adbCommand: string;
  adbServer?: AdbTarget;
  bootTimeoutSeconds: number;
  docker?: DockerClient;
  /** Test seams, matching EphemeralRedroidProvider's. */
  connect?: (serial: string, signal: AbortSignal) => Promise<void>;
  disconnect?: (serial: string) => Promise<void>;
  createDevice?: (serial: string) => AndroidDevice;
  resolveDirectIp?: () => Promise<string | null>;
  lookupHost?: (host: string) => Promise<string[]>;
  /**
   * Leases a host `/dev/videoN`. A seam so the lifecycle can be tested without
   * a Redis, the same way docker is.
   */
  acquireCamera?: (jobId: string) => Promise<CameraSlot>;
  /**
   * Blocks until the operator's browser is actually publishing. Starting an
   * emulator before then gives it a camera device with no frames in it, which
   * the app reads as a broken camera rather than as a missing operator.
   */
  awaitPublisher?: (jobId: string, signal: AbortSignal) => Promise<void>;
}

function containerName(jobId: string): string {
  return `emulator-job-${jobId}`.slice(0, 60);
}

function sessionVolumeName(config: EmulatorConfig, accountId: string): string {
  return config.sessionVolume ?? `emulator-session-${accountId}`;
}

function emulatorArgs(config: EmulatorConfig, proxy: ProxyRuntimeConfig | null | undefined): string[] {
  return [
    // Set at boot, not afterwards. The image is a `user` build with no root, so
    // the `setprop persist.sys.timezone` in lib/android/devicePersona.ts can be
    // refused from `shell` — it warns and carries on, which is right for ReDroid
    // but would leave an emulator's clock disagreeing with its exit. The
    // emulator can simply be told.
    ...(proxy?.timezone ? ['-timezone', proxy.timezone] : []),
    '-avd',
    config.avdName,
    '-skin',
    `${config.width}x${config.height}`,
    '-prop',
    `qemu.sf.lcd_density=${config.dpi}`,
    '-camera-front',
    config.camera?.front ?? 'none',
    '-camera-back',
    config.camera?.back ?? 'none',
    ...config.extraArgs,
  ];
}

export class EmulatorDeviceProvider implements DeviceProvider {
  readonly kind = 'emulator';
  private readonly docker: DockerClient;

  constructor(private readonly options: EmulatorProviderOptions) {
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

    await this.docker.remove(name).catch(() => undefined);

    let camera: CameraSlot | null = null;
    let bridge: RunningCameraBridge | null = null;
    let gateway: RunningGateway | null = null;

    let serial: string | undefined;
    let egressIp: string | undefined;

    const teardown = async () => {
      if (serial) {
        const disconnect =
          this.options.disconnect ??
          ((address: string) => adbDisconnect(this.options.adbCommand, this.options.adbServer, address));

        await disconnect(serial).catch(() => undefined);
      }

      try {
        await this.docker.remove(name);
        await context.log.info('Emulator container removed', { container: name });
      } catch (cause) {
        await context.log
          .warn('Could not remove the emulator container; the reaper will collect it', {
            container: name,
            error: cause instanceof Error ? cause.message : String(cause),
          })
          .catch(() => undefined);
      }

      // After the device, which was holding the camera open, and before the
      // lease is dropped — a slot freed while ffmpeg still owns the device
      // would be handed to a job that then cannot open it.
      if (bridge) {
        await bridge.remove();
      }

      if (camera) {
        await camera.release();
      }

      // Strictly last: while the device exists, Docker will not remove the
      // container it borrows its network namespace from.
      if (gateway) {
        await gateway.remove();
      }
    };

    try {
      if (config.camera) {
        // First, and before anything is leased or started: this is the only
        // step that can refuse cheaply. A person who never grants their camera
        // should cost one failed poll, not a booted emulator.
        const awaitPublisher = this.options.awaitPublisher ?? waitForCameraPublisher;

        await context.log.info('Waiting for the operator to grant their camera');
        await awaitPublisher(context.jobId, context.signal);

        const acquireCamera = this.options.acquireCamera ?? acquireCameraSlot;
        camera = await acquireCamera(context.jobId);

        await context.log.info('Leased a camera device', {
          cameraIndex: camera.index,
          hostDevice: camera.hostDevice,
        });

        bridge = await startCameraBridge({
          docker: this.docker,
          jobId: context.jobId,
          accountId: context.accountId,
          cameraIndex: camera.index,
          deviceMapping: camera.mapping,
          config: config.camera.bridge,
          network: config.cameraNetwork,
          log: context.log,
          signal: context.signal,
        });
      }

      // Started before the device, because the device is placed *inside* its
      // namespace and there is nothing to join otherwise.
      gateway = proxy
        ? await startProxyGateway({
            docker: this.docker,
            proxy,
            jobId: context.jobId,
            accountId: context.accountId,
            config: config.proxyGateway,
            network: config.network,
            controlNetwork: config.controlNetwork,
            publishContainerPort: publishesPort ? 5555 : undefined,
            log: context.log,
            signal: context.signal,
          })
        : null;

      const networkHost = gateway?.name ?? name;

      await context.log.info('Starting ephemeral emulator container', {
        container: name,
        image: config.image,
        avd: config.avdName,
        sessionVolume: volume,
        egressGateway: gateway?.name,
        cameraIndex: camera?.index,
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
            // Written here too, not only on the bridge: this is the record the
            // reaper reads to decide whether a lease is still accounted for.
            ...(camera ? { [CAMERA_LABEL]: String(camera.index) } : {}),
          },
          network: gateway?.networkMode ?? config.network,
          memoryLimit: config.memoryLimit,
          publishContainerPort: publishesPort && !gateway ? 5555 : undefined,
          devices: [config.kvmDevice, ...(camera ? [camera.mapping] : [])],
          volumes: [
            { source: volume, target: '/avd' },
            // Read-only, spelled into the target because the volume spec here
            // is a bare `source:target` join. The emulator reads this before
            // it boots and copies it into the device's authorised keys.
            ...(config.adbPublicKeyPath
              ? [{ source: config.adbPublicKeyPath, target: '/root/.android/adbkey.pub:ro' }]
              : []),
          ],
          command: emulatorArgs(config, proxy),
        },
        { signal: context.signal },
      );

      serial = await this.resolveSerial(networkHost, context);
      const device = await this.waitUntilUsable(serial, name, gateway, context);

      if (gateway && proxy) {
        egressIp = await this.pinEgress(gateway, proxy, device, context);
      }

      await ensurePackageInstalled(device, context);

      await context.log.info('Emulator ready', { container: name, serial, cameraIndex: camera?.index });

      return { device, serial, egressIp, release: teardown };
    } catch (error) {
      // Read the logs before tearing anything down, or every failure report
      // says "No such container" instead of showing why it was unhappy.
      const enriched = await this.enrich(error, name, gateway, bridge);

      await teardown();
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

  /**
   * `host` is the container that owns the network stack: the device normally,
   * its gateway when there is one.
   */
  private async resolveSerial(host: string, context: AcquireContext): Promise<string> {
    const { config } = this.options;

    if (config.connectVia === 'container-name') {
      return `${host}:5555`;
    }

    const deadline = Date.now() + config.startTimeoutSeconds * 1_000;

    while (Date.now() < deadline) {
      if (context.signal.aborted) {
        throw new Error('Cancelled while waiting for the emulator to publish its ADB port');
      }

      const port = await this.docker.hostPort(host, 5555, { signal: context.signal });

      if (port) {
        return `${config.connectHost}:${port}`;
      }

      if (!(await this.docker.isRunning(host, { signal: context.signal }))) {
        throw new Error(`Container ${host} exited before publishing its ADB port`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      `Container ${host} never published its ADB port within ${config.startTimeoutSeconds}s`,
    );
  }

  /**
   * Readiness in three gates: the container runs, ADB accepts a connection, and
   * Android has finished booting. An emulator fails the first gate in a way
   * ReDroid cannot — no KVM — so that is called out by name.
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
        throw new Error('Cancelled while connecting to the emulator');
      }

      if (!(await this.docker.isRunning(name, { signal: context.signal }))) {
        throw new Error(
          `Container ${name} stopped while waiting for ADB. An emulator exits on startup when ` +
            `${config.kvmDevice} is missing or unreadable, which on EC2 means the instance was ` +
            'not launched with nested virtualization enabled.',
        );
      }

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

    try {
      await device.waitUntilReady(bootTimeoutSeconds * 1_000, context.signal);
    } catch (error) {
      // The shape this failure takes when the key is missing is indistinguishable
      // from a slow boot: ADB connects, then every command answers `device
      // unauthorized` until the timeout. Naming the likely cause here costs
      // nothing and saves reading container logs that show a healthy Android.
      if (!config.adbPublicKeyPath) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n\n` +
            'This account has no `adbPublicKeyPath`. The system image is a user build, so the ' +
            'device only accepts adb clients whose key the emulator injected at boot — and ' +
            'nothing injected the shared adb server\'s. Extract it once with:\n' +
            '  docker cp <adb-server>:/home/appuser/.android/adbkey.pub ./adbkey.pub',
          { cause: error },
        );
      }

      throw error;
    }

    return device;
  }

  /**
   * Makes the device use the gateway, and then proves that it does. Identical
   * in intent to the ReDroid provider's: applying the rules says what the
   * worker asked for, and the check is the only evidence about what Android
   * did with them.
   */
  private async pinEgress(
    gateway: RunningGateway,
    proxy: ProxyRuntimeConfig,
    device: AndroidDevice,
    context: AcquireContext,
  ): Promise<string | undefined> {
    const { proxyGateway } = this.options.config;

    if (proxyGateway.harden) {
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

    await alignDeviceToEgress(device, proxy, context.log, context.signal);

    if (!proxyGateway.egressCheck.enabled) {
      await context.log.warn('Egress check disabled; nothing has verified where this device exits');
      return undefined;
    }

    if (proxyGateway.egressCheck.probeBinary) {
      await ensureProbeBinary(device, proxyGateway.egressCheck.probeBinary, context.log, context.signal);
    }

    const checkHost = egressCheckHost(proxyGateway.egressCheck.url);
    const resolved = checkHost
      ? await resolveProxyEndpoints({ host: checkHost, port: 80 }, this.options.lookupHost)
      : [];

    return assertProxiedEgress({
      device,
      docker: this.docker,
      gatewayName: gateway.name,
      url: proxyGateway.egressCheck.url,
      timeoutSeconds: proxyGateway.egressCheck.timeoutSeconds,
      resolveDirectIp: this.options.resolveDirectIp,
      resolvedAddress: resolved[0]?.address ?? null,
      probeBinary: proxyGateway.egressCheck.probeBinary ?? null,
      log: context.log,
      signal: context.signal,
    });
  }

  /**
   * Container logs are the only explanation when an emulator refuses to boot.
   * The bridge's are included because a camera that never produced a frame is
   * one of the ways the device comes up useless.
   */
  private async enrich(
    error: unknown,
    name: string,
    gateway: RunningGateway | null,
    bridge: RunningCameraBridge | null,
  ): Promise<unknown> {
    const message = error instanceof Error ? error.message : String(error);

    const sections = await Promise.all(
      [name, gateway?.name, bridge?.name]
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
