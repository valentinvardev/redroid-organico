import { z } from 'zod';
import type { JobLogger } from '@/lib/logging/jobLogger';
import { proxyUrl, redactProxyUrl, type ProxyRuntimeConfig } from '@/lib/proxy/config';
import {
  ACCOUNT_LABEL,
  CREATED_AT_LABEL,
  GATEWAY_ROLE,
  JOB_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  ROLE_LABEL,
  type DockerClient,
} from './docker';

/**
 * The egress half of the isolation pattern.
 *
 * A tun2socks container builds a tun device, points its own default route at it
 * and forwards everything to the account's proxy. The Android container is then
 * started with `--network container:<gateway>`, so it has no interface of its
 * own: there is no "use the proxy" setting inside Android that an app could
 * ignore, fail to honour for UDP, or reset when the session is restored.
 *
 * Two consequences worth knowing before changing anything here:
 *
 *  - Ports belong to the gateway. A container sharing another's namespace may
 *    not publish anything, so ADB's 5555 is published here and the device's
 *    serial is derived from this container.
 *  - It fails closed. If the proxy is unreachable, packets are dropped by the
 *    tun device rather than falling back to the host's address — a job that
 *    cannot use its proxy fails instead of quietly publishing from a datacentre
 *    IP, which is the entire point of assigning one.
 *
 * The image's entrypoint clones the main routing table and replaces only the
 * default route in the clone, so the Docker subnet stays on-link and the ADB
 * port published above keeps answering.
 */

export const proxyGatewayConfigSchema = z.object({
  /**
   * Pinned rather than `latest`: the entrypoint's variables and routing
   * behaviour are the contract this module is written against.
   */
  image: z.string().min(1).default('xjasonlyu/tun2socks:v2.5.1'),

  logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  /**
   * Passed to the container verbatim. The escape hatch for the entrypoint's
   * other knobs — MTU, TUN_EXCLUDED_ROUTES, EXTRA_COMMANDS — without this
   * module having to grow an option per variable. PROXY cannot be set here; it
   * is derived from the account's proxy.
   */
  env: z.record(z.string(), z.string()).default({}),

  /**
   * How long the gateway is watched before the device is started. tun2socks
   * exits immediately on a proxy URL it cannot parse or a missing /dev/net/tun,
   * and catching that here costs two seconds instead of the several minutes an
   * Android boot takes to fail afterwards.
   */
  settleMs: z.number().int().min(0).max(60_000).default(2_000),

  /**
   * Rewrite the namespace's routing and firewall once Android has booted, so
   * netd cannot route around the tun. See lib/android/egressPolicy.ts. Off is
   * for debugging only: without it the device's own sockets leave through eth0.
   */
  harden: z.boolean().default(true),

  /**
   * Turn IPv6 off in the namespace. The gateway carries a v4 tun and no
   * ip6tables, so a v6 route is an egress the policy cannot see, let alone
   * block — the classic way a "working" proxy setup leaks.
   */
  disableIpv6: z.boolean().default(true),

  /**
   * Ask the device what its own address looks like from the outside, and refuse
   * to run the flow if it matches this host's. The only check that measures the
   * result instead of the intent.
   */
  egressCheck: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * An ordinary web host, and plain HTTP.
       *
       * The device never resolves it — the worker does, and hands the address
       * to curl's `--resolve` — because DNS is UDP and a SOCKS5 proxy without
       * UDP ASSOCIATE drops it silently. Addressing the endpoint by IP dodges
       * DNS too, but the well-known ones are public DNS resolvers, and a
       * residential provider blocks those on principle: the CONNECT comes back
       * "connection not allowed by ruleset" and the check accuses a proxy that
       * is working.
       *
       * Anything returning a bare address, or a `key=value` body carrying an
       * `ip=` line, works.
       */
      url: z.string().url().default('http://api.ipify.org'),
      timeoutSeconds: z.number().int().positive().max(120).default(20),

      /**
       * A statically linked curl on the worker's filesystem, for the device's
       * architecture. Copied to the device the first time an account runs and
       * kept in its session volume after that.
       *
       * Needed because a stock AOSP image has no HTTP client at all: no curl,
       * and a toybox built without the wget applet. Same reason the APK is
       * installed at runtime rather than baked in — /data is a runtime mount
       * that `docker commit` never captures.
       *
       * Get one from https://github.com/moparisthebest/static-curl (aarch64).
       */
      probeBinary: z.string().min(1).optional(),
    })
    .prefault({}),
});

export type ProxyGatewayConfig = z.infer<typeof proxyGatewayConfigSchema>;

