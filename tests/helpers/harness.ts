import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { VideoStatus, type Account, type User, type Video } from '@prisma/client';
import { prisma } from '@/lib/db';
import { seal } from '@/lib/crypto/secretBox';
import { getEnv } from '@/lib/env';
import { getRedis } from '@/lib/queue/connection';
import { getStorage } from '@/lib/media/storage';

/**
 * Guards against a suite that was launched without --env-file pointing at the
 * test environment: reset() truncates tables and flushes Redis, so running it
 * against the dev database would destroy real data.
 */
function assertTestEnvironment(): void {
  const { DATABASE_URL, REDIS_URL } = getEnv();

  if (!/_test(\?|$)/.test(DATABASE_URL)) {
    throw new Error(
      `Refusing to run: DATABASE_URL must point at a database whose name ends in _test, got "${DATABASE_URL}". ` +
        'Run via `npm run test:integration`.',
    );
  }

  // flushdb() wipes whichever logical database the connection selected, so the
  // suite must never be pointed at db 0 where the dev queue lives.
  const redisDb = new URL(REDIS_URL).pathname.replace(/^\//, '');

  if (redisDb === '' || redisDb === '0') {
    throw new Error(
      `Refusing to run: REDIS_URL must select a non-zero logical database (e.g. .../1), got "${REDIS_URL}".`,
    );
  }
}

/** Wipes all application tables and the test Redis database. */
export async function reset(): Promise<void> {
  assertTestEnvironment();

  // TRUNCATE ... CASCADE in one statement so foreign keys never block the order.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "job_logs", "jobs", "videos", "accounts", "proxies", "sessions", "users" RESTART IDENTITY CASCADE',
  );

  await getRedis().flushdb();
}

export async function createUser(overrides: Partial<User> = {}): Promise<User> {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${randomUUID()}@test.local`,
      name: overrides.name ?? 'Test User',
      passwordHash: overrides.passwordHash ?? null,
    },
  });
}

export async function createAccount(
  userId: string,
  overrides: Partial<Account> = {},
): Promise<Account> {
  return prisma.account.create({
    data: {
      userId,
      name: overrides.name ?? 'Test Account',
      platform: 'TIKTOK',
      status: overrides.status ?? 'ACTIVE',
      // Sealed by default. `createPublishJob` refuses an account with none —
      // queueing a job that cannot possibly run is not something to discover
      // inside a worker — and a fixture that skipped this made six suites fail
      // on a precondition none of them were testing.
      //
      // `in` rather than `??` so a test can still ask for an account with no
      // credentials by passing null explicitly.
      credentials:
        'credentials' in overrides ? overrides.credentials : seal({ driver: 'stub', note: 'test fixture' }),
      // Wide open by default so a test that is not about throttling is not
      // accidentally slowed down by it.
      maxConcurrent: overrides.maxConcurrent ?? 10,
      minIntervalSeconds: overrides.minIntervalSeconds ?? 0,
    },
  });
}

/**
 * Creates a READY video whose bytes actually exist in storage, because the
 * worker stages the file from storage before publishing.
 */
export async function createVideo(userId: string, overrides: Partial<Video> = {}): Promise<Video> {
  const storageKey = overrides.storageKey ?? `videos/${userId}/${randomUUID()}.mp4`;
  const bytes = Buffer.from(`fake-mp4-${randomUUID()}`);

  const storage = await getStorage();
  await storage.put(storageKey, bytes);

  return prisma.video.create({
    data: {
      userId,
      fileName: overrides.fileName ?? 'test.mp4',
      storageKey,
      storageDriver: storage.name,
      mimeType: 'video/mp4',
      sizeBytes: BigInt(bytes.byteLength),
      durationSeconds: 12,
      width: 1080,
      height: 1920,
      checksumSha256: randomUUID(),
      status: overrides.status ?? VideoStatus.READY,
    },
  });
}

/** A video row whose bytes are absent from storage, so staging fails. */
export async function createVideoWithMissingFile(userId: string): Promise<Video> {
  return prisma.video.create({
    data: {
      userId,
      fileName: 'missing.mp4',
      storageKey: `videos/${userId}/${randomUUID()}-missing.mp4`,
      storageDriver: 'local',
      mimeType: 'video/mp4',
      sizeBytes: BigInt(1_024),
      durationSeconds: 5,
      width: 1080,
      height: 1920,
      checksumSha256: randomUUID(),
      status: VideoStatus.READY,
    },
  });
}

export async function seedFixture() {
  const user = await createUser();
  const account = await createAccount(user.id);
  const video = await createVideo(user.id);

  return { user, account, video };
}

export async function writeLocalFile(relativePath: string, bytes: Buffer): Promise<string> {
  const full = path.resolve(process.cwd(), getEnv().STORAGE_LOCAL_DIR, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
  return full;
}

/** Polls `check` until it returns true or the timeout elapses. */
export async function waitFor(
  check: () => Promise<boolean>,
  { timeoutMs = 30_000, intervalMs = 150, label = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function teardown(): Promise<void> {
  await prisma.$disconnect();
  const { closeRedis } = await import('@/lib/queue/connection');
  await closeRedis();
}
