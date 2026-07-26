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
import { egressPolicyScript, policyFromEnv, resolveProxyEndpoints } from '@/lib/android/egressPolicy';
import { directEgressIp, resetDirectEgressCache } from '@/lib/android/egressCheck';
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
    /** What the worker's own address resolves to; null means "could not tell". */
    directIp?: string | null;
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
    // Never the real network: the check would otherwise make an outbound
    // request, and the policy a DNS query, from the test suite.
    resolveDirectIp: async () => (options.directIp === undefined ? '198.51.100.1' : options.directIp),
    lookupHost: async () => ['78.143.233.210'],
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

  it('pins the namespace only after Android has booted, and before the app is touched', async () => {
    // Order is the whole point: netd rewrites the routing tables while it
    // starts, so rules written at `docker run` time are gone by the time an app
    // opens a socket. And doing it after the APK install would mean installing
    // through a route nothing has checked.
    const { subject, docker, device } = provider({ proxy, config: { controlNetwork: 'redroid-control-net' } });

    const acquired = await subject.acquire(context({ apkPath: '/srv/apks/app.apk' }));

    const hardening = docker.execs.find((call) => call.command[0] === 'sh');
    assert.ok(hardening, 'the namespace was never hardened');

    assert.deepEqual(
      docker.events.slice(0, 4),
      ['run:redroid-gw-job-1', 'connect:redroid-control-net', 'run:redroid-job-job-1', 'exec:redroid-gw-job-1'],
      'gateway, control network, device, then hardening',
    );

    assert.ok(
      device.probes.length > 0,
      'the egress check has to run against the device, not against the gateway',
    );

    await acquired.release();
  });

  it('writes rules that beat netd on priority and fail closed', async () => {
    const { subject, docker } = provider({
      proxy,
      config: { controlNetwork: 'redroid-control-net' },
    });

    const acquired = await subject.acquire(context());
    const script = docker.execs.find((call) => call.command[0] === 'sh')?.command[2] ?? '';

    // Layer 1: below netd's band, which starts at 10000. The bypass has to come
    // first or the gateway's own connection to the proxy loops into the tun.
    assert.match(script, /ip rule add fwmark 0x22b lookup "\$BYPASS_TABLE" pref 90/);
    assert.match(script, /ip rule add lookup 0x22b pref 100/);

    // Layer 2: netd's per-socket mark cleared, which also forces a re-route.
    assert.match(script, /-t mangle -A OUTPUT -m mark ! --mark 0x22b\/0xffff -j MARK --set-xmark 0x0/);

    // Layer 3: the ACL, and specifically that it ends in a REJECT. An ACL whose
    // last word is not a denial is decoration.
    assert.match(script, /-A REDROID_EGRESS -o tun0 -j ACCEPT/);
    assert.match(script, /-A REDROID_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT/);
    assert.match(script, /-A REDROID_EGRESS -d 172\.30\.0\.0\/16 -j ACCEPT/);
    assert.match(script, /-A REDROID_EGRESS -j REJECT --reject-with icmp-admin-prohibited/);
    assert.match(script, /-I OUTPUT 1 -j REDROID_EGRESS/);

    await acquired.release();
  });

  it('turns IPv6 off in the namespace, where the policy cannot see it', async () => {
    // The gateway carries a v4 tun and the image has no ip6tables, so a v6
    // route would be an exit no rule in the script can block.
    const { subject, docker } = provider({ proxy });

    const acquired = await subject.acquire(context());

    assert.equal(docker.runs[0].sysctls?.['net.ipv6.conf.all.disable_ipv6'], '1');
    await acquired.release();
  });

  it('refuses the device when it answers from this host’s own address', async () => {
    // The leak this whole mechanism exists to prevent, and the only check that
    // measures the outcome instead of the configuration.
    const { subject, docker } = provider({
      proxy,
      directIp: '198.51.100.1',
      device: { egressIp: '198.51.100.1' },
    });

    await assert.rejects(subject.acquire(context()), /not going through the assigned proxy/);

    assert.deepEqual(docker.removed, ['redroid-job-job-1', 'redroid-gw-job-1']);
    assert.equal(docker.containers.size, 0, 'a leaking device must not be handed to the flow');
  });

  it('accepts a device whose address differs from this host’s', async () => {
    const { subject, device } = provider({
      proxy,
      directIp: '198.51.100.1',
      device: { egressIp: '203.0.113.7' },
    });

    const acquired = await subject.acquire(context());

    assert.deepEqual(device.probes[0], [
      'curl',
      '-sL',
      '--max-time',
      '20',
      // By IP: a hostname would need DNS, which is UDP and does not survive a
      // SOCKS5 proxy with no UDP ASSOCIATE — the check would time out on the
      // one thing it is not measuring.
      'http://1.1.1.1/cdn-cgi/trace',
    ]);
    await acquired.release();
  });

  it('falls back to wget when the image has no curl', async () => {
    const { subject, device } = provider({
      proxy,
      device: { egressIp: '203.0.113.7', egressTools: ['toybox'] },
    });

    const acquired = await subject.acquire(context());

    assert.deepEqual(
      device.probes.map((probe) => probe[0]),
      ['curl', 'toybox'],
      'curl first, then the tool an AOSP image actually ships',
    );

    await acquired.release();
  });

  it('reads the address out of a cdn-cgi/trace body, not just a bare line', async () => {
    const { subject, device } = provider({
      proxy,
      directIp: '198.51.100.1',
      device: { egressBody: 'fl=123abc\nh=1.1.1.1\nip=203.0.113.7\nts=1700000000\n' },
    });

    const acquired = await subject.acquire(context());
    assert.ok(acquired.serial, 'the trace body has to be understood, not treated as unreachable');

    await acquired.release();
    assert.ok(device.probes.length > 0);
  });

  it('gives up on a probe that never answers instead of waiting out adb', async () => {
    // A tunnel that swallows packets answers nothing at all. Only curl takes a
    // timeout flag, so without a deadline of our own the probe inherits adb's
    // ten minutes — three times over, on a job that looks alive the whole time.
    const { subject } = provider({
      proxy,
      config: { proxyGateway: { settleMs: 0, egressCheck: { timeoutSeconds: 1 } } },
      device: { egressHangs: true },
    });

    const started = Date.now();
    await assert.rejects(subject.acquire(context()), /no answer within 1s/);

    assert.ok(
      Date.now() - started < 30_000,
      'the probe has to be bounded by the configured timeout, not by adb’s default',
    );
  });

  it('names the culprit when the device cannot reach the endpoint but the gateway can', async () => {
    const docker = new FakeDocker({ execOutput: { wget: '203.0.113.7' } });
    const { subject } = provider({ docker, proxy, device: { egressTools: [] } });

    // The gateway answering while the device does not is the exact signature of
    // Android routing around the tun, and the message has to say so.
    await assert.rejects(subject.acquire(context()), /gateway can \(203\.0\.113\.7\), so the proxy works/);

    assert.equal(docker.containers.size, 0);
  });

  it('carries the namespace’s state in the error when nothing at all answers', async () => {
    // The containers are destroyed in a `finally`, so anything not captured
    // here is gone by the time someone reads the failure. Counters on the ACL
    // are what separate "the policy blocked it" from "the proxy is down".
    const docker = new FakeDocker({
      execOutput: { sh: '== egress ACL counters ==\n 12 720 REJECT all -- * *' },
    });
    const { subject } = provider({ docker, proxy, device: { egressTools: [] } });

    await assert.rejects(subject.acquire(context()), /egress ACL counters[\s\S]*REJECT/);
  });

  it('does not fail a run when the worker cannot tell what its own address is', async () => {
    // An air-gapped worker cannot answer the question, and refusing to publish
    // over an unanswerable question would ground the fleet.
    const { subject } = provider({ proxy, directIp: null, device: { egressIp: '203.0.113.7' } });

    const acquired = await subject.acquire(context());
    assert.ok(acquired.serial);

    await acquired.release();
  });

  it('leaves the namespace alone when hardening is turned off', async () => {
    const { subject, docker } = provider({ proxy, config: { proxyGateway: { settleMs: 0, harden: false } } });

    const acquired = await subject.acquire(context());

    assert.equal(
      docker.execs.some((call) => call.command[0] === 'sh'),
      false,
    );

    await acquired.release();
  });

  it('starts no gateway at all for an account without a proxy', async () => {
    const { subject, docker, device } = provider();

    const acquired = await subject.acquire(context());

    assert.equal(docker.runs.length, 1, 'the gateway is only for accounts that have a proxy');
    assert.equal(docker.runs[0].name, 'redroid-job-job-1');
    assert.equal(docker.runs[0].capAdd, undefined);

    // Nothing to pin and nothing to verify: an account with no proxy is
    // supposed to leave through this host.
    assert.deepEqual(docker.execs, []);
    assert.deepEqual(device.probes, []);

    await acquired.release();
  });
});

