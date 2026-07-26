import type { JobLogger } from '@/lib/logging/jobLogger';
import type { DockerClient } from './docker';

/**
 * Pins the shared network namespace to the tun device, against Android itself.
 *
 * The problem this exists for: `netd` is not a passive resident of the
 * namespace. It installs its own policy routing rules and stamps every socket
 * with the network id via SO_MARK, so Android's traffic is matched by *its*
 * rules and leaves through eth0 while an unmarked `curl` in the same namespace
 * dutifully follows the tun. Nothing escapes the namespace — netd simply wins
 * the priority contest, because every rule it installs sits in the 10000–32000
 * band and the gateway's catch-all is above that.
 *
 * Three layers, deliberately redundant, because the first two can be undone by
 * anything that reconfigures the stack later and the third cannot:
 *
 *  1. Routing. The same rules at a priority below everything netd owns.
 *  2. Marking. netd's per-socket mark is cleared in mangle OUTPUT, which also
 *     forces the kernel to re-run the route lookup for that packet.
 *  3. An ACL. Whatever the routing decides, only the tun, the loopback, the
 *     control subnet and the gateway's own marked socket may send anything;
 *     the rest is rejected. A leak stops being a wrong IP and becomes a failed
 *     connection — which the egress check then reports.
 *
 * Applied after Android has booted, not at `docker run`: netd inserts its own
 * jumps at the top of the built-in chains while it starts, and anything written
 * before that can end up behind them.
 */

/** Chain name, so a re-run replaces the rules instead of stacking a second copy. */
const CHAIN = 'REDROID_EGRESS';

export interface EgressPolicy {
  /** Routing table holding the tun default route — tun2socks' TABLE. */
  table: string;
  /** fwmark tun2socks stamps on its own upstream socket — its FWMARK. */
  mark: string;
  /** The tun device the gateway created. */
  tunDevice: string;
  /**
   * CIDRs of the control network. ADB has to keep answering, and the reply to
   * an inbound connection is the one thing the ACL must never reject.
   */
  controlSubnets: string[];
  /** Priority of the bypass rule for the gateway's own upstream connection. */
  bypassPref: number;
  /** Priority of the catch-all that sends everything else into the tun. */
  tunPref: number;
  /**
   * Where the gateway's own upstream connection goes, resolved to addresses.
   *
   * This is what lets the ACL recognise that connection without `-m mark`. It
   * is also narrower than the mark was: the mark permits any packet carrying
   * it, this permits exactly the proxy endpoint, which is the only place
   * tun2socks ever dials.
   */
  proxyEndpoints: Array<{ address: string; port: number }>;
  /** ADB's port inside the namespace, allowed out statelessly so replies survive. */
  adbPort: number;
}

export const DEFAULT_PREFS = {
  /**
   * Both below netd's lowest (10000) and above nothing that matters: priority 0
   * is the kernel's `local` table, which must keep winning or the container
   * cannot talk to itself.
   */
  bypass: 90,
  tun: 100,
} as const;

export interface PolicyInput {
  /** The gateway's environment, so an override of TABLE or FWMARK is honoured. */
  env: Record<string, string>;
  controlSubnets: string[];
  proxyEndpoints: Array<{ address: string; port: number }>;
  adbPort?: number;
}

export function policyFromEnv(input: PolicyInput): EgressPolicy {
  return {
    table: input.env.TABLE ?? '0x22b',
    mark: input.env.FWMARK ?? '0x22b',
    tunDevice: input.env.TUN ?? 'tun0',
    controlSubnets: input.controlSubnets,
    proxyEndpoints: input.proxyEndpoints,
    adbPort: input.adbPort ?? 5555,
    bypassPref: DEFAULT_PREFS.bypass,
    tunPref: DEFAULT_PREFS.tun,
  };
}

/**
 * Resolves the proxy's host to the addresses the ACL will open.
 *
 * A literal address — which is what most residential providers hand out — comes
 * straight back. A hostname is resolved here rather than inside the gateway
 * because busybox's resolver tooling is not guaranteed to be present, and
 * because a failure needs to reach a job log rather than a shell's stderr.
 */
export async function resolveProxyEndpoints(
  proxy: { host: string; port: number },
  lookup: (host: string) => Promise<string[]> = defaultLookup,
): Promise<Array<{ address: string; port: number }>> {
  const addresses = await (lookup ?? defaultLookup)(proxy.host).catch(() => [] as string[]);

  return addresses.map((address) => ({ address, port: proxy.port }));
}

