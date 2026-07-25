import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { JobStatus } from '@prisma/client';
import type { Job as BullJob } from 'bullmq';
import { prisma } from '@/lib/db';
import { open as openSecret } from '@/lib/crypto/secretBox';
import { jobLogger } from '@/lib/logging/jobLogger';
import { getStorage } from '@/lib/media/storage';
import { isRetryable, retryAfterMs } from '@/lib/publisher/errors';
import { getPublisher } from '@/lib/publisher/registry';
import type { Publisher } from '@/lib/publisher/types';
import type { PublishJobData } from '@/lib/queue/publishQueue';
import { reserve, touch } from './rateLimiter';

const JOB_TIMEOUT_MS = 15 * 60 * 1_000;
const HEARTBEAT_MS = 60 * 1_000;

/** Thrown to make BullMQ re-deliver the job after a delay without burning an attempt. */
export class DeferJobError extends Error {
  constructor(readonly delayMs: number, message: string) {
    super(message);
    this.name = 'DeferJobError';
  }
}

/**
 * `publisher` is injectable so integration tests can drive the retry, DLQ and
 * rate-limit paths with an adapter that fails on demand, instead of depending on
 * whatever PUBLISHER_DRIVER happens to be configured.
 */
export async function processJob(
  bullJob: BullJob<PublishJobData>,
  publisher: Publisher = getPublisher(),
): Promise<void> {
  const { jobId } = bullJob.data;
  const log = jobLogger(jobId);

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { account: true, video: true },
  });

  if (!job) {
    // The row was deleted after enqueueing. Nothing to publish and nothing to
    // retry; swallow it so the queue does not spin on a job that cannot exist.
    console.warn(`[worker] job ${jobId} no longer exists, discarding`);
    return;
  }

  if (job.status === JobStatus.CANCELLED) {
    await log.warn('Job was cancelled before the worker started it');
    return;
  }

  if (job.status === JobStatus.COMPLETED) {
    // A duplicate delivery of an already-published job. Returning without
    // republishing is the whole point of tracking status in the database.
    await log.warn('Job is already completed, skipping duplicate delivery');
    return;
  }

  const reservation = await reserve(job.accountId, {
    maxConcurrent: job.account.maxConcurrent,
    minIntervalSeconds: job.account.minIntervalSeconds,
  });

  if (!reservation.ok) {
    await log.info(`Deferred by account rate limit (${reservation.reason})`, {
      retryAfterMs: reservation.retryAfterMs,
    });

    throw new DeferJobError(reservation.retryAfterMs, `Rate limited: ${reservation.reason}`);
  }

  const attempt = (bullJob.attemptsMade ?? 0) + 1;

  await prisma.job.update({
    where: { id: job.id },
    data: { status: JobStatus.PROCESSING, startedAt: job.startedAt ?? new Date(), attempts: attempt },
  });

  await log.info(`Attempt ${attempt}/${job.maxAttempts} started`);

  const scratch = await mkdtemp(path.join(tmpdir(), `job-${job.id}-`));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
  const heartbeat = setInterval(() => {
    void touch(job.accountId);
    void bullJob.updateProgress({ jobId: job.id, attempt }).catch(() => undefined);
  }, HEARTBEAT_MS);

  try {
    const localPath = path.join(scratch, job.video.fileName || 'video.mp4');

    await log.debug('Staging media from storage', { storageKey: job.video.storageKey });
    const storage = await getStorage();
    await storage.download(job.video.storageKey, localPath);

    const result = await publisher.publish({
      jobId: job.id,
      caption: job.caption,
      account: {
        id: job.account.id,
        name: job.account.name,
        platform: job.account.platform,
        externalId: job.account.externalId,
        credentials: job.account.credentials ? openSecret(job.account.credentials) : null,
      },
      video: {
        id: job.video.id,
        localPath,
        fileName: job.video.fileName,
        mimeType: job.video.mimeType,
        sizeBytes: Number(job.video.sizeBytes),
        durationSeconds: job.video.durationSeconds,
        width: job.video.width,
        height: job.video.height,
      },
      log,
      signal: controller.signal,
    });

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.COMPLETED,
        completedAt: new Date(),
        externalPostId: result.externalPostId,
        errorMessage: null,
      },
    });

    await log.info('Published successfully', {
      externalPostId: result.externalPostId,
      url: result.url,
    });
  } catch (error) {
    await handleFailure({ jobId: job.id, attempt, maxAttempts: job.maxAttempts, error });
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    await reservation.release();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function handleFailure(input: {
  jobId: string;
  attempt: number;
  maxAttempts: number;
  error: unknown;
}): Promise<void> {
  const { jobId, attempt, maxAttempts, error } = input;
  const log = jobLogger(jobId);
  const message = error instanceof Error ? error.message : String(error);

  const retryable = isRetryable(error);
  const exhausted = attempt >= maxAttempts;
  const final = !retryable || exhausted;

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: final ? JobStatus.FAILED : JobStatus.QUEUED,
      errorMessage: message.slice(0, 5_000),
      completedAt: final ? new Date() : null,
    },
  });

  if (final) {
    await log.error(retryable ? `Failed after ${attempt} attempts` : 'Failed permanently', {
      error: message,
      retryable,
    });
  } else {
    await log.warn(`Attempt ${attempt} failed, will retry`, {
      error: message,
      retryAfterMs: retryAfterMs(error),
    });
  }
}
