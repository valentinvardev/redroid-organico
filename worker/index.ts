import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { closeRedis } from '@/lib/queue/connection';
import { DEAD_LETTER_QUEUE, PUBLISH_QUEUE } from '@/lib/queue/publishQueue';
import { createPublishWorker, recoverOrphans } from '@/lib/worker/createWorker';

const env = getEnv();

async function main(): Promise<void> {
  const recovered = await recoverOrphans();

  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} orphaned job(s)`);
  }

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