async function defaultLookup(host: string): Promise<string[]> {
  const { lookup } = await import('dns/promises');
  // v4 only: the gateway runs with IPv6 disabled, so a AAAA record here would
  // produce a rule for an address family that cannot carry a packet.
  const results = await lookup(host, { all: true, family: 4 });

  return results.map((entry) => entry.address);
}

/**
 * The script, as a pure function so the rules can be asserted without a daemon.
 *
 * Every step is idempotent: rules are deleted by priority before being added,
 * iptables rules are guarded with `-C`, and the chain is flushed rather than
 * recreated. Re-running it must be a no-op, because a retried acquisition does.
 */
export function egressPolicyScript(policy: EgressPolicy): string {
  const { table, mark, tunDevice, bypassPref, tunPref } = policy;
  const mangleRule = `-m mark ! --mark ${mark}/0xffff -j MARK --set-xmark 0x0/0xffffffff`;
  // Every rule goes through the backend picked at the top of the script.
  const ipt = '"$IPT"';

  return [
    'set -eu',

    // Pick an iptables that this kernel actually answers.
    //
    // The image symlinks `iptables` to the legacy binary, and a modern host —
    // Ubuntu 24.04 on — runs nftables, where every legacy table reads as "Table
    // does not exist". Chasing that with `modprobe iptable_filter`,
    // `iptable_mangle`, `xt_mark` … is loading one legacy module at a time to
    // emulate a backend the kernel already provides.
    //
    // nft first because it is where a modern kernel keeps its rules. Either
    // backend is enforced regardless — both register their own netfilter hooks,
    // and a REJECT in one applies whatever the other holds.
    'IPT=""',
    'for candidate in iptables-nft iptables-legacy iptables; do',
    '  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -S >/dev/null 2>&1; then',
    '    IPT="$candidate"',
    '    break',
    '  fi',
    'done',
    'if [ -z "$IPT" ]; then',
    '  echo "ERROR: no iptables backend in this container can reach the filter table," \\',
    '       "so the egress firewall cannot be built and the device would run unfiltered." >&2',
    '  exit 1',
    'fi',
    'echo "INFO: iptables backend: $IPT"',

    // Layer 1 — routing priority.
    //
    // The bypass has to point at a table that actually holds a route to the
    // outside, and on Android that is not `main`. netd moves the physical
    // interface into a table of its own and leaves main empty, so a packet
    // carrying tun2socks' mark finds nothing there, falls through every rule
    // netd owns — none of which match a non-zero mark — and lands on its
    // `32000: from all unreachable`. The gateway loses the connection to its
    // own proxy, and the symptom is a tunnel that relays nothing.
    //
    // So the table is discovered: the first default route that is not the tun's.
    `BYPASS_TABLE=$(ip route show table all 2>/dev/null | awk -v tun="${tunDevice}" '` +
      `$1=="default" && index($0, "dev " tun)==0 { t="main"; ` +
      `for (i=1;i<=NF;i++) if ($i=="table") t=$(i+1); print t; exit }')`,
    'BYPASS_TABLE=${BYPASS_TABLE:-main}',
    `echo "INFO: bypass table for the gateway's own traffic: $BYPASS_TABLE"`,

    `ip rule del pref ${bypassPref} 2>/dev/null || true`,
    `ip rule del pref ${bypassPref + 1} 2>/dev/null || true`,
    `ip rule del pref ${tunPref} 2>/dev/null || true`,
    // First, or the gateway's own connection to the proxy is routed into the
    // tun it is serving and the whole thing deadlocks.
    `ip rule add fwmark ${mark} lookup "$BYPASS_TABLE" pref ${bypassPref}`,
    // main as a second chance, for a container that is not Android and whose
    // routes never moved anywhere.
    `ip rule add fwmark ${mark} lookup main pref ${bypassPref + 1}`,
    `ip rule add lookup ${table} pref ${tunPref}`,

    // Layer 2 — clear netd's per-socket mark. Changing the mark in mangle
    // OUTPUT makes the kernel re-run the route lookup, which is the point.
    //
    // Guarded on the table existing at all. Netfilter tables live in the host
    // kernel, not in the container: a host that never loaded `iptable_mangle`
    // answers "Table does not exist" no matter what capabilities the container
    // has, and Docker only ever loads `filter` and `nat` for its own use.
    //
    // Degrading instead of failing is deliberate. Layer 1 already sends every
    // packet to the tun table whatever its mark, and layer 3 rejects anything
    // that still tries to leave another way — this layer only defends against a
    // rule at a priority we did not anticipate. Losing it is worth a warning,
    // not a dead job.
    //
    // The whole thing, table check included, is best-effort for one reason:
    // `-j MARK` is a separate module again (xt_mark), so the table can exist
    // and the rule still be unsupported.
    `if ${ipt} -t mangle -C OUTPUT ${mangleRule} 2>/dev/null || ${ipt} -t mangle -A OUTPUT ${mangleRule} 2>/dev/null; then :; else`,
    `  echo "WARN: could not clear netd's socket marks with $IPT — no mangle table or no MARK target."`,
    `fi`,

    // Layer 3 — the ACL. Nothing below this line depends on routing being right.
    `${ipt} -N ${CHAIN} 2>/dev/null || ${ipt} -F ${CHAIN}`,
    `${ipt} -A ${CHAIN} -o lo -j ACCEPT`,
    `${ipt} -A ${CHAIN} -o ${tunDevice} -j ACCEPT`,
    // ADB's replies, matched statelessly on the source port so that the control
    // plane survives a kernel with no conntrack module. Narrow: it permits
    // packets *from* the ADB listener, which nothing else can produce.
    `${ipt} -A ${CHAIN} -p tcp --sport ${policy.adbPort} -j ACCEPT`,
    // Everything else answering an inbound connection. Best-effort because
    // xt_conntrack is yet another module, and the rule above already covers the
    // one connection that must never break.
    `${ipt} -A ${CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null ||` +
      ` echo "WARN: no conntrack match available; only ADB replies are permitted back out."`,
    // The gateway's own upstream connection, by destination.
    //
    // This used to be matched on tun2socks' fwmark, which was a mistake: it put
    // a kernel module (xt_mark) in the path of a rule the whole mechanism
    // depends on, and a host without it lost its proxy connection rather than
    // its defence in depth. A destination is module-free and strictly narrower.
    ...policy.proxyEndpoints.map(
      (endpoint) => `${ipt} -A ${CHAIN} -d ${endpoint.address} -p tcp --dport ${endpoint.port} -j ACCEPT`,
    ),
    // Kept as well, when the module is there: it covers a proxy that resolves
    // to an address we did not pin, e.g. after tun2socks reconnects.
    `${ipt} -A ${CHAIN} -m mark --mark ${mark}/0xffff -j ACCEPT 2>/dev/null ||` +
      ` echo "WARN: no mark match available; only the resolved proxy addresses are reachable."`,
    ...policy.controlSubnets.map((subnet) => `${ipt} -A ${CHAIN} -d ${subnet} -j ACCEPT`),
    // REJECT, not DROP: a leak should fail in milliseconds and be visible in a
    // log, not hang for two minutes looking like a slow network. The fallback
    // is for the same reason as the mangle guard — the REJECT target is another
    // module a thin kernel may not have — and it keeps the guarantee, because
    // what matters here is the denial, not how politely it is delivered.
    `${ipt} -A ${CHAIN} -j REJECT --reject-with icmp-admin-prohibited 2>/dev/null || ${ipt} -A ${CHAIN} -j DROP`,
    `${ipt} -C OUTPUT -j ${CHAIN} 2>/dev/null || ${ipt} -I OUTPUT 1 -j ${CHAIN}`,
  ].join('\n');
}

