import { randomUUID } from 'crypto';
import { Prisma, type Job, JobStatus, JobType, SessionState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { jobLogger } from '@/lib/logging/jobLogger';
import { signalHumanDone } from '@/lib/onboarding/signal';
import { getPublishQueue, type PublishJobData } from '@/lib/queue/publishQueue';

export class JobConflictError extends Error {
  constructor(message: string, readonly existingJobId: string) {
    super(message);
    this.name = 'JobConflictError';
  }
}

export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobValidationError';
  }
}

const ACTIVE_STATUSES: JobStatus[] = [JobStatus.QUEUED, JobStatus.SCHEDULED, JobStatus.PROCESSING];

export interface CreatePublishJobInput {
  userId: string;
  accountId: string;
  videoId: string;
  caption: string;
  /**
   * Supplied by the client so that a retried or double-submitted request
   * resolves to the same job instead of creating a second publication.
   */
  idempotencyKey?: string;
  scheduledAt?: Date | null;

  /** Load-test tags, recorded on the row for the run report. Null for ordinary jobs. */
  runProfile?: string | null;
  regionLabel?: string | null;

  /**
   * Skips the "this video is already in flight for this account" guard, which
   * exists to stop a double-click from double-publishing. A load test does the
   * opposite on purpose — the same video, many times — so it opts out
   * explicitly rather than the guard being quietly weakened for everyone.
   */
  allowConcurrentDuplicate?: boolean;
}

export interface CreatePublishJobResult {
  job: Job;
  /** False when an existing job was returned for a repeated idempotency key. */
  created: boolean;
}

export async function createPublishJob(input: CreatePublishJobInput): Promise<CreatePublishJobResult> {
  const caption = input.caption.trim();

  if (caption.length === 0) {
    throw new JobValidationError('Caption must not be empty');
  }

  if (caption.length > 2_200) {
    throw new JobValidationError(`Caption is ${caption.length} characters, limit is 2200`);
  }

  if (input.scheduledAt && Number.isNaN(input.scheduledAt.getTime())) {
    throw new JobValidationError('scheduledAt is not a valid date');
  }

  const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();

  const existingByKey = await prisma.job.findUnique({ where: { idempotencyKey } });

  if (existingByKey) {
    return { job: existingByKey, created: false };
  }

  const [account, video] = await Promise.all([
    prisma.account.findFirst({ where: { id: input.accountId, userId: input.userId } }),
    prisma.video.findFirst({ where: { id: input.videoId, userId: input.userId } }),
  ]);

  if (!account) {
    throw new JobValidationError(`Account ${input.accountId} not found`);
  }

  if (account.status !== 'ACTIVE') {
    throw new JobValidationError(`Account ${account.name} is ${account.status.toLowerCase()}`);
  }

  // Refused here rather than in the worker. Without credentials the job is
  // guaranteed to fail, but only after booting a container and installing an
  // app — minutes of work to reach a conclusion available now.
  if (!account.credentials) {
    throw new JobValidationError(
      `Account ${account.name} has no credentials, so nothing tells the worker which app to drive. ` +
        'Configure it with `npm run account:add`.',
    );
  }

  if (!video) {
    throw new JobValidationError(`Video ${input.videoId} not found`);
  }

  if (video.status !== 'READY') {
    throw new JobValidationError(`Video is ${video.status.toLowerCase()}, expected READY`);
  }

  // A different request already publishing this video to this account is a
  // duplicate. Rows carrying *this* key are excluded deliberately: a concurrent
  // request with the same key may have committed between the lookup above and
  // here, and that is idempotency working, not a conflict — it falls through to
  // the create below, where the unique constraint resolves both callers to one
  // job. Without this exclusion the loser of that race gets a spurious 409.
  const inFlight = await prisma.job.findFirst({
    where: {
      accountId: account.id,
      videoId: video.id,
      status: { in: ACTIVE_STATUSES },
      idempotencyKey: { not: idempotencyKey },
    },
  });

  if (inFlight && !input.allowConcurrentDuplicate) {
    throw new JobConflictError(
      `Video ${video.id} is already ${inFlight.status.toLowerCase()} for this account`,
      inFlight.id,
    );
  }

  const scheduled = input.scheduledAt && input.scheduledAt.getTime() > Date.now();

  let job: Job;

  try {
    job = await prisma.job.create({
      data: {
        userId: input.userId,
        accountId: account.id,
        videoId: video.id,
        caption,
        idempotencyKey,
        status: scheduled ? JobStatus.SCHEDULED : JobStatus.QUEUED,
        scheduledAt: scheduled ? input.scheduledAt : null,
        runProfile: input.runProfile ?? null,
        regionLabel: input.regionLabel ?? null,
      },
    });
  } catch (error) {
    // Two concurrent requests carrying the same key: the loser reads the row
    // the winner just wrote instead of surfacing a constraint violation.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.job.findUnique({ where: { idempotencyKey } });

      if (winner) {
        return { job: winner, created: false };
      }
    }

    throw error;
  }

  await enqueue(job);

  return { job, created: true };
}

