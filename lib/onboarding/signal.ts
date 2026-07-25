import IORedis from 'ioredis';
import { JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';

/** How the wait ended. Only `confirmed` means a person actually finished. */
export type HumanOutcome =
  | { kind: 'confirmed'; at: Date }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'expired'; reason: string };

function signalKey(jobId: string): string {
  return `onboarding:signal:${jobId}`;
}

/**
 * A list, not a pub/sub channel, and that is the whole point: pub/sub delivers
 * to whoever happens to be listening at that instant. The worker spends part of
 * every cycle not listening — between two blocking pops, or reconnecting — and a
 * message published in that window would be gone forever, stranding a live
 * container until it timed out. A list holds the value until someone takes it.
 */
const SIGNAL_TTL_SECONDS = 3_600;

/** Two seconds of block per cycle: fast enough to notice a cancel, cheap enough to ignore. */
const BLOCK_SECONDS = 2;

export interface WaitOptions {
  timeoutMs: number;
  signal: AbortSignal;
  /** Overridable in tests; production reads the job row. */
  readJob?: (jobId: string) => Promise<{ status: JobStatus; humanConfirmedAt: Date | null } | null>;
  /**
   * How long each blocking pop waits before the loop re-checks the database.
   * It bounds how late a cancellation is noticed, so tests shorten it; in
   * production two seconds is already imperceptible next to a human login.
   */
  blockSeconds?: number;
  onTick?: () => void;
}

async function defaultReadJob(jobId: string) {
  return prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, humanConfirmedAt: true },
  });
}

/**
 * Wakes the worker holding `jobId`. Called from the HTTP request the person
 * triggered, in a different process.
 *
 * The database write is the authoritative record and happens first; the Redis
 * push is only an optimisation that turns a two-second wait into an immediate
 * one. If Redis is down the worker still notices on its next poll.
 */
export async function signalHumanDone(jobId: string): Promise<void> {
  const client = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 2 });

  try {
    await client.rpush(signalKey(jobId), JSON.stringify({ kind: 'confirmed', at: new Date().toISOString() }));
    await client.expire(signalKey(jobId), SIGNAL_TTL_SECONDS);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

/** Removes a stale signal so a re-run of the same job id cannot consume it. */
export async function clearHumanSignal(jobId: string): Promise<void> {
  const client = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 2 });

  try {
    await client.del(signalKey(jobId));
  } catch {
    // A leftover signal is harmless: the job id is unique per run.
  } finally {
    await client.quit().catch(() => undefined);
  }
}

/**
 * Blocks the *job*, not the process. `BLPOP` is asynchronous I/O on a dedicated
 * connection: the event loop stays free, other jobs on the same worker keep
 * running, and nothing spins.
 *
 * A dedicated connection is required because a blocking command monopolises the
 * one it runs on — sharing the BullMQ connection would stall the queue itself.
 *
 * Three ways out, checked every cycle:
 *   - the person confirmed (Redis push, or the humanConfirmedAt column if the
 *     push was lost)
 *   - the job was cancelled, or the worker is shutting down
 *   - the deadline passed, because a closed browser tab never sends anything
 */
export async function waitForHuman(jobId: string, options: WaitOptions): Promise<HumanOutcome> {
  const readJob = options.readJob ?? defaultReadJob;
  const deadline = Date.now() + options.timeoutMs;
  const client = new IORedis(getEnv().REDIS_URL, {
    // The blocking pop must be allowed to sit; the default retry limit aborts
    // it mid-wait with "Reached the max retries per request limit".
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const onAbort = () => {
    // Frees the pending BLPOP immediately instead of waiting out its timeout.
    client.disconnect();
  };

  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      if (options.signal.aborted) {
        return { kind: 'cancelled', reason: 'The worker is shutting down' };
      }

      const job = await readJob(jobId);

      if (!job) {
        return { kind: 'cancelled', reason: 'The job no longer exists' };
      }

      if (job.humanConfirmedAt) {
        return { kind: 'confirmed', at: job.humanConfirmedAt };
      }

      if (job.status === JobStatus.CANCELLED) {
        return { kind: 'cancelled', reason: 'Cancelled from the dashboard' };
      }

      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        return {
          kind: 'expired',
          reason: `Nobody confirmed within ${Math.round(options.timeoutMs / 1_000)}s`,
        };
      }

      options.onTick?.();

      const configured = options.blockSeconds ?? BLOCK_SECONDS;
      const blockSeconds = Math.min(configured, Math.max(configured, remainingMs / 1_000));

      let popped: [string, string] | null = null;

      try {
        popped = await client.blpop(signalKey(jobId), blockSeconds);
      } catch (error) {
        if (options.signal.aborted) {
          return { kind: 'cancelled', reason: 'The worker is shutting down' };
        }

        // Redis hiccuped. The database poll above is the safety net, so keep
        // looping rather than failing a job with a live device attached.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }

      if (popped) {
        return { kind: 'confirmed', at: new Date() };
      }
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    await client.quit().catch(() => client.disconnect());
  }
}
