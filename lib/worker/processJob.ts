import { mkdir, mkdtemp, rm } from 'fs/promises';
import path from 'path';
import { JobStatus, JobType, Prisma, SessionState } from '@prisma/client';
import type { Job as BullJob } from 'bullmq';
import { prisma } from '@/lib/db';
import { open as openSecret } from '@/lib/crypto/secretBox';
import { getEnv } from '@/lib/env';
import { jobLogger, type JobLogger } from '@/lib/logging/jobLogger';
import { getStorage } from '@/lib/media/storage';
import { clearHumanSignal, waitForHuman } from '@/lib/onboarding/signal';
import { openProxy } from '@/lib/proxy/service';
import { isRetryable, permanent, retryAfterMs } from '@/lib/publisher/errors';
import { getOnboardingDriver, getPublisher } from '@/lib/publisher/registry';
import type {
  DeviceEndpoint,
  OnboardingDriver,
  OnboardingResult,
  PublisherAccount,
  Publisher,
} from '@/lib/publisher/types';
import type { PublishJobData } from '@/lib/queue/publishQueue';
import { reserve, touch } from './rateLimiter';

const PUBLISH_TIMEOUT_MS = 15 * 60 * 1_000;
const HEARTBEAT_MS = 60 * 1_000;

/** Thrown to make BullMQ re-deliver the job after a delay without burning an attempt. */
export class DeferJobError extends Error {
  constructor(readonly delayMs: number, message: string) {
    super(message);
    this.name = 'DeferJobError';
  }
}

export interface ProcessJobDeps {
  publisher?: Publisher;
  onboardingDriver?: OnboardingDriver;
}

type JobWithRelations = Prisma.JobGetPayload<{
  include: { account: { include: { proxy: true } }; video: true };
}>;

/**
 * `publisher` and `onboardingDriver` are injectable so integration tests can
 * drive the retry, DLQ and rate-limit paths with an adapter that fails on
 * demand, instead of depending on whatever PUBLISHER_DRIVER is configured.
 */
export async function processJob(
  bullJob: BullJob<PublishJobData>,
  deps: ProcessJobDeps | Publisher = {},
): Promise<void> {
  // Historically this parameter was the publisher itself. Accepting both keeps
  // the existing call sites working.
  const resolved: ProcessJobDeps =
    typeof (deps as Publisher).publish === 'function' ? { publisher: deps as Publisher } : (deps as ProcessJobDeps);

  const { jobId } = bullJob.data;
  const log = jobLogger(jobId);

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    // The proxy comes along with the account: which egress a run uses is
    // decided by the row, at the moment the job starts, not by anything the
    // driver is configured with.
    include: { account: { include: { proxy: true } }, video: true },
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

  // Onboarding takes the same per-account slot as publishing: both mount the
  // account's session volume, and two of them at once would corrupt it.
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
  const interactive = job.type === JobType.INTERACTIVE_ONBOARDING;

  await prisma.job.update({
    where: { id: job.id },
    data: { status: JobStatus.PROCESSING, startedAt: job.startedAt ?? new Date(), attempts: attempt },
  });

  await log.info(`Attempt ${attempt}/${job.maxAttempts} started`, { type: job.type });

  const controller = new AbortController();
  // An interactive job is idle by design for as long as a person takes; giving
  // it the publish timeout would abort it while someone is mid-login.
  const timeoutMs = interactive ? getEnv().ONBOARDING_TIMEOUT_MS + 60_000 : PUBLISH_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const heartbeat = setInterval(() => {
    void touch(job.accountId);
    void bullJob.updateProgress({ jobId: job.id, attempt }).catch(() => undefined);
  }, HEARTBEAT_MS);

  try {
    if (interactive) {
      await runOnboarding(job, resolved.onboardingDriver ?? getOnboardingDriver(), log, controller.signal);
    } else {
      await runPublish(job, resolved.publisher ?? getPublisher(), log, controller.signal);
    }
  } catch (error) {
    await handleFailure({ jobId: job.id, attempt, maxAttempts: job.maxAttempts, error });
    throw error;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    await reservation.release();
  }
}

function publisherAccount(job: JobWithRelations): PublisherAccount {
  return {
    id: job.account.id,
    name: job.account.name,
    platform: job.account.platform,
    externalId: job.account.externalId,
    credentials: job.account.credentials ? openSecret(job.account.credentials) : null,
    proxy: job.account.proxy ? openProxy(job.account.proxy) : null,
  };
}

