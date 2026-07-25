import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Worker } from 'bullmq';
import { JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { createPublishJob } from '@/lib/jobs/service';
import type { Publisher } from '@/lib/publisher/types';
import { getDeadLetterQueue, getPublishQueue } from '@/lib/queue/publishQueue';
import { createPublishWorker, recoverOrphans } from '@/lib/worker/createWorker';
import {
  createAccount,
  createUser,
  createVideo,
  createVideoWithMissingFile,
  reset,
  seedFixture,
  teardown,
  waitFor,
} from '../helpers/harness';
import {
  AlwaysTransientPublisher,
  BlockingPublisher,
  FlakyPublisher,
  PermanentFailurePublisher,
  RecordingPublisher,
} from '../helpers/publishers';

let worker: Worker | undefined;

async function startWorker(publisher: Publisher, concurrency = 4) {
  worker = createPublishWorker({ publisher, concurrency, quiet: true });
  await worker.waitUntilReady();
  return worker;
}

async function status(jobId: string): Promise<JobStatus> {
  const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  return job.status;
}

async function reachedTerminal(jobId: string, expected: JobStatus): Promise<void> {
  await waitFor(async () => (await status(jobId)) === expected, {
    timeoutMs: 20_000,
    label: `job ${jobId} to reach ${expected}`,
  });
}

beforeEach(reset);

afterEach(async () => {
  if (worker) {
    await worker.close(true);
    worker = undefined;
  }
});

after(teardown);

describe('worker: happy path', () => {
  it('publishes a queued job and records the external post id', async () => {
    const { user, account, video } = await seedFixture();
    const publisher = new RecordingPublisher();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'ship it',
    });

    await startWorker(publisher);
    await reachedTerminal(job.id, JobStatus.COMPLETED);

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(publisher.calls.length, 1);
    assert.match(finished.externalPostId ?? '', /^rec_/);
    assert.equal(finished.errorMessage, null);
    assert.ok(finished.completedAt);
  });

  it('does not republish a job that is already COMPLETED when the queue re-delivers it', async () => {
    const { user, account, video } = await seedFixture();
    const publisher = new RecordingPublisher();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'already done',
    });

    // Mark it finished behind the worker's back, then let the queue deliver it.
    await prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.COMPLETED, externalPostId: 'pre-existing' },
    });

    await startWorker(publisher);

    await waitFor(async () => (await getPublishQueue().getJobCounts('active')).active === 0, {
      label: 'the queue to drain',
    });

    assert.equal(publisher.calls.length, 0, 'publisher must not be called for a completed job');
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.externalPostId, 'pre-existing');
  });

  it('skips a job cancelled before the worker picked it up', async () => {
    const { user, account, video } = await seedFixture();
    const publisher = new RecordingPublisher();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'cancelled',
    });

    await prisma.job.update({ where: { id: job.id }, data: { status: JobStatus.CANCELLED } });
    await startWorker(publisher);

    await waitFor(async () => (await getPublishQueue().getJobCounts('active')).active === 0, {
      label: 'the queue to drain',
    });

    assert.equal(publisher.calls.length, 0);
    assert.equal(await status(job.id), JobStatus.CANCELLED);
  });
});

describe('worker: retries and the dead-letter queue', () => {
  it('exhausts its retry budget, marks the job DEAD and parks it in the DLQ', async () => {
    const { user, account, video } = await seedFixture();
    const publisher = new AlwaysTransientPublisher();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'doomed',
    });

    await startWorker(publisher);
    await reachedTerminal(job.id, JobStatus.DEAD);

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

    assert.equal(publisher.attempts, 3, 'should have tried exactly the configured number of attempts');
    assert.equal(finished.attempts, 3);
    assert.match(finished.errorMessage ?? '', /synthetic transient failure/);

    const parked = await getDeadLetterQueue().getJobs(['waiting', 'active', 'completed', 'failed']);
    assert.equal(parked.length, 1, 'the job should be parked exactly once');
    assert.equal(parked[0]?.data.jobId, job.id);
    // Regression guard: BullMQ rejects custom ids containing a colon, which
    // silently emptied this queue before.
    assert.ok(!parked[0]?.id?.includes(':'), 'dead-letter job id must not contain a colon');

    const logs = await prisma.jobLog.findMany({ where: { jobId: job.id } });
    assert.ok(
      logs.some((log) => log.message.includes('Moved to dead-letter queue')),
      'the parking should be recorded in the job log',
    );
  });

  it('does not retry a permanent failure', async () => {
    const { user, account, video } = await seedFixture();
    const publisher = new PermanentFailurePublisher();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'bad credentials',
    });

    await startWorker(publisher);
    await reachedTerminal(job.id, JobStatus.DEAD);

    assert.equal(publisher.attempts, 1, 'a non-retryable error must be attempted once');
  });

  it('recovers on a later attempt when the failure was transient', async () => {
    const { user, account, video } = await seedFixture();
    const publisher = new FlakyPublisher(2);

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'third time lucky',
    });

    await startWorker(publisher);
    await reachedTerminal(job.id, JobStatus.COMPLETED);

    assert.equal(publisher.attempts, 3);

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.match(finished.externalPostId ?? '', /^flaky_/);
    assert.equal(finished.errorMessage, null, 'a recovered job should not keep its error');
  });

  it('fails the job instead of crashing the worker when the media is missing', async () => {
    const user = await createUser();
    const account = await createAccount(user.id);
    const video = await createVideoWithMissingFile(user.id);
    const publisher = new RecordingPublisher();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'no bytes',
    });

    await startWorker(publisher);
    await reachedTerminal(job.id, JobStatus.DEAD);

    // Regression guard: an unhandled stream 'error' used to take the whole
    // process down here rather than failing this one job.
    assert.equal(publisher.calls.length, 0, 'publishing should never have been reached');
    assert.equal(worker?.isRunning(), true, 'the worker must still be alive');

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.match(finished.errorMessage ?? '', /ENOENT|no such file/i);
  });
});

