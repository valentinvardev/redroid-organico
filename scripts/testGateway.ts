import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { prisma } from '@/lib/db';
import { openProxy } from '@/lib/proxy/service';
import { proxyUrl, redactProxyUrl } from '@/lib/proxy/config';

/**
 * Reproduces the runtime egress path in isolation: starts a tun2socks gateway
 * exactly as the worker does, then runs a throwaway container inside its network
 * namespace and asks that container what IP it exits from.
 *
 * This is the missing half of the dashboard's "Test" button. That one checks
 * the proxy from the host; this one checks whether a container placed in the
 * gateway's namespace — which is what an Android device is — actually leaves
 * through the proxy.
 *
 *   npx tsx scripts/testGateway.ts --proxy <label>
 */

const execFileAsync = promisify(execFile);
const GATEWAY = `gw-diag-${Date.now()}`;
const IMAGE = 'xjasonlyu/tun2socks:v2.5.1';
const PROBE_IMAGE = 'curlimages/curl:latest';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? failure.message ?? error) };
  }
}

async function main(): Promise<void> {
  const label = arg('--proxy');
  if (!label) {
    throw new Error('Usage: testGateway.ts --proxy <label>');
  }

  const proxy = await prisma.proxy.findFirst({ where: { label } });
  if (!proxy) {
    throw new Error(`No proxy labelled "${label}"`);
  }

  const runtime = openProxy(proxy);

  // --as http|socks5 tries the same host, port and credentials as a different
  // proxy type without touching the stored row. An HTTP proxy cannot tunnel
  // arbitrary TCP through tun2socks (it resets anything that is not a 443
  // CONNECT); most providers serve SOCKS5 on the same endpoint, which can.
  const asType = arg('--as');
  if (asType === 'http') runtime.type = 'HTTP';
  if (asType === 'socks5') runtime.type = 'SOCKS5';

  const url = proxyUrl(runtime);

  console.log(`\nGateway diagnostic for: ${redactProxyUrl(runtime)}\n`);

  try {
    // Bisection: the proxy straight from the host, no gateway involved. If this
    // works and the gateway does not, the routing is at fault; if this fails
    // too, the credentials are.
    console.log('==> proxy from the host directly (are the credentials good?)');
    const hostProbe = await docker([
      'run', '--rm', PROBE_IMAGE,
      '-s', '--max-time', '20', '-x', url, 'https://ipwho.is/',
    ]);
    const hostBody = hostProbe.stdout.trim();
    if (hostBody) {
      try {
        const info = JSON.parse(hostBody) as { ip?: string; country?: string; city?: string };
        console.log(`    ✓ proxy works — exits from ${info.ip} (${[info.city, info.country].filter(Boolean).join(', ')})`);
      } catch {
        console.log(`    raw: ${hostBody}`);
      }
    } else {
      console.log(`    ✗ the proxy did not answer from the host: ${hostProbe.stderr.trim() || '(empty)'}`);
      console.log('    → the credentials or the proxy itself are the problem, not the routing.');
    }
    console.log('');

    console.log('==> Starting the gateway (same flags as a real job)');
    const start = await docker([
      'run', '-d', '--name', GATEWAY,
      '--cap-add', 'NET_ADMIN',
      '--device', '/dev/net/tun',
      '-e', `PROXY=${url}`,
      '-e', 'LOGLEVEL=debug',
      IMAGE,
    ]);

    if (!start.stdout.trim()) {
      console.log(`    FAILED to start: ${start.stderr}`);
      return;
    }

    await sleep(4_000);

    const running = (await docker(['inspect', '--format', '{{.State.Running}}', GATEWAY])).stdout.trim();
    console.log(`    running: ${running}`);

    console.log('\n==> tun2socks logs (does it reach the proxy?)');
    const logs = await docker(['logs', '--tail', '30', GATEWAY]);
    console.log((logs.stdout + logs.stderr).trim() || '    (no output)');

    console.log('\n==> main routing table (is default via tun?)');
    const route = await docker(['exec', GATEWAY, 'ip', 'route']);
    console.log(route.stdout.trim() || route.stderr.trim() || '    (no ip in image)');

    console.log('\n==> policy rules (does fwmark 0x22b have a bypass?)');
    const rules = await docker(['exec', GATEWAY, 'ip', 'rule']);
    console.log(rules.stdout.trim() || rules.stderr.trim() || '    (none)');

    console.log('\n==> every route table');
    const allRoutes = await docker(['exec', GATEWAY, 'ip', 'route', 'show', 'table', 'all']);
    console.log(allRoutes.stdout.trim() || allRoutes.stderr.trim() || '    (none)');

    console.log('\n==> exit IP of a container INSIDE the gateway namespace');
    console.log('    (this is the test — an Android device sees exactly this)');
    // 1.1.1.1 by IP, following the http->https redirect, so no DNS is needed
    // and the trace still yields the exit address.
    const probe = await docker([
      'run', '--rm', '--network', `container:${GATEWAY}`,
      PROBE_IMAGE, '-sL', '--max-time', '20', 'http://1.1.1.1/cdn-cgi/trace',
    ]);

    const ipLine = /(?:^|\n)ip=([0-9a-f.:]+)/i.exec(probe.stdout);
    if (ipLine) {
      const exitIp = ipLine[1];
      console.log(`\n    exit IP: ${exitIp}   (proxy is ${runtime.host})`);
      console.log(
        exitIp === runtime.host
          ? '\n    ✓ Traffic leaves through the proxy. The gateway works end to end.'
          : '\n    ✗ Traffic does NOT leave through the proxy — it is bypassing tun2socks.',
      );
    } else {
      console.log(`    ${probe.stdout.trim() || probe.stderr.trim() || 'no answer'}`);
    }
  } finally {
    await docker(['rm', '-f', GATEWAY]);
    console.log(`\nCleaned up ${GATEWAY}.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
