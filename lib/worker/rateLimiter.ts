import { getEnv } from '@/lib/env';
import { getRedis } from '@/lib/queue/connection';

const SLOT_TTL_SECONDS = 15 * 60;

function slotsKey(accountId: string): string {
  return `acct:${accountId}:slots`;
}

function lastPublishKey(accountId: string): string {
  return `acct:${accountId}:lastPublish`;
}

export interface Reservation {
  ok: true;
  release: () => Promise<void>;
}

export interface Rejection {
  ok: false;
  /** How long the job should be delayed before trying again. */
  retryAfterMs: number;
  reason: 'max_concurrent' | 'min_interval';
}

/**
 * Two independent limits per account: how many jobs may be in flight at once,
 * and how long to wait after one finishes before starting the next. They are
 * enforced in Redis rather than in-process so that several worker replicas
 * share one budget.
 */
export async function reserve(
  accountId: string,
  limits: { maxConcurrent: number; minIntervalSeconds: number },
): Promise<Reservation | Rejection> {
  const redis = getRedis();

  if (limits.minIntervalSeconds > 0) {
    const last = await redis.get(lastPublishKey(accountId));

    if (last) {
      const elapsedMs = Date.now() - Number(last);
      const windowMs = limits.minIntervalSeconds * 1_000;

      if (Number.isFinite(elapsedMs) && elapsedMs < windowMs) {
        return { ok: false, retryAfterMs: windowMs - elapsedMs, reason: 'min_interval' };
      }
    }
  }

  const key = slotsKey(accountId);
  const inFlight = await redis.incr(key);

  // Bound the counter's lifetime so a worker killed mid-job cannot leak a slot
  // permanently; the reservation is refreshed while the job runs.
  await redis.expire(key, SLOT_TTL_SECONDS);

  if (inFlight > limits.maxConcurrent) {
    await redis.decr(key);
    return { ok: false, retryAfterMs: getEnv().RATE_LIMIT_DEFER_MS, reason: 'max_concurrent' };
  }

  let released = false;

  return {
    ok: true,
    release: async () => {
      if (released) {
        return;
      }

      released = true;
      const remaining = await redis.decr(key);

      if (remaining < 0) {
        await redis.set(key, 0);
      }

      await redis.set(lastPublishKey(accountId), Date.now().toString(), 'EX', SLOT_TTL_SECONDS);
    },
  };
}

/** Keeps a long-running job's slot from expiring out from under it. */
export async function touch(accountId: string): Promise<void> {
  await getRedis().expire(slotsKey(accountId), SLOT_TTL_SECONDS);
}

/**
 * Rewrites every account's in-flight counter from what the database says is
 * actually running.
 *
 * A worker killed without running `release()` leaves its slot counted. The TTL
 * bounds that to fifteen minutes, but for an account with maxConcurrent 1 those
 * are fifteen minutes of every job being deferred with no explanation beyond
 * "max_concurrent" — which reads like a limit working correctly.
 *
 * Run at startup, after recoverOrphans() has moved stranded rows out of the
 * running states, so the count it reads is trustworthy. Counting from the
 * database rather than tracking releases keeps this correct with several
 * workers: the answer does not depend on which process crashed.
 */
export async function reconcileAccountSlots(
  runningPerAccount: Map<string, number>,
  accountIds: string[],
): Promise<number> {
  const redis = getRedis();
  let corrected = 0;

  for (const accountId of accountIds) {
    const key = slotsKey(accountId);
    const stored = Number((await redis.get(key)) ?? 0);
    const actual = runningPerAccount.get(accountId) ?? 0;

    if (stored === actual) {
      continue;
    }

    if (actual === 0) {
      await redis.del(key);
    } else {
      await redis.set(key, actual, 'EX', SLOT_TTL_SECONDS);
    }

    corrected += 1;
  }

  return corrected;
}
