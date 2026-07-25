import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { closeRedis } from '@/lib/queue/connection';
import { DEAD_LETTER_QUEUE, PUBLISH_QUEUE } from '@/lib/queue/publishQueue';
import { createPublishWorker, recoverOrphans } from '@/lib/worker/createWorker';
import { reapAndroidContainers, startAndroidReaper, type ReaperHandle } from '@/lib/android/reaper';

const env = getEnv();

/**
 * Android containers outlive the process that created them, so a worker that
 * was SIGKILLed leaves gigabyte-sized Android instances running with nothing
 * left to shut them down. The sweep at startup is the only mechanism that
 * recovers from that; the interval catches jobs that die later.
 */
async function startContainerReaping(): Promise<ReaperHandle | undefined> {
  if (env.PUBLISHER_DRIVER !== 'android') {
    return undefined;
  }

  const initial = await reapAndroidContainers({ graceMs: 0 });

  if (initial.inspected > 0) {
    console.log(`[worker] startup sweep: ${initial.removed.length}/${initial.inspected} container(s) reaped`);
  }

  if (env.ANDROID_REAPER_INTERVAL_MS === 0) {
    return undefined;
  }

  return startAndroidReaper(env.ANDROID_REAPER_INTERVAL_MS);
}

async function main(): Promise<void> {
  const recovered = await recoverOrphans();

  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} orphaned job(s)`);
  }

  // Deliberately after recoverOrphans(): that call moves jobs stranded by a
  // dead worker out of PROCESSING, which is exactly what makes their leftover
  // containers recognisable as garbage here.
  const reaper = await startContainerReaping();

  const worker = createPublishWorker();

  console.log(
    `[worker] listening on "${PUBLISH_QUEUE}" (concurrency ${env.WORKER_CONCURRENCY}, ` +
      `publisher "${env.PUBLISHER_DRIVER}", dlq "${DEAD_LETTER_QUEUE}")`,
  );

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`[worker] ${signal} received, finishing active jobs...`);

    reaper?.stop();

    // `false` lets in-flight jobs run to completion instead of being killed and
    // re-delivered, which for a publish job could mean a duplicate post.
    await worker.close(false);
    await prisma.$disconnect();
    await closeRedis();

    console.log('[worker] shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A stray stream error or a rejected promise nobody awaited would otherwise
  // take the process down with a bare stack trace. Exiting is still the right
  // response — the state is unknown — but it should be loud, and whatever was
  // in flight is reclaimed by recoverOrphans() on the next boot.
  process.on('uncaughtException', (error) => {
    console.error('[worker] uncaught exception, exiting so in-flight jobs are recovered on restart', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[worker] unhandled rejection, exiting so in-flight jobs are recovered on restart', reason);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('[worker] fatal', error);
  process.exit(1);
});
