import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  JobConflictError,
  JobValidationError,
  cancelJob,
  createPublishJob,
  retryJob,
} from '@/lib/jobs/service';
import { getPublishQueue } from '@/lib/queue/publishQueue';
import { createAccount, createUser, createVideo, reset, seedFixture, teardown } from '../helpers/harness';

// File-scoped, so connections are closed once after every describe has run
// rather than after the first one.
beforeEach(reset);
after(teardown);

describe('job creation', () => {
  it('creates a queued job and enqueues it in BullMQ under the row id', async () => {
    const { user, account, video } = await seedFixture();

    const { job, created } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'hello',
    });

    assert.equal(created, true);
    assert.equal(job.status, JobStatus.QUEUED);

    const queued = await getPublishQueue().getJob(job.id);
    assert.ok(queued, 'job should exist in the queue');
    assert.equal(queued.data.jobId, job.id);
  });

  it('returns the same job for a repeated idempotency key instead of publishing twice', async () => {
    const { user, account, video } = await seedFixture();
    const idempotencyKey = randomUUID();

    const first = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'hello',
      idempotencyKey,
    });

    const second = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'totally different caption',
      idempotencyKey,
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.job.id, first.job.id);
    // The second call's caption must not have overwritten the first.
    assert.equal(second.job.caption, 'hello');
    assert.equal(await prisma.job.count(), 1);
  });

  it('collapses concurrent requests carrying the same idempotency key into one job', async () => {
    const { user, account, video } = await seedFixture();
    const idempotencyKey = randomUUID();

    const input = {
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'concurrent',
      idempotencyKey,
    };

    // Both calls race the unique constraint; the loser must read the winner's
    // row rather than surfacing a P2002.
    const results = await Promise.all([
      createPublishJob(input),
      createPublishJob(input),
      createPublishJob(input),
    ]);

    const ids = new Set(results.map((result) => result.job.id));
    assert.equal(ids.size, 1, 'all callers should observe one job');
    assert.equal(results.filter((result) => result.created).length, 1, 'exactly one should have created it');
    assert.equal(await prisma.job.count(), 1);
  });

  it('rejects a second job for the same video and account while one is in flight', async () => {
    const { user, account, video } = await seedFixture();

    await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'first',
    });

    await assert.rejects(
      () =>
        createPublishJob({
          userId: user.id,
          accountId: account.id,
          videoId: video.id,
          caption: 'second',
          idempotencyKey: randomUUID(),
        }),
      JobConflictError,
    );

    assert.equal(await prisma.job.count(), 1);
  });

  it('allows the same video many times when the caller opts in, for load testing', async () => {
    const { user, account, video } = await seedFixture();

    for (let n = 0; n < 3; n += 1) {
      const { created } = await createPublishJob({
        userId: user.id,
        accountId: account.id,
        videoId: video.id,
        caption: `load ${n}`,
        idempotencyKey: randomUUID(),
        allowConcurrentDuplicate: true,
        runProfile: 'upload',
        regionLabel: 'de',
      });
      assert.equal(created, true);
    }

    assert.equal(await prisma.job.count(), 3, 'the in-flight guard is bypassed on request');

    const tagged = await prisma.job.findMany({ where: { runProfile: 'upload', regionLabel: 'de' } });
    assert.equal(tagged.length, 3, 'the load-test tags are recorded on the row');
  });

  it('refuses a video that has not passed validation', async () => {
    const user = await createUser();
    const account = await createAccount(user.id);
    const video = await createVideo(user.id, { status: 'INVALID' });

    await assert.rejects(
      () =>
        createPublishJob({
          userId: user.id,
          accountId: account.id,
          videoId: video.id,
          caption: 'should not queue',
        }),
      JobValidationError,
    );
  });

  it('refuses an account belonging to a different user', async () => {
    const owner = await seedFixture();
    const stranger = await createUser();

    await assert.rejects(
      () =>
        createPublishJob({
          userId: stranger.id,
          accountId: owner.account.id,
          videoId: owner.video.id,
          caption: 'not mine',
        }),
      JobValidationError,
    );
  });

  it('schedules a future job as SCHEDULED with a matching queue delay', async () => {
    const { user, account, video } = await seedFixture();
    const scheduledAt = new Date(Date.now() + 60_000);

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'later',
      scheduledAt,
    });

    assert.equal(job.status, JobStatus.SCHEDULED);

    const queued = await getPublishQueue().getJob(job.id);
    assert.ok(queued);
    assert.ok(queued.opts.delay && queued.opts.delay > 50_000, `expected a ~60s delay, got ${queued.opts.delay}`);
  });
});

describe('job cancellation and retry', () => {
  it('cancels a queued job and removes it from the queue', async () => {
    const { user, account, video } = await seedFixture();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'cancel me',
    });

    const cancelled = await cancelJob(user.id, job.id);

    assert.equal(cancelled.status, JobStatus.CANCELLED);
    assert.equal(await getPublishQueue().getJob(job.id), undefined);
  });

  it('will not cancel a job that already finished', async () => {
    const { user, account, video } = await seedFixture();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'done',
    });

    await prisma.job.update({ where: { id: job.id }, data: { status: JobStatus.COMPLETED } });

    await assert.rejects(() => cancelJob(user.id, job.id), JobValidationError);
  });

  it('re-queues a failed job with its attempt counter reset', async () => {
    const { user, account, video } = await seedFixture();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'retry me',
    });

    await prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.FAILED, attempts: 3, errorMessage: 'boom' },
    });

    const retried = await retryJob(user.id, job.id);

    assert.equal(retried.status, JobStatus.QUEUED);
    assert.equal(retried.attempts, 0);
    assert.equal(retried.errorMessage, null);

    // The stale BullMQ record must be replaced, not left to shadow the new one.
    const queued = await getPublishQueue().getJob(job.id);
    assert.ok(queued, 'a fresh queue entry should exist');
  });

  it('refuses to retry a job that is still queued', async () => {
    const { user, account, video } = await seedFixture();

    const { job } = await createPublishJob({
      userId: user.id,
      accountId: account.id,
      videoId: video.id,
      caption: 'in flight',
    });

    await assert.rejects(() => retryJob(user.id, job.id), JobValidationError);
  });
});