describe('egress policy script', () => {
  const upstream = [{ address: '78.143.233.210', port: 12324 }];

  /** The shape every case here starts from; overrides are the point of each test. */
  const policy = (overrides: Partial<Parameters<typeof policyFromEnv>[0]> = {}) =>
    policyFromEnv({ env: {}, controlSubnets: ['172.30.0.0/16'], proxyEndpoints: upstream, ...overrides });

  it('follows the gateway when the routing table, mark or tun name are overridden', () => {
    // The script has to describe the namespace the gateway actually built. Rules
    // pointing at the defaults would apply cleanly and route nothing.
    const script = egressPolicyScript(
      policy({
        env: { TABLE: '0x1f4', FWMARK: '0x1f4', TUN: 'redroid0' },
        controlSubnets: ['10.10.0.0/24', '10.20.0.0/24'],
      }),
    );

    assert.match(script, /ip rule add fwmark 0x1f4 lookup "\$BYPASS_TABLE" pref 90/);
    assert.match(script, /ip rule add lookup 0x1f4 pref 100/);
    assert.match(script, /-v tun="redroid0"/, 'the tun to exclude has to follow the gateway too');
    assert.match(script, /-A REDROID_EGRESS -o redroid0 -j ACCEPT/);
    assert.match(script, /-d 10\.10\.0\.0\/24 -j ACCEPT/);
    assert.match(script, /-d 10\.20\.0\.0\/24 -j ACCEPT/);
    assert.equal(script.includes('0x22b'), false, 'no default may survive an override');
  });

  it('guards every mutation so a retried acquisition does not stack a second copy', () => {
    const script = egressPolicyScript(policy());

    for (const line of script.split('\n')) {
      if (line.startsWith('ip rule add')) {
        const pref = /pref (\d+)/.exec(line)?.[1];
        assert.ok(pref, `no priority in: ${line}`);
        assert.ok(
          script.includes(`ip rule del pref ${pref}`),
          `${line} is added without being deleted first, so a second run doubles it`,
        );
      }
    }

    // Appends into the built-in chains are guarded with -C; the appends into
    // our own chain are safe because the chain is flushed first.
    assert.match(script, /-t mangle -C OUTPUT .* \|\| "\$IPT" -t mangle -A OUTPUT/);
    assert.match(script, /-N REDROID_EGRESS 2>\/dev\/null \|\| "\$IPT" -F REDROID_EGRESS/);
    assert.match(script, /-C OUTPUT -j REDROID_EGRESS 2>\/dev\/null \|\| "\$IPT" -I OUTPUT 1/);
  });

  it('picks an iptables backend the kernel answers, instead of assuming legacy', () => {
    // The image symlinks `iptables` to the legacy binary, and a host running
    // nftables reports every legacy table as "Table does not exist" — first
    // mangle, then xt_mark, then filter itself. Chasing that with modprobe is
    // emulating, one module at a time, a backend the kernel already has.
    const script = egressPolicyScript(policy());

    assert.match(script, /for candidate in iptables-nft iptables-legacy iptables; do/);
    assert.match(script, /"\$candidate" -S >\/dev\/null 2>&1/);

    // Every rule has to go through the chosen backend. A stray bare `iptables`
    // would work on the developer's machine and fail on an nftables host.
    for (const line of script.split('\n')) {
      assert.equal(
        /(^|\|\| |; )iptables /.test(line),
        false,
        `this line bypasses the detected backend: ${line}`,
      );
    }

    // And a container where none of them work must refuse, not continue: no
    // firewall means the device would run unfiltered.
    assert.match(script, /exit 1/);
  });

  it('survives a kernel missing the mangle table or the MARK target', () => {
    // Even on the right backend the mangle table can be absent. Under `set -eu`
    // that used to abort the whole script, taking the ACL down with it.
    const script = egressPolicyScript(policy());

    assert.match(script, /-t mangle -A OUTPUT .* 2>\/dev\/null; then :; else/);
    assert.match(script, /echo "WARN: could not clear netd's socket marks/);
  });

  it('sends the gateway’s own traffic to a table that has a route, not to main', () => {
    // The regression this guards: on Android, netd moves the physical interface
    // into a table of its own and leaves main empty. A bypass pointing at main
    // finds nothing, falls through every rule netd owns — none match a non-zero
    // mark — and dies on its `32000: from all unreachable`. The gateway loses
    // the connection to its own proxy and the tunnel relays nothing.
    const script = egressPolicyScript(policy());

    assert.match(script, /BYPASS_TABLE=\$\(ip route show table all/);
    assert.match(script, /\$1=="default" && index\(\$0, "dev " tun\)==0/, 'the tun is not a way out');
    assert.match(script, /ip rule add fwmark 0x22b lookup "\$BYPASS_TABLE" pref 90/);

    // main stays as a second chance, for a namespace nobody rearranged.
    assert.match(script, /ip rule add fwmark 0x22b lookup main pref 91/);
    assert.match(script, /ip rule del pref 91/, 'and it has to be deletable on a re-run');
  });

  it('lets the gateway reach its proxy without depending on any kernel module', () => {
    // The regression that motivated this: matching the gateway's own traffic by
    // fwmark put xt_mark in the path of a rule the mechanism depends on, so a
    // host without that module lost its proxy connection — not just its defence
    // in depth. A destination needs no module and is strictly narrower.
    const script = egressPolicyScript(policy());

    assert.match(script, /-A REDROID_EGRESS -d 78\.143\.233\.210 -p tcp --dport 12324 -j ACCEPT/);

    const markRule = script.split('\n').find((line) => line.includes('-m mark --mark'));
    assert.ok(markRule?.includes('|| echo "WARN:'), 'the mark rule must be optional now');
  });

  it('keeps ADB answering on a kernel with no conntrack match', () => {
    const script = egressPolicyScript(policy({ controlSubnets: [] }));

    // Stateless and narrow: packets *from* the ADB listener, which nothing else
    // can produce. Without it, a missing xt_conntrack means an unreachable
    // device and a job that fails looking like a boot problem.
    assert.match(script, /-A REDROID_EGRESS -p tcp --sport 5555 -j ACCEPT/);

    const conntrackRule = script.split('\n').find((line) => line.includes('--ctstate'));
    assert.ok(conntrackRule?.includes('|| echo "WARN:'), 'conntrack must be optional');
  });

  it('still denies when the kernel has no REJECT target', () => {
    const script = egressPolicyScript(policy({ controlSubnets: [] }));

    assert.match(
      script,
      /-j REJECT --reject-with icmp-admin-prohibited 2>\/dev\/null \|\| "\$IPT" -A REDROID_EGRESS -j DROP/,
      'a missing REJECT module must degrade to DROP, never to letting the packet out',
    );
  });

  it('opens no subnet when there is no control network to name', () => {
    const script = egressPolicyScript(policy({ controlSubnets: [] }));

    assert.equal(/-d \S+\/\d+ -j ACCEPT/.test(script), false, 'no CIDR may be opened');
    // The device stays reachable regardless: the ADB rule needs no subnet.
    assert.match(script, /--sport 5555 -j ACCEPT/);
  });

  it('resolves a proxy hostname, and reports the addresses it opened', async () => {
    const endpoints = await resolveProxyEndpoints({ host: 'gate.example.com', port: 1080 }, async () => [
      '203.0.113.7',
      '203.0.113.8',
    ]);

    assert.deepEqual(endpoints, [
      { address: '203.0.113.7', port: 1080 },
      { address: '203.0.113.8', port: 1080 },
    ]);

    // A provider that stops resolving must not throw here: the run continues on
    // the fwmark rule and the egress check has the last word.
    assert.deepEqual(
      await resolveProxyEndpoints({ host: 'nope.invalid', port: 1080 }, async () => {
        throw new Error('ENOTFOUND');
      }),
      [],
    );
  });
});

describe('this host’s own address', () => {
  it('is measured once and remembered, not fetched per job', async () => {
    resetDirectEgressCache();
    let calls = 0;

    const fetchImpl = (async () => {
      calls += 1;
      return new Response('198.51.100.1\n', { status: 200 });
    }) as unknown as typeof fetch;

    assert.equal(await directEgressIp('http://echo.test/ip', 1_000, fetchImpl), '198.51.100.1');
    assert.equal(await directEgressIp('http://echo.test/ip', 1_000, fetchImpl), '198.51.100.1');
    assert.equal(calls, 1, 'it is a property of the host, not of the job');
  });

  it('answers null instead of throwing when there is no way out', async () => {
    resetDirectEgressCache();

    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    assert.equal(await directEgressIp('http://echo.test/ip', 1_000, fetchImpl), null);
    resetDirectEgressCache();
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