async function runPublish(
  job: JobWithRelations,
  publisher: Publisher,
  log: JobLogger,
  signal: AbortSignal,
): Promise<void> {
  // The type says these are optional because onboarding jobs carry neither.
  // Re-checking here rather than trusting the type keeps a malformed row from
  // reaching a driver that would deref null.
  if (!job.video || job.caption === null) {
    throw permanent(
      'incomplete_publish_job',
      `Job ${job.id} is a ${job.type} job but has no ${job.video ? 'caption' : 'video'}`,
    );
  }

  // Deliberately not os.tmpdir(): see MEDIA_STAGING_DIR in lib/env.ts.
  const stagingRoot = path.resolve(process.cwd(), getEnv().MEDIA_STAGING_DIR);
  await mkdir(stagingRoot, { recursive: true });

  const scratch = await mkdtemp(path.join(stagingRoot, `job-${job.id}-`));

  try {
    const localPath = path.join(scratch, job.video.fileName || 'video.mp4');

    await log.debug('Staging media from storage', { storageKey: job.video.storageKey });
    const storage = await getStorage();
    await storage.download(job.video.storageKey, localPath);

    const result = await publisher.publish({
      jobId: job.id,
      caption: job.caption,
      account: publisherAccount(job),
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
      signal,
    });

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.COMPLETED,
        completedAt: new Date(),
        externalPostId: result.externalPostId,
        errorMessage: null,
        // Only overwrite when the driver measured; a driver that reports no
        // metrics should not blank a value the enqueuer may have pre-seeded.
        ...(result.metrics ? { metrics: result.metrics as Prisma.InputJsonValue } : {}),
      },
    });

    await log.info('Published successfully', {
      externalPostId: result.externalPostId,
      url: result.url,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The interactive path. The worker's contribution is to make a device exist and
 * then get out of the way; the driver decides when it is done by asking
 * `awaitHuman()`, which is the callback wired here.
 */
async function runOnboarding(
  job: JobWithRelations,
  driver: OnboardingDriver,
  log: JobLogger,
  signal: AbortSignal,
): Promise<void> {
  const timeoutMs = getEnv().ONBOARDING_TIMEOUT_MS;

  // A signal left over from an earlier run of this id would be consumed
  // instantly and end the wait before anyone saw the screen.
  await clearHumanSignal(job.id);

  await prisma.account.update({
    where: { id: job.accountId },
    data: { sessionState: SessionState.ONBOARDING },
  });

  let result: OnboardingResult;

  try {
    result = await driver.onboard({
      jobId: job.id,
      account: publisherAccount(job),
      log,
      signal,

      onDeviceReady: async (endpoint: DeviceEndpoint) => {
        // Publishing the endpoint and flipping the status are one step: the UI
        // polls for AWAITING_HUMAN and would otherwise read a status with no
        // endpoint next to it.
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: JobStatus.AWAITING_HUMAN,
            deviceEndpoint: endpoint as unknown as Prisma.InputJsonValue,
            awaitingSince: new Date(),
            expiresAt: new Date(Date.now() + timeoutMs),
          },
        });

        await log.info('Device is ready for the operator', {
          serial: endpoint.serial,
          viewerUrl: endpoint.viewerUrl,
        });
      },

      awaitHuman: async () => {
        const outcome = await waitForHuman(job.id, { timeoutMs, signal });

        // The natural seam for the transition: the person is done and the
        // driver is about to run the verification flow. Anything else ends the
        // job, so there is nothing to announce.
        if (outcome.kind === 'confirmed') {
          await prisma.job.update({
            where: { id: job.id },
            data: { status: JobStatus.VERIFYING },
          });
        }

        return outcome;
      },
    });
  } catch (error) {
    // A throw here — a container that never booted, a missing app — skips
    // finishOnboarding entirely and would leave the account ONBOARDING for
    // good. The dashboard disables linking in that state, so a single crashed
    // run made the account permanently unusable.
    await prisma.account
      .update({ where: { id: job.accountId }, data: { sessionState: SessionState.NONE } })
      .catch(() => undefined);

    throw error;
  }

  await finishOnboarding(job, result.outcome, result.details);
}

async function finishOnboarding(
  job: JobWithRelations,
  outcome: 'verified' | 'unverified' | 'abandoned' | 'cancelled',
  details: string | undefined,
): Promise<void> {
  const log = jobLogger(job.id);

  if (outcome === 'verified') {
    await prisma.$transaction([
      prisma.account.update({
        where: { id: job.accountId },
        data: { sessionState: SessionState.VERIFIED, sessionVerifiedAt: new Date() },
      }),
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.COMPLETED,
          completedAt: new Date(),
          errorMessage: null,
          deviceEndpoint: Prisma.DbNull,
        },
      }),
    ]);

    await log.info('Account session verified', { details });
    return;
  }

  // Anything else leaves the account where it was: an unverified login, an
  // abandoned tab and a cancellation are all "we still do not have a working
  // session", and claiming otherwise is what this whole design exists to avoid.
  await prisma.account.update({
    where: { id: job.accountId },
    data: { sessionState: SessionState.NONE },
  });

  const status = outcome === 'cancelled' ? JobStatus.CANCELLED : JobStatus.FAILED;
  const message =
    outcome === 'unverified'
      ? `Operator confirmed but the session did not verify: ${details ?? 'no details'}`
      : outcome === 'abandoned'
        ? `Nobody completed the login: ${details ?? 'timed out'}`
        : `Onboarding cancelled: ${details ?? 'no reason given'}`;

  await prisma.job.update({
    where: { id: job.id },
    data: {
      status,
      completedAt: new Date(),
      errorMessage: message.slice(0, 5_000),
      deviceEndpoint: Prisma.DbNull,
    },
  });

  await log.warn('Onboarding did not produce a verified session', { outcome, details });

  // Only a genuine failure should reach the retry machinery. A cancellation is
  // the operator's decision and an abandoned session will not go better on a
  // second unattended attempt.
  if (outcome === 'unverified') {
    throw permanent('onboarding_not_verified', message);
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

  const current = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });

  // finishOnboarding already wrote the terminal status and a better message
  // than the exception carries; overwriting it here would lose that.
  if (current && (current.status === JobStatus.CANCELLED || current.status === JobStatus.FAILED)) {
    return;
  }

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
