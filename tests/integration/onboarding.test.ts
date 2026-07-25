import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JobStatus, JobType, SessionState } from '@prisma/client';
import { prisma } from '@/lib/db';
import { seal } from '@/lib/crypto/secretBox';
import { clearHumanSignal, signalHumanDone, waitForHuman } from '@/lib/onboarding/signal';
import { confirmOnboarding, createOnboardingJob, JobValidationError, cancelJob } from '@/lib/jobs/service';
import { processJob } from '@/lib/worker/processJob';
import { recoverOrphans } from '@/lib/worker/createWorker';
import type { OnboardingDriver, OnboardingRequest, OnboardingResult } from '@/lib/publisher/types';
import { createUser, reset, teardown } from '../helpers/harness';

// Root-level, so it runs after every describe in this file. Without it the
// Prisma and Redis connections stay open and the process never exits.
after(async () => {
  await teardown();
});

/**
 * Stands in for the Android driver: reports a device, then does whatever the
 * test tells it to while waiting. What matters is that it always calls
 * `awaitHuman()` and always records that it released the device.
 */
class ScriptedOnboardingDriver implements OnboardingDriver {
  readonly name = 'scripted';
  released = 0;
  deviceReported = 0;
  outcomeSeen?: string;

  constructor(private readonly verify: (confirmed: boolean) => OnboardingResult['outcome'] = () => 'verified') {}

  async onboard(request: OnboardingRequest): Promise<OnboardingResult> {
    try {
      await request.onDeviceReady({
        serial: 'redroid-job:5555',
        adbHost: 'adb-server',
        adbPort: 5037,
        viewerUrl: 'http://viewer.local/?serial=redroid-job%3A5555',
      });
      this.deviceReported += 1;

      const outcome = await request.awaitHuman();
      this.outcomeSeen = outcome.kind;

      if (outcome.kind === 'cancelled') {
        return { outcome: 'cancelled', details: outcome.reason };
      }

      if (outcome.kind === 'expired') {
        return { outcome: 'abandoned', details: outcome.reason };
      }

      return { outcome: this.verify(true), details: 'scripted' };
    } finally {
      // The real driver does this in a finally too; asserting on it here is how
      // the tests prove a device is never stranded.
      this.released += 1;
    }
  }
}

/** Lingers in the verification step so the VERIFYING status is observable. */
class SlowVerifyDriver implements OnboardingDriver {
  readonly name = 'slow-verify';

  async onboard(request: OnboardingRequest): Promise<OnboardingResult> {
    await request.onDeviceReady({ serial: 'redroid-job:5555' });
    await request.awaitHuman();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { outcome: 'verified', details: '@partner' };
  }
}

function bullJobFor(jobId: string) {
  return {
    data: { jobId },
    attemptsMade: 0,
    updateProgress: async () => undefined,
  } as unknown as Parameters<typeof processJob>[0];
}

let userId: string;
let accountId: string;

async function seedAccount() {
  const account = await prisma.account.create({
    data: {
      userId,
      name: 'Partner account',
      platform: 'SPORT_REELS',
      status: 'ACTIVE',
      credentials: seal({ appiumUrl: 'http://appium:4723', packageName: 'com.sportreels.app' }),
      maxConcurrent: 1,
      minIntervalSeconds: 0,
    },
  });

  return account.id;
}

