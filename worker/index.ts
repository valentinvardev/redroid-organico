import 'dotenv/config';
import { mkdir, readFile } from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { closeRedis } from '@/lib/queue/connection';
import { DEAD_LETTER_QUEUE, PUBLISH_QUEUE } from '@/lib/queue/publishQueue';
import { createPublishWorker, reconcileSlots, recoverOrphans } from '@/lib/worker/createWorker';
import {
  reapAndroidContainers,
  reconcileCameraLeases,
  startAndroidReaper,
  type ReaperHandle,
} from '@/lib/android/reaper';

const env = getEnv();

/** How long a graceful shutdown waits for in-flight jobs before forcing it. */
const SHUTDOWN_GRACE_MS = 30_000;

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

  // After the sweep, so the containers it just removed are already gone from
  // the listing this reads. A lease whose container was reaped a moment ago is
  // exactly the one that needs returning.
  await reconcileCameraLeases();

  if (env.ANDROID_REAPER_INTERVAL_MS === 0) {
    return undefined;
  }

  return startAndroidReaper(env.ANDROID_REAPER_INTERVAL_MS);
}

/**
 * Video staging on a RAM-backed filesystem is invisible until the day a large
 * upload competes with an Android container for memory and the kernel picks a
 * loser. Cheap to check once, at boot, where somebody will read it.
 */
async function warnIfStagingIsInMemory(): Promise<void> {
  const dir = path.resolve(process.cwd(), env.MEDIA_STAGING_DIR);
  await mkdir(dir, { recursive: true });

  try {
    const mounts = await readFile('/proc/mounts', 'utf8');
    const onTmpfs = mounts
      .split('\n')
      .map((line) => line.split(' '))
      .filter(([, , type]) => type === 'tmpfs')
      .some(([, mountPoint]) => dir === mountPoint || dir.startsWith(`${mountPoint}/`));

    if (onTmpfs) {
      console.warn(
        `[worker] MEDIA_STAGING_DIR (${dir}) is on a tmpfs — staged videos are held in RAM ` +
          'and compete with the Android containers. Point it at a real disk.',
      );
      return;
    }
  } catch {
    // Not Linux, or /proc unavailable. Nothing to warn about.
  }

  console.log(`[worker] staging media in ${dir}`);
}

async function main(): Promise<void> {
  await warnIfStagingIsInMemory();

  const recovered = await recoverOrphans();

  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} orphaned job(s)`);
  }

  const corrected = await reconcileSlots();

  if (corrected > 0) {
    console.log(`[worker] reset ${corrected} leaked account concurrency slot(s)`);
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
    //
    // Bounded, though: an interactive job parked on `awaitHuman` holds the
    // worker for its full twenty-minute deadline, and a wedged one holds it
    // forever. Without this the process stops consuming the moment SIGTERM
    // arrives and then never exits — leaving a worker that looks alive, refuses
    // work, and survives every subsequent `pkill`.
    const forced = await Promise.race([
      worker.close(false).then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS)),
    ]);

    if (forced) {
      console.warn(
        `[worker] jobs still in flight after ${SHUTDOWN_GRACE_MS}ms, closing anyway; ` +
          'they are reclaimed by recoverOrphans() on the next boot',
      );
      await worker.close(true).catch(() => undefined);
    }
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