async function enqueue(job: Job): Promise<void> {
  const delay = job.scheduledAt ? Math.max(0, job.scheduledAt.getTime() - Date.now()) : 0;

  const queued = await getPublishQueue().add(
    'publish',
    { jobId: job.id } satisfies PublishJobData,
    {
      // Reusing the database id as the BullMQ id means an accidental re-enqueue
      // of the same job is dropped by Redis rather than processed twice.
      jobId: job.id,
      delay,
      // The row's own budget, not the queue default. An interactive onboarding
      // job is created with maxAttempts 1 on purpose — retrying it boots a
      // second device for an operator who is no longer watching — and the
      // default of 3 was overriding that, so every failure spawned another
      // container while processJob had already written the job off as FAILED.
      attempts: job.maxAttempts,
    },
  );

  await prisma.job.update({
    where: { id: job.id },
    data: { bullJobId: queued.id },
  });

  await jobLogger(job.id).info(
    delay > 0 ? 'Job scheduled' : 'Job queued',
    delay > 0 ? { scheduledAt: job.scheduledAt?.toISOString(), delayMs: delay } : undefined,
  );
}

export interface CreateOnboardingJobInput {
  userId: string;
  accountId: string;
  idempotencyKey?: string;
}

/**
 * Queues an interactive onboarding run: the worker will bring up a device, put
 * the app on screen, and wait for a person to log in.
 *
 * `maxAttempts: 1` on purpose. A retry would silently bring up a second device
 * that nobody is watching, and the operator whose tab timed out has no way to
 * know a new one is waiting for them.
 */