describe('interactive onboarding', () => {
  before(async () => {
    await reset();
    userId = (await createUser()).id;
  });

  beforeEach(async () => {
    await prisma.job.deleteMany({});
    await prisma.account.deleteMany({});
    accountId = await seedAccount();
  });

  after(async () => {
    await reset();
  });

  it('queues an onboarding job with no video, no caption and a single attempt', async () => {
    const { job, created } = await createOnboardingJob({ userId, accountId });

    assert.equal(created, true);
    assert.equal(job.type, JobType.INTERACTIVE_ONBOARDING);
    assert.equal(job.videoId, null);
    assert.equal(job.caption, null);
    assert.equal(job.maxAttempts, 1, 'a second unattended device is worse than no device');
  });

  it('refuses a second onboarding while one is already waiting for a person', async () => {
    const { job } = await createOnboardingJob({ userId, accountId });
    await prisma.job.update({ where: { id: job.id }, data: { status: JobStatus.AWAITING_HUMAN } });

    await assert.rejects(createOnboardingJob({ userId, accountId }), /already has a job/);
  });

  it('publishes the device endpoint and parks the job in AWAITING_HUMAN', async () => {
    const { job } = await createOnboardingJob({ userId, accountId });
    const driver = new ScriptedOnboardingDriver();

    // Confirm as soon as the job starts waiting, so the run completes.
    const watcher = waitUntilAwaiting(job.id).then(async (row) => {
      assert.equal(row.status, JobStatus.AWAITING_HUMAN);
      assert.ok(row.awaitingSince, 'the UI shows how long the operator has been at it');
      assert.ok(row.expiresAt, 'an unattended session must have a deadline');

      const endpoint = row.deviceEndpoint as { serial: string; viewerUrl: string };
      assert.equal(endpoint.serial, 'redroid-job:5555');
      assert.match(endpoint.viewerUrl, /viewer\.local/);

      await confirmOnboarding(userId, job.id);
    });

    await processJob(bullJobFor(job.id), { onboardingDriver: driver });
    await watcher;

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

    assert.equal(finished.status, JobStatus.COMPLETED);
    assert.equal(finished.deviceEndpoint, null, 'the endpoint is dead once the container is gone');
    assert.equal(account.sessionState, SessionState.VERIFIED);
    assert.ok(account.sessionVerifiedAt);
    assert.equal(driver.released, 1);
  });

  it('tears the device down when the operator cancels instead of confirming', async () => {
    const { job } = await createOnboardingJob({ userId, accountId });
    const driver = new ScriptedOnboardingDriver();

    const watcher = waitUntilAwaiting(job.id).then(() => cancelJob(userId, job.id));

    await processJob(bullJobFor(job.id), { onboardingDriver: driver });
    await watcher;

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

    assert.equal(driver.outcomeSeen, 'cancelled');
    assert.equal(finished.status, JobStatus.CANCELLED);
    assert.equal(account.sessionState, SessionState.NONE, 'a cancelled login leaves no session');
    assert.equal(driver.released, 1, 'the container dies even though nobody confirmed');
  });

  it('leaves the account unverified when the app disagrees with the operator', async () => {
    const { job } = await createOnboardingJob({ userId, accountId });
    const driver = new ScriptedOnboardingDriver(() => 'unverified');

    const watcher = waitUntilAwaiting(job.id).then(() => confirmOnboarding(userId, job.id));

    await assert.rejects(processJob(bullJobFor(job.id), { onboardingDriver: driver }));
    await watcher;

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

    assert.equal(finished.status, JobStatus.FAILED);
    assert.match(finished.errorMessage ?? '', /did not verify/);
    assert.equal(account.sessionState, SessionState.NONE);
    assert.equal(driver.released, 1);
  });

  it('moves through VERIFYING so a job that dies mid-check is distinguishable', async () => {
    const { job } = await createOnboardingJob({ userId, accountId });
    const seen: string[] = [];

    // Watch the row while the run happens, rather than inferring the path from
    // the final state.
    const observer = (async () => {
      for (let i = 0; i < 400; i += 1) {
        const row = await prisma.job.findUnique({ where: { id: job.id }, select: { status: true } });

        if (row && seen[seen.length - 1] !== row.status) {
          seen.push(row.status);
        }

        if (row?.status === JobStatus.COMPLETED) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();

    const confirmer = waitUntilAwaiting(job.id).then(() => confirmOnboarding(userId, job.id));

    await processJob(bullJobFor(job.id), { onboardingDriver: new SlowVerifyDriver() });
    await confirmer;
    await observer;

    assert.ok(seen.includes(JobStatus.AWAITING_HUMAN), `expected AWAITING_HUMAN in ${seen.join(' -> ')}`);
    assert.ok(seen.includes(JobStatus.VERIFYING), `expected VERIFYING in ${seen.join(' -> ')}`);
    assert.ok(
      seen.indexOf(JobStatus.AWAITING_HUMAN) < seen.indexOf(JobStatus.VERIFYING),
      `wrong order: ${seen.join(' -> ')}`,
    );
  });

  it('fails a job stranded in AWAITING_HUMAN by a worker restart, and frees the account', async () => {
    const { job } = await createOnboardingJob({ userId, accountId });

    await prisma.job.update({ where: { id: job.id }, data: { status: JobStatus.AWAITING_HUMAN } });
    await prisma.account.update({
      where: { id: accountId },
      data: { sessionState: SessionState.ONBOARDING },
    });

    await recoverOrphans();

    const recovered = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

    // Re-queueing would boot a device for an operator whose tab is long gone.
    assert.equal(recovered.status, JobStatus.FAILED);
    assert.match(recovered.errorMessage ?? '', /restarted while waiting/);
    assert.equal(account.sessionState, SessionState.NONE, 'the account must be linkable again');
  });

  it('refuses to confirm a job that is not waiting for anyone', async () => {
    const { job } = await createOnboardingJob({ userId, accountId });

    await assert.rejects(confirmOnboarding(userId, job.id), JobValidationError);
  });
});

describe('waitForHuman', () => {
  const jobId = 'wait-test-job';

  beforeEach(async () => {
    await clearHumanSignal(jobId);
  });

  it('returns as soon as the signal is pushed, without polling for it', async () => {
    const started = Date.now();

    const waiting = waitForHuman(jobId, {
      timeoutMs: 10_000,
      blockSeconds: 0.2,
      signal: new AbortController().signal,
      readJob: async () => ({ status: JobStatus.AWAITING_HUMAN, humanConfirmedAt: null }),
    });

    setTimeout(() => void signalHumanDone(jobId), 150);

    const outcome = await waiting;

    assert.equal(outcome.kind, 'confirmed');
    assert.ok(Date.now() - started < 3_000, 'the blocking pop must return on the push, not on a timer');
  });

  it('still notices the confirmation when the Redis nudge was lost', async () => {
    let confirmed: Date | null = null;
    setTimeout(() => {
      confirmed = new Date();
    }, 100);

    // No signalHumanDone call at all: only the database column changes, which
    // is what happens when Redis is down at the moment of the click.
    const outcome = await waitForHuman(jobId, {
      timeoutMs: 10_000,
      blockSeconds: 0.2,
      signal: new AbortController().signal,
      readJob: async () => ({ status: JobStatus.AWAITING_HUMAN, humanConfirmedAt: confirmed }),
    });

    assert.equal(outcome.kind, 'confirmed');
  });

  it('gives up on a deadline, because a closed tab never sends anything', async () => {
    const outcome = await waitForHuman(jobId, {
      timeoutMs: 1_200,
      blockSeconds: 0.2,
      signal: new AbortController().signal,
      readJob: async () => ({ status: JobStatus.AWAITING_HUMAN, humanConfirmedAt: null }),
    });

    assert.equal(outcome.kind, 'expired');
  });

  it('returns promptly when the job is cancelled', async () => {
    let status: JobStatus = JobStatus.AWAITING_HUMAN;
    setTimeout(() => {
      status = JobStatus.CANCELLED;
    }, 100);

    const outcome = await waitForHuman(jobId, {
      timeoutMs: 30_000,
      blockSeconds: 0.2,
      signal: new AbortController().signal,
      readJob: async () => ({ status, humanConfirmedAt: null }),
    });

    assert.equal(outcome.kind, 'cancelled');
  });

  it('unblocks immediately when the worker is shutting down', async () => {
    const controller = new AbortController();
    const started = Date.now();

    setTimeout(() => controller.abort(), 100);

    const outcome = await waitForHuman(jobId, {
      timeoutMs: 30_000,
      blockSeconds: 0.2,
      signal: controller.signal,
      readJob: async () => ({ status: JobStatus.AWAITING_HUMAN, humanConfirmedAt: null }),
    });

    assert.equal(outcome.kind, 'cancelled');
    assert.ok(Date.now() - started < 3_000, 'shutdown must not wait out the blocking pop');
  });

  it('does not spin the event loop while it waits', async () => {
    // If the wait were a busy loop, a timer scheduled behind it would be
    // starved. This asserts the process stays responsive.
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 50);

    await waitForHuman(jobId, {
      timeoutMs: 900,
      blockSeconds: 0.2,
      signal: new AbortController().signal,
      readJob: async () => ({ status: JobStatus.AWAITING_HUMAN, humanConfirmedAt: null }),
    });

    clearInterval(ticker);
    assert.ok(ticks >= 8, `expected the event loop to stay free, only ${ticks} ticks ran`);
  });
});

async function waitUntilAwaiting(jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });

    if (job?.status === JobStatus.AWAITING_HUMAN) {
      return job;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Job ${jobId} never reached AWAITING_HUMAN`);
}
