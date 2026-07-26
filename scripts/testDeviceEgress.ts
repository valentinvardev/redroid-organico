import 'dotenv/config';
import { randomUUID } from 'crypto';
import { JobStatus, JobType } from '@prisma/client';
import { prisma } from '@/lib/db';
import { open as openSecret } from '@/lib/crypto/secretBox';
import { openProxy } from '@/lib/proxy/service';
import { redactProxyUrl, type ProxyRuntimeConfig } from '@/lib/proxy/config';
import { androidCredentialsSchema } from '@/lib/publisher/android';
import { EphemeralRedroidProvider } from '@/lib/android/redroidProvider';
import { EgressLeakError, EgressUnreachableError } from '@/lib/android/egressCheck';
import { JobLogger } from '@/lib/logging/jobLogger';
import type { AcquiredDevice } from '@/lib/android/deviceProvider';

/**
 * Boots the real ReDroid device the way a job does — its gateway, its network
 * namespace, the hardening rules, the egress check — and reports the address the
 * *device* exits from.
 *
 * testGateway.ts answers this for a plain container. This answers it for
 * Android, which is the one that runs its own netd and has opinions about
 * routing a plain container never has. A pass logs "Egress verified from inside
 * the device"; a leak throws EgressLeakError with both addresses. Nothing is
 * published and the device is destroyed at the end either way.
 *
 *   npx tsx scripts/testDeviceEgress.ts --account <id>
 *   npx tsx scripts/testDeviceEgress.ts --account <id> --proxy <label>
 *   npx tsx scripts/testDeviceEgress.ts --account <id> --hold
 *
 * --proxy overrides the account's assigned egress with another of your labels,
 * without touching the account. --hold leaves the verified device running so you
 * can open the viewer and check whatsmyip by hand; Ctrl-C tears it down.
 */

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const SENSITIVE = /pass|secret|token|credential|proxy|cookie|auth/i;

function safeData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = SENSITIVE.test(key) ? '[redacted]' : value;
  }
  return out;
}

/**
 * Mirrors the acquire path's job log to the terminal, so the egress verdict is
 * visible live, and still persists it to the DB under the guard job below.
 */
class TeeLogger extends JobLogger {
  private echo(mark: string, message: string, data?: Record<string, unknown>): void {
    console.log(`  ${mark} ${message}${data ? `  ${JSON.stringify(safeData(data))}` : ''}`);
  }
  async debug(message: string, data?: Record<string, unknown>) { this.echo('·', message, data); await super.debug(message, data); }
  async info(message: string, data?: Record<string, unknown>) { this.echo('•', message, data); await super.info(message, data); }
  async warn(message: string, data?: Record<string, unknown>) { this.echo('!', message, data); await super.warn(message, data); }
  async error(message: string, data?: Record<string, unknown>) { this.echo('✗', message, data); await super.error(message, data); }
}

