import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

/**
 * Exercises the parts of the pipeline that need neither Postgres nor Redis, so
 * a broken crypto envelope or validation rule fails here rather than inside a
 * worker. Run with: npm run smoke
 */
process.env.CREDENTIALS_KEY ??= randomBytes(32).toString('base64');
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  const { seal, open, safeEqual } = await import('../lib/crypto/secretBox');
  const { validateMedia, DEFAULT_SPEC } = await import('../lib/media/validate');
  const { isRetryable, permanent, rateLimited, retryAfterMs, transient } = await import(
    '../lib/publisher/errors'
  );

  await test('credential envelope round-trips', () => {
    const secret = { accessToken: 'abc123', refreshToken: 'def456', expiresIn: 3600 };
    const sealed = seal(secret);

    assert.ok(Buffer.isBuffer(sealed));
    assert.ok(sealed.length > 28, 'envelope should carry iv + tag + body');
    assert.deepEqual(open(sealed), secret);
  });

  await test('envelope is non-deterministic', () => {
    const a = seal({ token: 'same' });
    const b = seal({ token: 'same' });
    assert.notEqual(a.toString('base64'), b.toString('base64'), 'iv must be random per seal');
  });

  await test('tampered envelope is rejected', () => {
    const sealed = seal({ token: 'secret' });
    sealed[sealed.length - 1] ^= 0xff;
    assert.throws(() => open(sealed));
  });

  await test('truncated envelope is rejected', () => {
    assert.throws(() => open(Buffer.alloc(8)));
  });

  await test('safeEqual compares correctly', () => {
    assert.equal(safeEqual('token', 'token'), true);
    assert.equal(safeEqual('token', 'other'), false);
    assert.equal(safeEqual('token', 'tok'), false);
  });

  await test('valid 9:16 video passes validation', () => {
    const issues = validateMedia({
      mimeType: 'video/mp4',
      sizeBytes: 12 * 1024 * 1024,
      metadata: {
        durationSeconds: 21.5,
        width: 1080,
        height: 1920,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrate: 4_500_000,
      },
    });

    assert.deepEqual(issues, [], `expected no issues, got ${JSON.stringify(issues)}`);
  });

  await test('oversized, too-long, wrong-codec video is rejected', () => {
    const issues = validateMedia({
      mimeType: 'video/x-msvideo',
      sizeBytes: DEFAULT_SPEC.maxSizeBytes + 1,
      metadata: {
        durationSeconds: DEFAULT_SPEC.maxDurationSeconds + 10,
        width: 100,
        height: 100,
        videoCodec: 'mpeg4',
        audioCodec: 'mp3',
        bitrate: 1_000,
      },
    });

    const fields = issues.map((issue) => issue.field).sort();
    assert.deepEqual(fields, ['dimensions', 'duration', 'mimeType', 'sizeBytes', 'videoCodec']);
  });

  await test('missing video stream is reported', () => {
    const issues = validateMedia({
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      metadata: {
        durationSeconds: 5,
        width: null,
        height: null,
        videoCodec: null,
        audioCodec: 'aac',
        bitrate: null,
      },
    });

    assert.ok(issues.some((issue) => issue.field === 'dimensions'));
  });

  await test('retry classification drives the worker correctly', () => {
    assert.equal(isRetryable(permanent('bad_caption', 'nope')), false);
    assert.equal(isRetryable(transient('network', 'timeout')), true);
    // An unclassified throw is assumed transient rather than silently dropped.
    assert.equal(isRetryable(new Error('who knows')), true);
    assert.equal(retryAfterMs(rateLimited('slow down', 45_000)), 45_000);
    assert.equal(retryAfterMs(transient('network', 'timeout')), undefined);
  });

  const failed = results.filter((result) => !result.ok);

  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
  }

  console.log(`\n${results.length - failed.length}/${results.length} passed`);

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