describe('worker: per-account rate limiting', () => {
  it('defers a job past maxConcurrent without consuming a retry attempt', async () => {
    const user = await createUser();
    const account = await createAccount(user.id, { maxConcurrent: 1, minIntervalSeconds: 0 });
    const first = await createVideo(user.id);
    const second = await createVideo(user.id);

    const publisher = new BlockingPublisher();

    const a = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: first.id,
      caption: 'holds the slot',
    });

    const b = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: second.id,
      caption: 'must wait',
    });

    await startWorker(publisher, 4);

    // One job occupies the only slot; the other must be deferred rather than run.
    await waitFor(async () => publisher.started === 1, { label: 'the first job to start' });

    await waitFor(
      async () => {
        const logs = await prisma.jobLog.findMany({ where: { jobId: b.job.id } });
        return logs.some((log) => log.message.includes('Deferred by account rate limit'));
      },
      { label: 'the second job to be deferred' },
    );

    const deferred = await prisma.job.findUniqueOrThrow({ where: { id: b.job.id } });
    assert.equal(
      deferred.attempts,
      0,
      'throttling must not burn a retry attempt — that is what made this worth testing',
    );

    publisher.unblock();

    await reachedTerminal(a.job.id, JobStatus.COMPLETED);
    await reachedTerminal(b.job.id, JobStatus.COMPLETED);

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: b.job.id } });
    assert.equal(finished.attempts, 1, 'the deferred job should still have used only one attempt');
  });
});

describe('worker: orphan recovery', () => {
  it('re-queues a PROCESSING row that has no counterpart in the queue', async () => {
    const { user, account, video } = await seedFixture();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'orphaned',
    });

    // Simulate a worker killed mid-job: the row says PROCESSING, Redis has
    // nothing driving it.
    await getPublishQueue().getJob(job.id).then((entry) => entry?.remove());
    await prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.PROCESSING, startedAt: new Date() },
    });

    const recovered = await recoverOrphans();

    assert.equal(recovered, 1);
    assert.equal(await status(job.id), JobStatus.QUEUED);
    assert.ok(await getPublishQueue().getJob(job.id), 'it should be back in the queue');

    const logs = await prisma.jobLog.findMany({ where: { jobId: job.id } });
    assert.ok(logs.some((log) => log.message.includes('Recovered after worker restart')));

    // And it must actually run once a worker comes up.
    const publisher = new RecordingPublisher();
    await startWorker(publisher);
    await reachedTerminal(job.id, JobStatus.COMPLETED);
    assert.equal(publisher.calls.length, 1);
  });

  it('re-queues a QUEUED row that never made it into the queue', async () => {
    const { user, account, video } = await seedFixture();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'never enqueued',
    });

    // Simulate `queue.add` having failed after the row was committed.
    await getPublishQueue().getJob(job.id).then((entry) => entry?.remove());

    assert.equal(await recoverOrphans(), 1);

    const logs = await prisma.jobLog.findMany({ where: { jobId: job.id } });
    assert.ok(logs.some((log) => log.message.includes('not in the queue')));
  });

  it('leaves a healthy queued job alone', async () => {
    const { user, account, video } = await seedFixture();

    await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'perfectly fine',
    });

    assert.equal(await recoverOrphans(), 0, 'a job Redis already knows about must not be touched');
  });

  it('preserves the original delay of a scheduled job', async () => {
    const { user, account, video } = await seedFixture();
    const scheduledAt = new Date(Date.now() + 120_000);

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'much later',
      scheduledAt,
    });

    await getPublishQueue().getJob(job.id).then((entry) => entry?.remove());

    assert.equal(await recoverOrphans(), 1);
    assert.equal(await status(job.id), JobStatus.SCHEDULED);

    const requeued = await getPublishQueue().getJob(job.id);
    assert.ok(
      requeued?.opts.delay && requeued.opts.delay > 100_000,
      `a recovered scheduled job must not fire immediately, delay was ${requeued?.opts.delay}`,
    );
  });
});
