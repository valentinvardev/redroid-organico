import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { proxyUrl, type ProxyRuntimeConfig } from './config';

/**
 * A reachability check for a proxy, run from the worker host: it opens a real
 * connection through the proxy to an IP-echo service and reports the address the
 * request came out of.
 *
 * This proves the credentials and the route work and shows which region the
 * exit is in. It does NOT exercise the tun2socks path a job actually uses — that
 * also needs `/dev/net/tun` and `sudo modprobe tun` on the host — so a proxy can
 * pass this and still need that one host step. The most common failure, though,
 * is bad credentials or an unreachable host, and this catches those in seconds.
 */

// One call does both: this returns the caller's IP *and* its geolocation, so
// there is no second round trip and the location is the exit's, not the host's.
const IP_LOOKUP = 'https://ipwho.is/';

export interface ProxyTestResult {
  ok: boolean;
  exitIp?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  latencyMs?: number;
  error?: string;
}

interface IpWhoResponse {
  success?: boolean;
  ip?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  message?: string;
}

function humanize(error: NodeJS.ErrnoException): string {
  const code = error.code ?? '';
  const message = error.message ?? String(error);

  if (code === 'ECONNREFUSED') return 'The proxy refused the connection — check the host and port.';
  if (code === 'ENOTFOUND') return 'The proxy host could not be resolved — check for a typo.';
  if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(message)) {
    return 'No answer from the proxy — it may be down, or the port is wrong.';
  }
  if (/authentication|auth failed|403|407|credentials/i.test(message)) {
    return 'The proxy rejected the credentials — check the username and password.';
  }
  if (/socks/i.test(message)) return `The SOCKS handshake failed: ${message}`;
  return message;
}

export async function testProxy(config: ProxyRuntimeConfig, timeoutMs = 12_000): Promise<ProxyTestResult> {
  let agent: https.Agent;

  try {
    const url = proxyUrl(config);
    // `timeout` on the agent bounds the connection *to the proxy*; the one on
    // https.get below only bounds the idle after it is established. Without both,
    // a proxy host that silently drops SYNs hangs for the OS retry window (tens
    // of seconds) rather than the budget asked for here.
    agent =
      config.type === 'SOCKS5'
        ? new SocksProxyAgent(url, { timeout: timeoutMs })
        : new HttpsProxyAgent(url, { timeout: timeoutMs });
  } catch (error) {
    return { ok: false, error: `Could not build the proxy URL: ${error instanceof Error ? error.message : error}` };
  }

  const started = Date.now();

  return new Promise((resolve) => {
    const request = https.get(IP_LOOKUP, { agent, timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve({ ok: false, error: `The check service answered ${response.statusCode} through the proxy.` });
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(body) as IpWhoResponse;

          // ipwho.is answers 200 with success:false for rate limits and the
          // like — the address, if any, is still the real exit, so report it
          // and just leave the location blank.
          if (typeof data.ip === 'string' && data.ip.length > 0) {
            resolve({
              ok: true,
              exitIp: data.ip,
              country: data.country || undefined,
              countryCode: data.country_code || undefined,
              region: data.region || undefined,
              city: data.city || undefined,
              latencyMs: Date.now() - started,
            });
          } else {
            resolve({ ok: false, error: data.message || 'The check service returned no address.' });
          }
        } catch {
          resolve({ ok: false, error: 'Unexpected response from the check service.' });
        }
      });
    });

    request.on('timeout', () => request.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => resolve({ ok: false, error: humanize(error as NodeJS.ErrnoException) }));
  });
}
