import type { JobLogger } from '@/lib/logging/jobLogger';
import type { AndroidDevice } from './device';
import type { DockerClient } from './docker';

/**
 * Proves that the device's traffic really leaves through the proxy, by asking
 * it what its own address looks like from the outside.
 *
 * This is the only assertion in the system that cannot be satisfied by
 * configuration being correct-looking. Everything else — the gateway started,
 * the namespace was joined, the rules were applied — is a statement about what
 * the worker asked for. This one is a statement about what actually happened,
 * measured from inside Android, which is precisely where the routing bypass
 * used to hide.
 *
 * The comparison is against the address the run would have leaked from, not
 * against the proxy's: rotating residential proxies hand out a different exit
 * per connection, so "device IP equals gateway IP" produces false alarms all
 * day, while "device IP equals the host's own IP" is unambiguous.
 */

/** The device published from the machine's own address. Retrying cannot fix it. */
export class EgressLeakError extends Error {
  constructor(
    readonly deviceIp: string,
    readonly directIp: string,
  ) {
    super(
      `The device is reachable from ${deviceIp}, which is this host's own address — its traffic is ` +
        'not going through the assigned proxy. Refusing to drive the app from an unmasked address.',
    );
    this.name = 'EgressLeakError';
  }
}

/** Nothing answered. Could be the proxy, could be the endpoint; both are worth a retry. */
export class EgressUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EgressUnreachableError';
  }
}

const IP_PATTERN = /^[0-9a-f.:]{3,45}$/i;

/**
 * Reads the address out of whatever the endpoint answered.
 *
 * Two shapes, because the default endpoint is reached by IP to avoid DNS and
 * that rules out the services that return a bare address: Cloudflare's
 * `/cdn-cgi/trace` is a set of `key=value` lines, everything else is the
 * address on its own.
 */
function firstAddress(raw: string): string | null {
  const traced = /^ip=([0-9a-f.:]+)\s*$/im.exec(raw);

  if (traced) {
    return traced[1];
  }

  const candidate = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();

  return candidate && IP_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Asks the device. `curl` first, busybox/toybox `wget` second — an AOSP image
 * has no curl unless someone put it there, and failing the whole run over a
 * missing binary would be a poor trade for a check meant to protect it.
 */
export async function deviceEgressIp(
  device: AndroidDevice,
  url: string,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<string> {
  const attempts: string[][] = [
    // -L because the DNS-free default endpoint answers on plain HTTP with a
    // redirect to TLS.
    ['curl', '-sL', '--max-time', String(timeoutSeconds), url],
    ['toybox', 'wget', '-q', '-O', '-', url],
    ['wget', '-q', '-O', '-', url],
  ];

  const failures: string[] = [];

  for (const command of attempts) {
    // Every attempt gets its own deadline. Only curl takes a timeout flag, and
    // a device whose packets are being swallowed by the tunnel does not answer
    // at all — without this the probe inherits adb's ten-minute default and
    // three tools turn a dead network into half an hour of a job that looks
    // like it is doing something.
    let result: Awaited<ReturnType<AndroidDevice['probe']>>;

    try {
      result = await device.probe(
        command,
        AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1_000)]),
      );
    } catch (error) {
      // The job itself being cancelled is not this function's to swallow.
      if (signal.aborted) {
        throw error;
      }

      failures.push(`${command[0]}: no answer within ${timeoutSeconds}s`);
      continue;
    }

    const address = firstAddress(result.stdout);

    if (result.code === 0 && address) {
      return address;
    }

    const detail = `${result.stdout} ${result.stderr}`.trim().slice(0, 200);
    failures.push(`${command[0]}: exit ${result.code}${detail ? ` — ${detail}` : ''}`);
  }

  throw new EgressUnreachableError(
    `The device could not fetch ${url}. Tried: ${failures.join('; ')}. ` +
      'A timeout on every tool usually means the tunnel is swallowing the packets rather than the ' +
      'tools being absent — and if the URL carries a hostname, suspect DNS first: it is UDP, and a ' +
      'SOCKS5 proxy without UDP ASSOCIATE drops it silently. ' +
      'If the tools really are missing, bake one into the golden image ' +
      '(scripts/build-golden-image.sh --tool) or turn the check off with ' +
      'proxyGateway.egressCheck.enabled=false.',
  );
}

/**
 * Asks the gateway the same question. Only used to explain a failure: if the
 * gateway cannot reach the endpoint either, the proxy is down and Android is
 * innocent — a distinction worth a lot at three in the morning.
 */
export async function gatewayEgressIp(
  docker: DockerClient,
  gatewayName: string,
  url: string,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<string | null> {
  // busybox wget: the tun2socks image ships no curl.
  const stdout = await docker
    .exec(gatewayName, ['wget', '-q', '-O', '-', '-T', String(timeoutSeconds), url], { signal })
    .catch(() => '');

  return firstAddress(stdout);
}

let cachedDirectIp: { url: string; value: string | null } | undefined;

/**
 * The address the worker itself is seen as — what a leaked packet would show,
 * since every container on this host NATs through the same interface.
 *
 * Cached for the life of the process: it is a property of the host, and paying
 * a round trip per job to rediscover it would be silly. A worker whose network
 * has no direct route returns null, and the comparison is skipped rather than
 * failing a run over an unanswerable question.
 */
export async function directEgressIp(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (cachedDirectIp?.url === url) {
    return cachedDirectIp.value;
  }

  let value: string | null = null;

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    value = response.ok ? firstAddress(await response.text()) : null;
  } catch {
    value = null;
  }

  cachedDirectIp = { url, value };
  return value;
}

/** Test seam: the cache is process-wide and would otherwise leak between cases. */
export function resetDirectEgressCache(): void {
  cachedDirectIp = undefined;
}

export interface EgressCheckOptions {
  device: AndroidDevice;
  docker: DockerClient;
  gatewayName: string;
  url: string;
  timeoutSeconds: number;
  log: JobLogger;
  signal: AbortSignal;
  /** Injected by tests; production measures the worker's own address. */
  resolveDirectIp?: () => Promise<string | null>;
}

export async function assertProxiedEgress(options: EgressCheckOptions): Promise<string> {
  const { device, docker, gatewayName, url, timeoutSeconds, log, signal } = options;

  let deviceIp: string;

  try {
    deviceIp = await deviceEgressIp(device, url, timeoutSeconds, signal);
  } catch (error) {
    // Ask the gateway the same question, purely to name the culprit.
    const fromGateway = await gatewayEgressIp(docker, gatewayName, url, timeoutSeconds, signal);
    const detail = error instanceof Error ? error.message : String(error);

    throw new EgressUnreachableError(
      fromGateway
        ? `The device cannot reach ${url} but its gateway can (${fromGateway}), so the proxy works and ` +
          `Android is not using it — check the routing rules inside ${gatewayName}. ${detail}`
        : `Neither the device nor its gateway can reach ${url}: the proxy is not relaying traffic. ${detail}`,
      { cause: error },
    );
  }

  const directIp =
    (await (options.resolveDirectIp ?? (() => directEgressIp(url, timeoutSeconds * 1_000)))()) ?? null;

  if (directIp && deviceIp === directIp) {
    throw new EgressLeakError(deviceIp, directIp);
  }

  await log.info('Egress verified from inside the device', {
    deviceIp,
    // Logged so the two numbers being compared are both on the record; neither
    // is a secret, and without them a passing check proves nothing to a reader.
    directIp: directIp ?? '(unknown, comparison skipped)',
  });

  return deviceIp;
}
