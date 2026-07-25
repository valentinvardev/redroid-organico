import { Queue, QueueEvents } from 'bullmq';
import { getEnv } from '@/lib/env';
import { getRedis } from './connection';

export const PUBLISH_QUEUE = 'publish';
export const DEAD_LETTER_QUEUE = 'publish-dead';

export interface PublishJobData {
  jobId: string;
}

export interface DeadLetterJobData {
  jobId: string;
  reason: string;
  failedAt: string;
}

const globalForQueue = globalThis as typeof globalThis & {
  __publishQueue?: Queue<PublishJobData>;
  __deadLetterQueue?: Queue<DeadLetterJobData>;
};

/**
 * Backoff is exponential from RETRY_BACKOFF_MS: with the 15s default that is
 * 15s, 60s, 240s. Publishing is not latency-sensitive, and a platform that just
 * refused an upload is better left alone for a minute than hammered three times
 * in ten seconds.
 */
export function retryPolicy() {
  const env = getEnv();

  return {
    attempts: env.RETRY_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: env.RETRY_BACKOFF_MS },
  };
}

export function getPublishQueue(): Queue<PublishJobData> {
  if (!globalForQueue.__publishQueue) {
    globalForQueue.__publishQueue = new Queue<PublishJobData>(PUBLISH_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        ...retryPolicy(),
        removeOnComplete: { age: 24 * 3_600, count: 1_000 },
        // Keep failures around longer than successes: they are what gets
        // inspected, and the DLQ record points back at them.
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    });
  }

  return globalForQueue.__publishQueue;
}

export function getDeadLetterQueue(): Queue<DeadLetterJobData> {
  if (!globalForQueue.__deadLetterQueue) {
    globalForQueue.__deadLetterQueue = new Queue<DeadLetterJobData>(DEAD_LETTER_QUEUE, {
      connection: getRedis(),
      // Nothing consumes this queue; it is an inspectable parking lot for jobs
      // that exhausted their attempts. Entries are replayed from the dashboard.
      defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
    });
  }

  return globalForQueue.__deadLetterQueue;
}

export function createQueueEvents(): QueueEvents {
  return new QueueEvents(PUBLISH_QUEUE, { connection: getRedis() });
}
