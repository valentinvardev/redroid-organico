import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_LABEL,
  CAMERA_LABEL,
  CAMERA_ROLE,
  CREATED_AT_LABEL,
  DEVICE_ROLE,
  GATEWAY_ROLE,
  JOB_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  ROLE_LABEL,
} from '@/lib/android/docker';
import { EmulatorDeviceProvider, emulatorConfigSchema } from '@/lib/android/emulatorProvider';
import { deviceMapping, hostDevicePath, type CameraSlot } from '@/lib/android/cameraSlots';
import { cameraStreamName } from '@/lib/android/cameraBridge';
import type { AcquireContext } from '@/lib/android/deviceProvider';
import type { ProxyRuntimeConfig } from '@/lib/proxy/config';
import { FakeDocker } from '../helpers/fakeDocker';
import { FakeDevice, type FakeDeviceOptions } from '../helpers/fakeAppium';

const silentLog = {
  debug: async () => undefined,
  info: async () => undefined,
  warn: async () => undefined,
  error: async () => undefined,
} as unknown as AcquireContext['log'];

function context(overrides: Partial<AcquireContext> = {}): AcquireContext {
  return {
    jobId: 'job-1',
    accountId: 'account-1',
    packageName: 'com.sportreels.app',
    log: silentLog,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Records whether the lease was handed back, which teardown has to guarantee. */
function fakeSlot(index = 10) {
  const state = { released: false, leasedFor: null as string | null };

  const acquireCamera = async (jobId: string): Promise<CameraSlot> => {
    state.leasedFor = jobId;

    return {
      index,
      hostDevice: hostDevicePath(index),
      mapping: deviceMapping(index),
      release: async () => {
        state.released = true;
      },
    };
  };

  return { state, acquireCamera };
}

function provider(
  options: {
    docker?: FakeDocker;
    device?: FakeDeviceOptions;
    config?: Record<string, unknown>;
    proxy?: ProxyRuntimeConfig | null;
    withCamera?: boolean;
    acquireCamera?: (jobId: string) => Promise<CameraSlot>;
    awaitPublisher?: (jobId: string, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const docker = options.docker ?? new FakeDocker();
  const device = new FakeDevice(options.device ?? {});
  const connects: string[] = [];
  const disconnects: string[] = [];

  const subject = new EmulatorDeviceProvider({
    config: emulatorConfigSchema.parse({
      image: 'sportreels/emulator:34',
      startTimeoutSeconds: 2,
      // Zero everywhere a real deployment watches a container settle, so the
      // suite does not spend seconds of wall clock proving nothing crashed.
      proxyGateway: { settleMs: 0 },
      ...(options.withCamera === false
        ? {}
        : { camera: { bridge: { settleMs: 0 } } }),
      ...options.config,
    }),
    proxy: options.proxy,
    adbCommand: 'adb',
    adbServer: { host: 'appium', port: 5037 },
    bootTimeoutSeconds: 1,
    docker,
    connect: async (serial) => {
      connects.push(serial);
    },
    disconnect: async (serial) => {
      disconnects.push(serial);
    },
    createDevice: () => device,
    resolveDirectIp: async () => '198.51.100.1',
    lookupHost: async () => ['78.143.233.210'],
    acquireCamera: options.acquireCamera,
    // Granted immediately unless a test says otherwise; the real one polls a
    // media server that does not exist here.
    awaitPublisher: options.awaitPublisher ?? (async () => undefined),
  });

  return { subject, docker, device, connects, disconnects };
}

describe('EmulatorDeviceProvider', () => {
  it('lends the host camera as the container’s only video device, and says so in a label', async () => {
    const { state, acquireCamera } = fakeSlot(12);
    const { subject, docker, connects } = provider({ acquireCamera });

    const acquired = await subject.acquire(context());

    const spec = docker.runs.find((run) => run.name === 'emulator-job-job-1');
    assert.ok(spec, 'the emulator container should have been created');

    assert.equal(spec.labels[OWNER_LABEL], OWNER_VALUE);
    assert.equal(spec.labels[JOB_LABEL], 'job-1');
    assert.equal(spec.labels[ACCOUNT_LABEL], 'account-1');
    assert.equal(spec.labels[ROLE_LABEL], DEVICE_ROLE);
    assert.ok(spec.labels[CREATED_AT_LABEL], 'the reaper needs a creation timestamp');

    // The whole point of the label: it is what lets the reaper decide whether a
    // camera lease is still accounted for, with nothing but `docker ps`.
    assert.equal(spec.labels[CAMERA_LABEL], '12');

    // KVM, or the emulator falls back to TCG and every timeout here is wrong.
    // The camera is mapped onto video0 so the AVD never learns its host index.
    assert.deepEqual(spec.devices, ['/dev/kvm', '/dev/video12:/dev/video0']);

    // Not ReDroid's /data: the artefact that carries a login here is the AVD's
    // userdata image, and the two are not interchangeable.
    assert.deepEqual(spec.volumes, [{ source: 'emulator-session-account-1', target: '/avd' }]);
    assert.ok(docker.volumes.has('emulator-session-account-1'));

    assert.ok(spec.command?.includes('-camera-front'), `expected a camera in ${spec.command?.join(' ')}`);
    assert.ok(spec.command?.includes('webcam0'), 'the lent device is always webcam0 inside the container');

    assert.match(acquired.serial ?? '', /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(connects, [acquired.serial]);
    assert.equal(state.leasedFor, 'job-1');

    await acquired.release();
    assert.equal(state.released, true, 'teardown must hand the camera back');
  });

  it('starts a bridge that feeds the device, labelled for the reaper', async () => {
    const { acquireCamera } = fakeSlot(11);
    const { subject, docker } = provider({ acquireCamera });

    const acquired = await subject.acquire(context());

    const bridge = docker.runs.find((run) => run.name === 'redroid-cam-job-1');
    assert.ok(bridge, 'a camera bridge should have been started');

    assert.equal(bridge.labels[ROLE_LABEL], CAMERA_ROLE);
    assert.equal(bridge.labels[CAMERA_LABEL], '11');
    assert.equal(bridge.labels[JOB_LABEL], 'job-1');
    assert.deepEqual(bridge.devices, ['/dev/video11:/dev/video0']);

    const command = bridge.command?.join(' ') ?? '';

    // yuyv422 rather than yuv420p: v4l2loopback advertises whatever was last
    // written to it, and the emulator declines to list a device offering a
    // format it does not want.
    assert.match(command, /-pix_fmt yuyv422/);
    assert.match(command, /-f v4l2 \/dev\/video0$/);
    assert.ok(command.includes(cameraStreamName('job-1')), 'the bridge reads this job’s stream');

    await acquired.release();
  });

  it('asks whether a camera is being published before leasing or starting anything', async () => {
    const { state, acquireCamera } = fakeSlot();
    const order: string[] = [];
    const docker = new FakeDocker();

    const { subject } = provider({
      docker,
      acquireCamera: async (jobId) => {
        order.push('lease');
        return acquireCamera(jobId);
      },
      awaitPublisher: async () => {
        order.push('await-publisher');
      },
    });

    const acquired = await subject.acquire(context());

    assert.deepEqual(
      order,
      ['await-publisher', 'lease'],
      'a person who never grants their camera should cost one poll, not a booted emulator',
    );
    assert.equal(state.leasedFor, 'job-1');

    await acquired.release();
  });

  it('leases nothing and starts nothing when the operator never grants a camera', async () => {
    const { state, acquireCamera } = fakeSlot();
    const docker = new FakeDocker();

    const { subject } = provider({
      docker,
      acquireCamera,
      awaitPublisher: async () => {
        throw new Error('Nothing published a camera to cam-job-1 within 120s');
      },
    });

    await assert.rejects(subject.acquire(context()), /Nothing published a camera/);

    assert.equal(state.leasedFor, null, 'no device should have been leased');
    assert.equal(state.released, false, 'nothing to hand back');
    assert.deepEqual(docker.runs, [], 'no container should have been created');
  });

  it('hands the camera back when the device fails to come up', async () => {
    const { state, acquireCamera } = fakeSlot();
    // The emulator container dies on startup, the way it does with no /dev/kvm.
    const docker = new FakeDocker({ exitsImmediatelyByName: ['emulator-job-job-1'] });
    const { subject } = provider({ docker, acquireCamera });

    // Matched, not merely rejected: an unconstrained assertion here would pass
    // on a TypeError from the test's own setup and prove nothing.
    await assert.rejects(subject.acquire(context()), /stopped while waiting for ADB/);

    assert.equal(state.released, true, 'a failed acquire must not leak the camera');
    assert.ok(
      docker.removed.includes('redroid-cam-job-1'),
      'the bridge holds the video device open and has to go too',
    );
  });

  it('tears down in an order that cannot strand a device or a namespace', async () => {
    const { state, acquireCamera } = fakeSlot();
    const proxy: ProxyRuntimeConfig = {
      type: 'SOCKS5',
      host: 'gate.example.com',
      port: 1080,
      username: 'user',
      password: 'hunter2',
    };

    const { subject, docker } = provider({ acquireCamera, proxy });

    const acquired = await subject.acquire(context());
    await acquired.release();

    const removals = docker.removed.filter((name) =>
      ['emulator-job-job-1', 'redroid-cam-job-1', 'redroid-gw-job-1'].includes(name),
    );

    // Device first — Docker refuses to remove a container whose network
    // namespace another is borrowing. Then the bridge, which was holding the
    // video device open. The gateway last, for the same namespace reason.
    assert.deepEqual(removals, ['emulator-job-job-1', 'redroid-cam-job-1', 'redroid-gw-job-1']);
    assert.equal(state.released, true);
  });

  it('puts the device inside the gateway’s namespace, exactly as ReDroid does', async () => {
    const { acquireCamera } = fakeSlot();
    const proxy: ProxyRuntimeConfig = {
      type: 'SOCKS5',
      host: 'gate.example.com',
      port: 1080,
      username: 'user',
      password: 'hunter2',
    };

    const { subject, docker } = provider({ acquireCamera, proxy });
    const acquired = await subject.acquire(context());

    const gateway = docker.runs.find((run) => run.name === 'redroid-gw-job-1');
    const emulator = docker.runs.find((run) => run.name === 'emulator-job-job-1');

    assert.ok(gateway, 'a proxied account gets a gateway');
    assert.equal(gateway.labels[ROLE_LABEL], GATEWAY_ROLE);

    // The device owns no network identity: no published port, no name to
    // resolve. This is what makes the proxy unbypassable from inside Android.
    assert.equal(emulator?.network, 'container:redroid-gw-job-1');
    assert.equal(emulator?.publishContainerPort, undefined);
    assert.equal(gateway.publishContainerPort, 5555);

    // The bridge stays outside: it is a local feed into a kernel device, not
    // traffic belonging to the account.
    const bridge = docker.runs.find((run) => run.name === 'redroid-cam-job-1');
    assert.notEqual(bridge?.network, 'container:redroid-gw-job-1');

    await acquired.release();
  });

  it('boots with the exit’s time zone instead of relying on setprop, which a rootless image refuses', async () => {
    const proxy: ProxyRuntimeConfig = {
      type: 'SOCKS5',
      host: 'gate.example.com',
      port: 1080,
      timezone: 'America/Chicago',
    };

    const { subject, docker } = provider({ acquireCamera: fakeSlot().acquireCamera, proxy });
    const acquired = await subject.acquire(context());

    const command = docker.runs.find((run) => run.name === 'emulator-job-job-1')?.command ?? [];
    const flag = command.indexOf('-timezone');

    assert.notEqual(flag, -1, `expected -timezone in ${command.join(' ')}`);
    assert.equal(command[flag + 1], 'America/Chicago');

    await acquired.release();
  });

  it('runs a plain AVD with no camera, bridge or lease when none is configured', async () => {
    const { state, acquireCamera } = fakeSlot();
    const { subject, docker } = provider({ withCamera: false, acquireCamera });

    const acquired = await subject.acquire(context());

    const spec = docker.runs.find((run) => run.name === 'emulator-job-job-1');
    assert.deepEqual(spec?.devices, ['/dev/kvm'], 'no camera means no video device');
    assert.equal(spec?.labels[CAMERA_LABEL], undefined);
    assert.equal(state.leasedFor, null);
    assert.equal(
      docker.runs.find((run) => run.name === 'redroid-cam-job-1'),
      undefined,
      'no bridge without a camera',
    );

    assert.ok(spec?.command?.includes('-camera-front'));
    assert.ok(spec?.command?.includes('none'));

    await acquired.release();
  });

  it('refuses a second run for an account, which would corrupt the shared session volume', async () => {
    const docker = new FakeDocker();
    docker.seedOrphan('emulator-job-other', {
      [OWNER_LABEL]: OWNER_VALUE,
      [ACCOUNT_LABEL]: 'account-1',
      [JOB_LABEL]: 'job-other',
    });

    const { subject } = provider({ docker });

    await assert.rejects(subject.acquire(context()), /already has a container running/);
  });
});

describe('camera slots', () => {
  it('always maps the leased host device onto video0', () => {
    // The pool lives on the host; inside the namespace there is exactly one
    // video device, so the AVD can be built once against webcam0.
    assert.equal(deviceMapping(10), '/dev/video10:/dev/video0');
    assert.equal(deviceMapping(37), '/dev/video37:/dev/video0');
    assert.equal(hostDevicePath(10), '/dev/video10');
  });
});