export interface StartGatewayOptions {
  docker: DockerClient;
  proxy: ProxyRuntimeConfig;
  jobId: string;
  accountId: string;
  config: ProxyGatewayConfig;
  /**
   * Docker network to join, and the one the proxy is reached over. The device
   * inherits it through the namespace, which is why the egress ACL has to be
   * the thing that keeps Android off it.
   */
  network?: string;
  /**
   * A second, `internal` network carrying nothing but ADB. Attached after the
   * container exists, because `docker run` takes one network. Its subnet is
   * what the ACL opens: an internal network has no route off the host, so even
   * a mistake in that rule cannot become an exit.
   */
  controlNetwork?: string;
  /** Published here because the device cannot publish ports of its own. */
  publishContainerPort?: number;
  log: JobLogger;
  signal: AbortSignal;
}

export interface RunningGateway {
  name: string;
  /** The `--network` value that puts a container inside this gateway's namespace. */
  networkMode: string;
  /** CIDRs of the control network, empty when there is none to open up. */
  controlSubnets: string[];
  /** Never throws; the reaper is the backstop. */
  remove(): Promise<void>;
}

export function gatewayContainerName(jobId: string): string {
  return `redroid-gw-${jobId}`.slice(0, 60);
}

export function gatewayNetworkMode(jobId: string): string {
  return `container:${gatewayContainerName(jobId)}`;
}

export async function startProxyGateway(options: StartGatewayOptions): Promise<RunningGateway> {
  const { docker, proxy, jobId, accountId, config, log, signal } = options;
  const name = gatewayContainerName(jobId);

  // A gateway left over from a previous attempt at this job would collide on
  // the name. Removing it is safe for the same reason as the device's: this job
  // is starting now, so nothing can legitimately be using it.
  await docker.remove(name).catch(() => undefined);

  await log.info('Starting the egress gateway for this account', {
    container: name,
    image: config.image,
    // Redacted here, and named `egress` rather than `proxy` on purpose: the
    // JobLogger blanks anything under a `proxy` key outright, which is the
    // backstop for a future call site that logs the raw config.
    egress: redactProxyUrl(proxy),
  });

  await docker.run(
    {
      image: config.image,
      name,
      labels: {
        [OWNER_LABEL]: OWNER_VALUE,
        [JOB_LABEL]: jobId,
        [ACCOUNT_LABEL]: accountId,
        [ROLE_LABEL]: GATEWAY_ROLE,
        [CREATED_AT_LABEL]: new Date().toISOString(),
      },
      capAdd: ['NET_ADMIN'],
      devices: ['/dev/net/tun'],
      network: options.network,
      publishContainerPort: options.publishContainerPort,
      // Set on the gateway, inherited by every container that joins its
      // namespace — including the one running Android, which is the only way to
      // reach its stack from out here.
      sysctls: config.disableIpv6
        ? {
            'net.ipv6.conf.all.disable_ipv6': '1',
            'net.ipv6.conf.default.disable_ipv6': '1',
          }
        : undefined,
      env: {
        ...config.env,
        // Last, so no operator-supplied override can point the gateway at a
        // different proxy than the one the account was assigned.
        PROXY: proxyUrl(proxy),
        LOGLEVEL: config.logLevel,
      },
    },
    { signal },
  );

  const remove = async () => {
    try {
      await docker.remove(name);
      await log.info('Egress gateway removed', { container: name });
    } catch (cause) {
      await log
        .warn('Could not remove the egress gateway; the reaper will collect it', {
          container: name,
          error: cause instanceof Error ? cause.message : String(cause),
        })
        .catch(() => undefined);
    }
  };

  let controlSubnets: string[] = [];

  try {
    await assertStillRunning(docker, name, config.settleMs, signal);

    if (options.controlNetwork) {
      // After the run, not part of it: `docker run` accepts a single network,
      // and the egress one has to be first so the default route points at the
      // proxy rather than into a network with no way out.
      await docker.connectNetwork(options.controlNetwork, name, { signal });
      controlSubnets = await docker.networkSubnets(options.controlNetwork, { signal });

      await log.info('Attached the gateway to the control network', {
        container: name,
        network: options.controlNetwork,
        subnets: controlSubnets,
      });
    }
  } catch (error) {
    const logs = await docker.logs(name, 40).catch(() => '');
    await remove();

    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
        (logs ? `\n--- last lines of ${name} ---\n${logs}` : ''),
      { cause: error },
    );
  }

  return { name, networkMode: `container:${name}`, controlSubnets, remove };
}

/**
 * Watches the gateway for `settleMs` and reports the first moment it is not up.
 *
 * Only catches a gateway that dies on startup. A proxy that accepts the
 * connection and then refuses to relay leaves tun2socks running happily, and
 * shows up later as a device that cannot reach the network — which is the safe
 * direction for it to fail in.
 */
async function assertStillRunning(
  docker: DockerClient,
  name: string,
  settleMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + settleMs;

  for (;;) {
    if (signal.aborted) {
      throw new Error('Cancelled while starting the egress gateway');
    }

    if (!(await docker.isRunning(name, { signal }))) {
      throw new Error(
        `The egress gateway ${name} exited on startup. tun2socks does this when the proxy URL ` +
          'cannot be parsed, or when /dev/net/tun is missing on the host (modprobe tun).',
      );
    }

    if (Date.now() >= deadline) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
  }
}