async function main(): Promise<void> {
  const accountId = arg('--account');
  if (!accountId) {
    throw new Error('Usage: testDeviceEgress.ts --account <id> [--proxy <label>] [--hold]');
  }
  const hold = process.argv.includes('--hold');

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { proxy: true },
  });

  if (!account) {
    throw new Error(`No account ${accountId}`);
  }

  if (!account.credentials) {
    throw new Error(`Account ${account.name} has no credentials — nothing describes the device to bring up.`);
  }

  const credentials = androidCredentialsSchema.parse(openSecret(account.credentials));

  if (!credentials.redroid) {
    throw new Error(
      `Account ${account.name} has no redroid block. Egress can only be enforced on containers this worker ` +
        'creates, so there is no device-level egress to test here.',
    );
  }

  // The egress under test: an explicit --proxy label, else the account's own.
  let proxy: ProxyRuntimeConfig;
  const overrideLabel = arg('--proxy');

  if (overrideLabel) {
    const row = await prisma.proxy.findFirst({ where: { userId: account.userId, label: overrideLabel } });
    if (!row) {
      throw new Error(`No proxy labelled "${overrideLabel}" for this account's owner.`);
    }
    proxy = openProxy(row);
  } else if (account.proxy) {
    proxy = openProxy(account.proxy);
  } else {
    throw new Error(
      `Account ${account.name} has no proxy assigned, so its traffic leaves through the host. Assign one in ` +
        'the dashboard, or pass --proxy <label>, before testing device egress.',
    );
  }

  console.log(`\nDevice egress test — account "${account.name}" via ${redactProxyUrl(proxy)}`);
  console.log(
    `  harden: ${credentials.redroid.proxyGateway.harden ? 'on' : 'off'}, ` +
      `egressCheck: ${credentials.redroid.proxyGateway.egressCheck.enabled ? 'on' : 'off'}\n`,
  );

  // A real, PROCESSING guard row so a running worker's reaper treats the test
  // container as a live job rather than a 90-second-old orphan and tears it out
  // from under the test. Cancelled again in the finally.
  const job = await prisma.job.create({
    data: {
      userId: account.userId,
      accountId: account.id,
      type: JobType.PUBLISH_VIDEO,
      status: JobStatus.PROCESSING,
      flowType: 'egress-test',
      idempotencyKey: `egress-test-${randomUUID()}`,
      startedAt: new Date(),
      maxAttempts: 1,
    },
  });

  const log = new TeeLogger(job.id);

  const adbServer =
    credentials.adbHost || credentials.adbPort
      ? { host: credentials.adbHost, port: credentials.adbPort }
      : undefined;

  const provider = new EphemeralRedroidProvider({
    config: credentials.redroid,
    proxy,
    adbCommand: credentials.adbCommand,
    adbServer,
    bootTimeoutSeconds: credentials.bootTimeoutSeconds,
  });

  const controller = new AbortController();
  // During acquire, Ctrl-C aborts the boot; once the device is held open it
  // instead ends the hold so the finally can tear down cleanly.
  let onInterrupt = () => controller.abort();
  process.on('SIGINT', () => onInterrupt());

  let acquired: AcquiredDevice | null = null;
  let verdict = 'device egress test finished';

  try {
    console.log('Booting the device and applying egress rules (this can take a few minutes)…\n');

    acquired = await provider.acquire({
      jobId: job.id,
      accountId: account.id,
      packageName: credentials.packageName,
      apkPath: credentials.apkPath,
      log,
      signal: controller.signal,
    });

    // acquire() already ran assertProxiedEgress. This extra probe just restates
    // the exit address plainly, which is the number the test exists to show.
    const url = credentials.redroid.proxyGateway.egressCheck.url ?? 'https://api.ipify.org';
    const probe = await acquired.device.probe(['curl', '-s', '--max-time', '20', url], controller.signal);
    const exitIp = probe.stdout.trim().split('\n').pop()?.trim() || '(no answer)';

    verdict = `device exits from ${exitIp}`;
    console.log(`\n✓ Egress holds. The device exits from ${exitIp} — its traffic goes through the proxy.`);

    if (hold) {
      console.log(
        `\nHolding the device open. serial: ${acquired.serial}\n` +
          '  Open the viewer and check whatsmyip to confirm by hand.\n' +
          '  Press Ctrl-C to tear it down.\n',
      );
      await new Promise<void>((resolve) => {
        onInterrupt = () => resolve();
      });
      console.log('\nTearing down…');
    }
  } catch (error) {
    if (error instanceof EgressLeakError) {
      verdict = `LEAK: device exited from ${error.deviceIp} (the host's own address)`;
      console.log(`\n✗ LEAK. ${error.message}`);
      console.log('  The device is NOT using the proxy — its traffic is bypassing the gateway.');
    } else if (error instanceof EgressUnreachableError) {
      verdict = 'egress unreachable';
      console.log(`\n✗ Nothing answered. ${error.message}`);
    } else {
      verdict = `error: ${error instanceof Error ? error.message : String(error)}`;
      console.log(`\n✗ The device never came up: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  } finally {
    if (acquired) {
      await acquired.release().catch(() => undefined);
    }

    await prisma.job
      .update({
        where: { id: job.id },
        data: { status: JobStatus.CANCELLED, completedAt: new Date(), errorMessage: verdict.slice(0, 5_000) },
      })
      .catch(() => undefined);

    console.log(`\nDone. Full log is on job ${job.id}.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