export async function createOnboardingJob(input: CreateOnboardingJobInput): Promise<CreatePublishJobResult> {
  const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();

  const existingByKey = await prisma.job.findUnique({ where: { idempotencyKey } });

  if (existingByKey) {
    return { job: existingByKey, created: false };
  }

  const account = await prisma.account.findFirst({
    where: { id: input.accountId, userId: input.userId },
  });

  if (!account) {
    throw new JobValidationError(`Account ${input.accountId} not found`);
  }

  if (account.status === 'INACTIVE') {
    throw new JobValidationError(`Account ${account.name} is inactive`);
  }

  // Two onboarding runs for one account would fight over the session volume,
  // and the second operator would be logging into a device that is about to be
  // destroyed.
  const inFlight = await prisma.job.findFirst({
    where: {
      accountId: account.id,
      status: { in: [...ACTIVE_STATUSES, JobStatus.AWAITING_HUMAN, JobStatus.VERIFYING] },
      idempotencyKey: { not: idempotencyKey },
    },
  });

  if (inFlight) {
    throw new JobConflictError(
      `Account ${account.name} already has a job ${inFlight.status.toLowerCase()}`,
      inFlight.id,
    );
  }

  // Self-heal: no job is running for this account, so an ONBOARDING session
  // state is a leftover from a run that died without cleaning up. Left alone it
  // is permanent — the dashboard refuses to start a link while the account
  // claims one is in progress, which is exactly when you need to start one.
  if (account.sessionState === SessionState.ONBOARDING) {
    await prisma.account.update({
      where: { id: account.id },
      data: { sessionState: SessionState.NONE },
    });
  }

  let job: Job;

  try {
    job = await prisma.job.create({
      data: {
        userId: input.userId,
        accountId: account.id,
        type: JobType.INTERACTIVE_ONBOARDING,
        videoId: null,
        caption: null,
        idempotencyKey,
        maxAttempts: 1,
        status: JobStatus.QUEUED,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.job.findUnique({ where: { idempotencyKey } });

      if (winner) {
        return { job: winner, created: false };
      }
    }

    throw error;
  }

  await enqueue(job);

  return { job, created: true };
}

/**
 * The person says they finished logging in. Writing the timestamp is what makes
 * this durable: the Redis nudge that follows only decides whether the worker
 * notices now or on its next poll a second later.
 */
export async function confirmOnboarding(userId: string, jobId: string): Promise<Job> {
  const job = await prisma.job.findFirst({ where: { id: jobId, userId } });

  if (!job) {
    throw new JobValidationError(`Job ${jobId} not found`);
  }

  if (job.type !== JobType.INTERACTIVE_ONBOARDING) {
    throw new JobValidationError('This job is not an interactive onboarding run');
  }

  if (job.status !== JobStatus.AWAITING_HUMAN) {
    throw new JobValidationError(
      `Job is ${job.status.toLowerCase()}; only a job awaiting a person can be confirmed`,
    );
  }

  if (job.humanConfirmedAt) {
    return job;
  }

  const updated = await prisma.job.update({
    where: { id: job.id },
    data: { humanConfirmedAt: new Date() },
  });

  await jobLogger(job.id).info('Operator reported the login as finished');

  // Best effort. The worker polls the column above, so a Redis outage delays
  // the teardown by a second rather than stranding a device.
  await signalHumanDone(job.id).catch((error) => {
    console.warn(`[jobs] could not push the onboarding signal for ${job.id}`, error);
  });

  return updated;
}

export async function cancelJob(userId: string, jobId: string): Promise<Job> {
  const job = await prisma.job.findFirst({ where: { id: jobId, userId } });

  if (!job) {
    throw new JobValidationError(`Job ${jobId} not found`);
  }

  // A job holding a device for a person is cancellable too — that is exactly
  // the "operator closed the tab" case, and the worker's wait notices the
  // status change on its next cycle and tears the device down.
  if (!ACTIVE_STATUSES.includes(job.status) && job.status !== JobStatus.AWAITING_HUMAN) {
    throw new JobValidationError(`Job is ${job.status.toLowerCase()} and cannot be cancelled`);
  }

  if (job.bullJobId) {
    const queued = await getPublishQueue().getJob(job.bullJobId);
    // A job already picked up by a worker cannot be removed; the worker checks
    // for CANCELLED before it publishes and aborts there.
    await queued?.remove().catch(() => undefined);
  }

  const updated = await prisma.job.update({
    where: { id: job.id },
    data: { status: JobStatus.CANCELLED, completedAt: new Date() },
  });

  await jobLogger(job.id).warn('Job cancelled by user');

  return updated;
}

export async function retryJob(userId: string, jobId: string): Promise<Job> {
  const job = await prisma.job.findFirst({ where: { id: jobId, userId } });

  if (!job) {
    throw new JobValidationError(`Job ${jobId} not found`);
  }

  if (job.status !== JobStatus.FAILED && job.status !== JobStatus.DEAD) {
    throw new JobValidationError(`Only failed jobs can be retried, this one is ${job.status.toLowerCase()}`);
  }

  const reset = await prisma.job.update({
    where: { id: job.id },
    data: {
      status: JobStatus.QUEUED,
      attempts: 0,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      scheduledAt: null,
    },
  });

  // The previous BullMQ record still occupies this id; drop it so the re-add
  // is not silently ignored as a duplicate.
  await getPublishQueue()
    .getJob(job.id)
    .then((existing) => existing?.remove())
    .catch(() => undefined);

  await jobLogger(job.id).info('Job re-queued manually');
  await enqueue(reset);

  return reset;
}
