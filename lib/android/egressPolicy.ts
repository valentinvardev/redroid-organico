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

/**
 * Reads the policy off the gateway's environment, so an operator who overrides
 * TABLE or FWMARK does not silently get rules pointing at the defaults.
 */
export function policyFromEnv(env: Record<string, string>, controlSubnets: string[]): EgressPolicy {
  return {
    table: env.TABLE ?? '0x22b',
    mark: env.FWMARK ?? '0x22b',
    tunDevice: env.TUN ?? 'tun0',
    controlSubnets,
    bypassPref: DEFAULT_PREFS.bypass,
    tunPref: DEFAULT_PREFS.tun,
  };
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

  return [
    'set -eu',

    // Layer 1 — routing priority.
    `ip rule del pref ${bypassPref} 2>/dev/null || true`,
    `ip rule del pref ${tunPref} 2>/dev/null || true`,
    // First, or the gateway's own connection to the proxy is routed into the
    // tun it is serving and the whole thing deadlocks.
    `ip rule add fwmark ${mark} lookup main pref ${bypassPref}`,
    `ip rule add lookup ${table} pref ${tunPref}`,

    // Layer 2 — clear netd's per-socket mark. Changing the mark in mangle
    // OUTPUT makes the kernel re-run the route lookup, which is the point.
    `iptables -t mangle -C OUTPUT ${mangleRule} 2>/dev/null || iptables -t mangle -A OUTPUT ${mangleRule}`,

    // Layer 3 — the ACL. Nothing below this line depends on routing being right.
    `iptables -N ${CHAIN} 2>/dev/null || iptables -F ${CHAIN}`,
    `iptables -A ${CHAIN} -o lo -j ACCEPT`,
    `iptables -A ${CHAIN} -o ${tunDevice} -j ACCEPT`,
    // Replies to connections opened from outside — ADB above all. Without this
    // the rule set is correct and the device is unreachable.
    `iptables -A ${CHAIN} -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT`,
    // The gateway's own upstream socket, the only thing allowed out unproxied.
    `iptables -A ${CHAIN} -m mark --mark ${mark}/0xffff -j ACCEPT`,
    ...policy.controlSubnets.map((subnet) => `iptables -A ${CHAIN} -d ${subnet} -j ACCEPT`),
    // REJECT, not DROP: a leak should fail in milliseconds and be visible in a
    // log, not hang for two minutes looking like a slow network.
    `iptables -A ${CHAIN} -j REJECT --reject-with icmp-admin-prohibited`,
    `iptables -C OUTPUT -j ${CHAIN} 2>/dev/null || iptables -I OUTPUT 1 -j ${CHAIN}`,
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

  try {
    await docker.exec(gatewayName, ['sh', '-c', egressPolicyScript(policy)], { signal });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    throw new Error(
      `Could not pin the network namespace to ${policy.tunDevice}. The device would run with ` +
        `Android's own routing, which sends its traffic out of eth0 regardless of the proxy: ${message}`,
      { cause },
    );
  }

  // Cheap, and the only record of what the namespace actually looked like when
  // a run misbehaves. The device's own view is identical — same namespace.
  const rules = await docker.exec(gatewayName, ['ip', 'rule', 'show'], { signal }).catch(() => '');

  await log.debug('Routing rules after hardening', { ipRule: rules || '(unavailable)' });
}