export interface ApplyPolicyOptions {
  docker: DockerClient;
  gatewayName: string;
  policy: EgressPolicy;
  log: JobLogger;
  signal: AbortSignal;
}

export async function applyEgressPolicy(options: ApplyPolicyOptions): Promise<void> {
  const { docker, gatewayName, policy, log, signal } = options;

  await log.info('Pinning the device namespace to the proxy gateway', {
    container: gatewayName,
    tunDevice: policy.tunDevice,
    controlSubnets: policy.controlSubnets,
  });

  let output: string;

  try {
    output = await docker.exec(gatewayName, ['sh', '-c', egressPolicyScript(policy)], { signal });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    throw new Error(
      `Could not pin the network namespace to ${policy.tunDevice}. The device would run with ` +
        `Android's own routing, which sends its traffic out of eth0 regardless of the proxy: ${message}`,
      { cause },
    );
  }

  // A layer that could not be applied has to reach the operator. The script
  // exits 0 in that case by design, so the only evidence is what it printed.
  const warnings = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('WARN:'));

  if (warnings.length > 0) {
    await log.warn('The namespace was pinned, but with a weaker policy than intended', { warnings });
  }

  // Cheap, and the only record of what the namespace actually looked like when
  // a run misbehaves. The device's own view is identical — same namespace.
  const rules = await docker.exec(gatewayName, ['ip', 'rule', 'show'], { signal }).catch(() => '');

  await log.debug('Routing rules after hardening', { ipRule: rules || '(unavailable)' });
}
