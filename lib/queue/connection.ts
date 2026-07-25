import IORedis, { type Redis } from 'ioredis';
import { getEnv } from '@/lib/env';

const globalForRedis = globalThis as typeof globalThis & {
  __redis?: Redis;
};

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection its workers
 * block on; with the default, a blocking BRPOPLPUSH is aborted mid-wait and the
 * worker dies with "Reached the max retries per request limit".
 */
export function getRedis(): Redis {
  if (globalForRedis.__redis) {
    return globalForRedis.__redis;
  }

  const connection = new IORedis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  connection.on('error', (error) => {
    console.error('[redis] connection error', error.message);
  });

  globalForRedis.__redis = connection;
  return connection;
}

export async function closeRedis(): Promise<void> {
  const connection = globalForRedis.__redis;

  if (!connection) {
    return;
  }

  globalForRedis.__redis = undefined;
  await connection.quit();
}
