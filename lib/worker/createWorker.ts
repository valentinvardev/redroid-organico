import { DelayedError, UnrecoverableError, Worker, type Job as BullJob } from 'bullmq';
import { JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { jobLogger } from '@/lib/logging/jobLogger';
import { isRetryable } from '@/lib/publisher/errors';
import { getPublisher } from '@/lib/publisher/registry';
import type { Publisher } from '@/lib/publisher/types';
import { getRedis } from '@/lib/queue/connection';
import {
  PUBLISH_QUEUE,
  getDeadLetterQueue,
  getPublishQueue,
  type PublishJobData,
} from '@/lib/queue/publishQueue';
import { DeferJobError, processJob } from './processJob';

/**
 * Two ways a job ends up in the database with nothing in Redis to drive it:
 *
 *   - PROCESSING: a worker was killed mid-job, so the row stays PROCESSING
 *     forever. This is the failure the old in-process worker had no answer for.
 *   - QUEUED / SCHEDULED: the row was committed but the subsequent `queue.add`
 *     failed (Redis down between the two calls), so it was never enqueued.
 *
 * Both are reconciled by comparing against BullMQ and re-adding whatever Redis
 * does not already know about. Returns how many jobs were recovered.
 */
export async function recoverOrphans(): Promise<number> {
  const candidates = await prisma.job.findMany({
    where: { status: { in: [JobStatus.PROCESSING, JobStatus.QUEUED, JobStatus.SCHEDULED] } },
  });

  if (candidates.length === 0) {
    return 0;
  }

  const queue = getPublishQueue();
  let recovered = 0;

  for (const job of candidates) {
    const existing = await queue.getJob(job.id);
    const state = await existing?.getState().catch(() => undefined);

    if (state === 'active' || state === 'waiting' || state === 'delayed') {
      continue;
    }

    const wasProcessing = job.status === JobStatus.PROCESSING;

    // A scheduled job keeps its original delay rather than firing immediately
    // just because the worker happened to restart before its time came.
    const delay = job.scheduledAt ? Math.max(0, job.scheduledAt.getTime() - Date.now()) : 0;

    await prisma.job.update({
      where: { id: job.id },
      data: { status: delay > 0 ? JobStatus.SCHEDULED : JobStatus.QUEUED, startedAt: null },
    });

    await existing?.remove().catch(() => undefined);
    await queue.add('publish', { jobId: job.id } satisfies PublishJobData, { jobId: job.id, delay });

    await jobLogger(job.id).warn(
      wasProcessing
        ? 'Recovered after worker restart, re-queued'
        : 'Found in the database but not in the queue, re-queued',
    );

    recovered += 1;
  }

  return recovered;
}

export async function toDeadLetter(jobId: string, reason: string): Promise<void> {
  // Park the job before marking it DEAD. If this order were reversed, a failure
  // here would leave the row DEAD with no record in the parking lot — dead and
  // untraceable. This way a failure leaves it FAILED, which retryJob accepts
  // and which the dashboard still surfaces as actionable.
  //
  // The id separator is '-', not ':': BullMQ rejects custom ids containing a
  // colon because it uses one as its own Redis key separator.
  await getDeadLetterQueue().add(
    'dead',
    { jobId, reason, failedAt: new Date().toISOString() },
    { jobId: `${jobId}-${Date.now()}` },
  );

  await prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.DEAD, completedAt: new Date(), errorMessage: reason.slice(0, 5_000) },
  });

  await jobLogger(jobId).error('Moved to dead-letter queue', { reason });
}

export interface CreateWorkerOptions {
  publisher?: Publisher;
  concurrency?: number;
  /** Silences the per-job console output that is only useful in a real deployment. */
  quiet?: boolean;
}

export function createPublishWorker(options: CreateWorkerOptions = {}): Worker<PublishJobData> {
  const publisher = options.publisher ?? getPublisher();
  const concurrency = options.concurrency ?? getEnv().WORKER_CONCURRENCY;
  const log = options.quiet ? () => undefined : console.log.bind(console);
  const warn = options.quiet ? () => undefined : console.warn.bind(console);

  const worker = new Worker<PublishJobData>(
    PUBLISH_QUEUE,
    async (bullJob, token) => {
      try {
        await processJob(bullJob, publisher);
      } catch (error) {
        if (error instanceof DeferJobError) {
          // Rate-limited: push the job into the future without consuming an
          // attempt, so throttling never exhausts a job's retry budget.
          await bullJob.moveToDelayed(Date.now() + error.delayMs, token);
          throw new DelayedError(error.message);
        }

        if (!isRetryable(error)) {
          throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
        }

        throw error;
      }
    },
    {
      connection: getRedis(),
      concurrency,
      // Below the 15-minute job timeout, so a genuinely hung job is reclaimed
      // rather than holding a slot until the process restarts.
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on('completed', (bullJob) => {
    log(`[worker] completed ${bullJob.data.jobId}`);
  });

  worker.on('failed', async (bullJob, error) => {
    if (!bullJob) {
      console.error('[worker] job failed before it could be loaded', error);
      return;
    }

    const attemptsMade = bullJob.attemptsMade ?? 0;
    const allowed = bullJob.opts.attempts ?? 1;
    const permanent = !isRetryable(error) || error.name === 'UnrecoverableError';

    if (permanent || attemptsMade >= allowed) {
      await toDeadLetter(bullJob.data.jobId, error.message).catch((cause) => {
        console.error(`[worker] failed to dead-letter ${bullJob.data.jobId}`, cause);
      });
    } else {
      warn(`[worker] attempt ${attemptsMade}/${allowed} failed for ${bullJob.data.jobId}: ${error.message}`);
    }
  });

  worker.on('error', (error) => {
    console.error('[worker] worker error', error);
  });

  return worker;
}
