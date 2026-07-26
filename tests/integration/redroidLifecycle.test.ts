import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_LABEL,
  CREATED_AT_LABEL,
  DEVICE_ROLE,
  GATEWAY_ROLE,
  JOB_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  ROLE_LABEL,
} from '@/lib/android/docker';
import { EphemeralRedroidProvider, redroidConfigSchema } from '@/lib/android/redroidProvider';
import { reapAndroidContainers } from '@/lib/android/reaper';
import { JobStatus } from '@prisma/client';
import type { AcquireContext } from '@/lib/android/deviceProvider';
import type { ProxyRuntimeConfig } from '@/lib/proxy/config';
import { FakeDocker, type FakeDockerOptions } from '../helpers/fakeDocker';
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

function provider(
  options: {
    docker?: FakeDocker;
    device?: FakeDeviceOptions;
    config?: Record<string, unknown>;
    proxy?: ProxyRuntimeConfig | null;
  } = {},
) {
  const docker = options.docker ?? new FakeDocker();
  const device = new FakeDevice(options.device ?? {});
  const connects: string[] = [];
  const disconnects: string[] = [];

  const subject = new EphemeralRedroidProvider({
    config: redroidConfigSchema.parse({
      image: 'sportreels/redroid:11',
      startTimeoutSeconds: 2,
      // Zero, so the gateway's startup watch does not add two seconds of real
      // time to every test that uses one.
      proxyGateway: { settleMs: 0 },
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
  });

  return { subject, docker, device, connects, disconnects };
}

describe('EphemeralRedroidProvider', () => {
  it('labels the container so the reaper can find it, and isolates session state per account', async () => {
    const { subject, docker, connects } = provider();

    const acquired = await subject.acquire(context());

    const spec = docker.runs[0];
    assert.equal(spec.name, 'redroid-job-job-1');
    assert.equal(spec.labels[OWNER_LABEL], OWNER_VALUE);
    assert.equal(spec.labels[JOB_LABEL], 'job-1');
    assert.equal(spec.labels[ACCOUNT_LABEL], 'account-1');
    assert.ok(spec.labels[CREATED_AT_LABEL], 'the reaper needs a creation timestamp');
    assert.equal(spec.privileged, true, 'ReDroid needs binder/ashmem from the host kernel');

    // The session volume is per account, so two accounts can never read each
    // other's logged-in state. binderfs comes from the host: modern kernels
    // create no static /dev/binder, so without this the container cannot boot.
    assert.deepEqual(spec.volumes, [
      { source: 'redroid-session-account-1', target: '/data' },
      { source: '/dev/binderfs', target: '/dev/binderfs' },
    ]);
    assert.ok(docker.volumes.has('redroid-session-account-1'));

    // Kernels without ashmem hang mid-boot unless memfd is requested.
    assert.ok(
      spec.command?.includes('androidboot.use_memfd=1'),
      `expected use_memfd in ${spec.command?.join(' ')}`,
    );

    // Docker allocated the host port; the serial is derived from it, not guessed.
    assert.match(acquired.serial ?? '', /^127\.0\.0\.1:\d+$/);
    assert.deepEqual(connects, [acquired.serial]);

    await acquired.release();
    assert.deepEqual(docker.removed, ['redroid-job-job-1']);
  });

  it('waits for the published port instead of reading it too early', async () => {
    const docker = new FakeDocker({ portAppearsAfter: 3 });
    const { subject } = provider({ docker });

    const acquired = await subject.acquire(context());

    assert.match(acquired.serial ?? '', /^127\.0\.0\.1:\d+$/);
    await acquired.release();
  });

  it('addresses the container by name when told to use container networking', async () => {
    const { subject, docker } = provider({ config: { connectVia: 'container-name', network: 'redroid-net' } });

    const acquired = await subject.acquire(context());

    assert.equal(acquired.serial, 'redroid-job-job-1:5555');
    assert.equal(docker.runs[0].publishContainerPort, undefined, 'no port needs publishing on a shared network');
    assert.equal(docker.runs[0].network, 'redroid-net');

    await acquired.release();
  });

  it('destroys the container when the device never becomes usable', async () => {
    // The container starts but Android never finishes booting.
    const { subject, docker } = provider({ device: { bootsWithin: false } });

    await assert.rejects(subject.acquire(context()));

    // Nobody downstream will call release() for a failed acquisition, so the
    // provider has to clean up after itself or the instance leaks.
    assert.deepEqual(docker.removed, ['redroid-job-job-1']);
    assert.equal(docker.containers.size, 0, 'no container may survive a failed acquisition');
  });

  it('destroys the container when the app is missing and no APK was configured', async () => {
    const { subject, docker } = provider({ device: { packageInstalled: false } });

    await assert.rejects(subject.acquire(context()), /not installed on the device/);
    assert.equal(docker.containers.size, 0);
  });

  it('installs the APK when the device does not have the app yet', async () => {
    // The normal path on a fresh session volume: a ReDroid image cannot carry
    // a user app, so the first run of every account installs it.
    const { subject, device } = provider({ device: { packageInstalled: false } });

    const acquired = await subject.acquire(context({ apkPath: '/srv/apks/sportreels.apk' }));

    assert.deepEqual(device.installed, ['/srv/apks/sportreels.apk']);
    await acquired.release();
  });

  it('does not reinstall when the app is already on the device', async () => {
    const { subject, device } = provider();

    const acquired = await subject.acquire(context({ apkPath: '/srv/apks/sportreels.apk' }));

    assert.deepEqual(device.installed, [], 'a persistent volume keeps the install across runs');
    await acquired.release();
  });

  it('destroys the container when the install itself fails', async () => {
    const { subject, docker } = provider({ device: { packageInstalled: false, installFails: true } });

    await assert.rejects(subject.acquire(context({ apkPath: '/srv/apks/broken.apk' })), /INSTALL_FAILED/);
    assert.equal(docker.containers.size, 0, 'a failed install must not strand the container');
  });

  it('reports the container logs when it exits before ADB is up', async () => {
    const docker = new FakeDocker({ exitsImmediately: true });
    const { subject } = provider({ docker });

    await assert.rejects(subject.acquire(context()), /fake container logs/);
    assert.equal(docker.containers.size, 0);
  });

  it('refuses a second concurrent container for the same account', async () => {
    const docker = new FakeDocker();
    const { subject } = provider({ docker });

    const first = await subject.acquire(context({ jobId: 'job-1' }));

    const second = provider({ docker });
    await assert.rejects(
      second.subject.acquire(context({ jobId: 'job-2' })),
      /already has a container running/,
      'two jobs sharing one session volume would corrupt it',
    );

    await first.release();
  });

  it('clears a container left over from a previous attempt at the same job', async () => {
    const docker = new FakeDocker();
    docker.seedOrphan('redroid-job-job-1', {
      [OWNER_LABEL]: OWNER_VALUE,
      [JOB_LABEL]: 'job-1',
      [ACCOUNT_LABEL]: 'account-1',
    });

    const { subject } = provider({ docker });
    const acquired = await subject.acquire(context());

    assert.ok(acquired.serial);
    await acquired.release();
  });

  it('does not let a wedged docker rm turn into a failed release', async () => {
    const docker = new FakeDocker();
    const { subject } = provider({ docker });

    const acquired = await subject.acquire(context());
    (docker as unknown as { options: FakeDockerOptions }).options.failRemove = new Error('daemon is wedged');

    // Release must resolve regardless; the reaper is the backstop.
    await acquired.release();
  });
});

describe('EphemeralRedroidProvider with a proxy', () => {
  const proxy: ProxyRuntimeConfig = {
    type: 'SOCKS5',
    host: 'gate.example.com',
    port: 1080,
    username: 'user',
    password: 'hunter2',
  };

  it('puts the device inside the gateway namespace and publishes ADB on the gateway', async () => {
    const { subject, docker } = provider({ proxy, config: { network: 'redroid-net' } });

    const acquired = await subject.acquire(context());

    const [gateway, device] = docker.runs;

    // Order matters: there is nothing for the device to join otherwise.
    assert.equal(gateway.name, 'redroid-gw-job-1');
    assert.equal(device.name, 'redroid-job-job-1');

    assert.deepEqual(gateway.capAdd, ['NET_ADMIN']);
    assert.deepEqual(gateway.devices, ['/dev/net/tun']);
    assert.equal(gateway.env?.PROXY, 'socks5://user:hunter2@gate.example.com:1080');
    assert.equal(gateway.labels[ROLE_LABEL], GATEWAY_ROLE);
    assert.equal(gateway.labels[JOB_LABEL], 'job-1', 'the reaper collects gateways too');
    assert.equal(gateway.network, 'redroid-net');

    // The device has no network identity of its own, so it can neither join a
    // network nor publish a port: both belong to the gateway.
    assert.equal(device.network, 'container:redroid-gw-job-1');
    assert.equal(device.publishContainerPort, undefined);
    assert.equal(gateway.publishContainerPort, 5555);
    assert.equal(device.labels[ROLE_LABEL], DEVICE_ROLE);

    // And the serial is therefore the gateway's published port, not the
    // device's — the device does not have one.
    assert.match(acquired.serial ?? '', /^127\.0\.0\.1:\d+$/);

    await acquired.release();
  });

  it('addresses the gateway by name when the worker shares a Docker network', async () => {
    const { subject } = provider({
      proxy,
      config: { connectVia: 'container-name', network: 'redroid-net' },
    });

    const acquired = await subject.acquire(context());

    // The device's own name resolves to nothing: a container in another's
    // namespace has no network alias.
    assert.equal(acquired.serial, 'redroid-gw-job-1:5555');

    await acquired.release();
  });

  it('removes the device before the gateway it borrows the namespace from', async () => {
    const { subject, docker } = provider({ proxy });

    const acquired = await subject.acquire(context());
    await acquired.release();

    assert.deepEqual(docker.removed, ['redroid-job-job-1', 'redroid-gw-job-1']);
    assert.equal(docker.containers.size, 0, 'neither container may survive a release');
  });

  it('fails the job when the gateway dies on startup instead of running without it', async () => {
    // tun2socks exits like this on a proxy URL it cannot parse. Continuing
    // would publish from the host's own address, which is the one outcome an
    // assigned proxy exists to prevent.
    const docker = new FakeDocker({ exitsImmediatelyByName: ['redroid-gw-job-1'] });
    const { subject } = provider({ docker, proxy });

    await assert.rejects(subject.acquire(context()), /exited on startup[\s\S]*fake container logs/);

    assert.equal(docker.containers.size, 0, 'a failed gateway must not be left behind');
    assert.equal(
      docker.runs.some((spec) => spec.name === 'redroid-job-job-1'),
      false,
      'no Android container may start without its egress',
    );
  });

  it('tears the gateway down when the device never becomes usable', async () => {
    const { subject, docker } = provider({ proxy, device: { bootsWithin: false } });

    await assert.rejects(subject.acquire(context()));

    assert.deepEqual(docker.removed, ['redroid-job-job-1', 'redroid-gw-job-1']);
    assert.equal(docker.containers.size, 0);
  });

  it('starts no gateway at all for an account without a proxy', async () => {
    const { subject, docker } = provider();

    const acquired = await subject.acquire(context());

    assert.equal(docker.runs.length, 1, 'the gateway is only for accounts that have a proxy');
    assert.equal(docker.runs[0].name, 'redroid-job-job-1');
    assert.equal(docker.runs[0].capAdd, undefined);

    await acquired.release();
  });
});

describe('Android container reaper', () => {
  function orphan(docker: FakeDocker, name: string, jobId: string, ageMs: number) {
    docker.seedOrphan(name, {
      [OWNER_LABEL]: OWNER_VALUE,
      [JOB_LABEL]: jobId,
      [ACCOUNT_LABEL]: 'account-1',
      [CREATED_AT_LABEL]: new Date(Date.now() - ageMs).toISOString(),
    });
  }

  it('removes containers whose job is no longer running', async () => {
    const docker = new FakeDocker();
    orphan(docker, 'redroid-job-dead', 'job-dead', 10 * 60_000);

    const result = await reapAndroidContainers({
      docker,
      isJobActive: async () => false,
      log: () => undefined,
    });

    assert.deepEqual(result.removed, ['redroid-job-dead']);
    assert.equal(docker.containers.size, 0);
  });

  it('leaves alone a container whose job is waiting for a person', async () => {
    // The regression this guards: the sweep used to treat anything other than
    // PROCESSING as garbage, so an onboarding container was destroyed about
    // ninety seconds into the operator's login.
    for (const status of [JobStatus.AWAITING_HUMAN, JobStatus.VERIFYING]) {
      const docker = new FakeDocker();
      orphan(docker, `redroid-job-${status}`, `job-${status}`, 10 * 60_000);

      const result = await reapAndroidContainers({
        docker,
        isJobActive: async () => [JobStatus.PROCESSING, JobStatus.AWAITING_HUMAN, JobStatus.VERIFYING].includes(status),
        log: () => undefined,
      });

      assert.deepEqual(result.removed, [], `a ${status} job still holds its device`);
      assert.equal(docker.containers.size, 1);
    }
  });

  it('leaves alone a container whose job is still processing', async () => {
    const docker = new FakeDocker();
    orphan(docker, 'redroid-job-live', 'job-live', 10 * 60_000);

    const result = await reapAndroidContainers({
      docker,
      isJobActive: async () => true,
      log: () => undefined,
    });

    assert.deepEqual(result.removed, []);
    assert.equal(docker.containers.size, 1);
  });

  it('honours the grace period so a container is never killed as it starts up', async () => {
    const docker = new FakeDocker();
    orphan(docker, 'redroid-job-new', 'job-new', 1_000);

    const result = await reapAndroidContainers({
      docker,
      graceMs: 90_000,
      // Even though the job does not look active yet, the container is too
      // young to judge: acquire() runs before the row flips to PROCESSING.
      isJobActive: async () => false,
      log: () => undefined,
    });

    assert.deepEqual(result.removed, []);
    assert.equal(docker.containers.size, 1);
  });

  it('ignores containers that do not belong to this system', async () => {
    const docker = new FakeDocker();
    docker.seedOrphan('someone-elses-postgres', { 'com.example.other': 'yes' });

    const result = await reapAndroidContainers({ docker, isJobActive: async () => false, log: () => undefined });

    assert.equal(result.inspected, 0);
    assert.equal(docker.containers.size, 1, 'only our own labelled containers are ever touched');
  });

  it('keeps a container it cannot make a decision about, and reports why', async () => {
    const docker = new FakeDocker();
    orphan(docker, 'redroid-job-unknown', 'job-unknown', 10 * 60_000);

    const result = await reapAndroidContainers({
      docker,
      isJobActive: async () => {
        throw new Error('database is down');
      },
      log: () => undefined,
    });

    assert.deepEqual(result.removed, []);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /database is down/);
    assert.equal(docker.containers.size, 1, 'killing a possibly-live run is worse than leaking one container');
  });

  it('collects a device before the gateway it borrows the namespace from', async () => {
    // In list order the gateway comes first, and removing it would be refused
    // for as long as the device exists — leaving a gateway behind on every
    // sweep, forever.
    const docker = new FakeDocker();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();

    docker.seedOrphan('redroid-gw-job-dead', {
      [OWNER_LABEL]: OWNER_VALUE,
      [JOB_LABEL]: 'job-dead',
      [ROLE_LABEL]: GATEWAY_ROLE,
      [CREATED_AT_LABEL]: stale,
    });

    docker.seedOrphan(
      'redroid-job-job-dead',
      {
        [OWNER_LABEL]: OWNER_VALUE,
        [JOB_LABEL]: 'job-dead',
        [ROLE_LABEL]: DEVICE_ROLE,
        [CREATED_AT_LABEL]: stale,
      },
      'container:redroid-gw-job-dead',
    );

    const result = await reapAndroidContainers({
      docker,
      isJobActive: async () => false,
      log: () => undefined,
    });

    assert.deepEqual(result.removed, ['redroid-job-job-dead', 'redroid-gw-job-dead']);
    assert.equal(docker.containers.size, 0);
    assert.deepEqual(result.failed, []);
  });

  it('never throws when the docker CLI is unusable', async () => {
    const broken = {
      listByLabel: async () => {
        throw new Error('docker: command not found');
      },
    } as unknown as FakeDocker;

    const result = await reapAndroidContainers({ docker: broken, log: () => undefined });

    assert.deepEqual(result, { inspected: 0, removed: [], failed: [] });
  });
});
