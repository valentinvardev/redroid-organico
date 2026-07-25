import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { VideoStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { ingestVideo } from '@/lib/media/ingest';
import { isFfmpegAvailable } from '@/lib/media/probe';
import { getStorage } from '@/lib/media/storage';
import { createUser, reset, teardown } from '../helpers/harness';

const execFileAsync = promisify(execFile);

beforeEach(reset);
after(teardown);

/** Renders a real MP4 so the probe has something valid to read. */
async function renderVideo(args: { width: number; height: number; seconds: number }): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-test-'));
  const output = path.join(dir, 'clip.mp4');

  try {
    await execFileAsync(
      getEnv().FFMPEG_PATH,
      [
        '-y',
        '-f', 'lavfi',
        '-i', `testsrc=size=${args.width}x${args.height}:rate=30:duration=${args.seconds}`,
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        output,
      ],
      { timeout: 60_000 },
    );

    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('media ingest', () => {
  it('deduplicates a re-upload of identical bytes', async () => {
    const user = await createUser();
    const bytes = Buffer.from('not really a video, but stable bytes');

    const first = await ingestVideo({
      userId: user.id,
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      bytes,
    });

    const second = await ingestVideo({
      userId: user.id,
      fileName: 'renamed.mp4',
      mimeType: 'video/mp4',
      bytes,
    });

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.video.id, first.video.id);
    assert.equal(await prisma.video.count(), 1);
  });

  it('keeps uploads from different users separate even for identical bytes', async () => {
    const [a, b] = [await createUser(), await createUser()];
    const bytes = Buffer.from('shared bytes across tenants');

    const first = await ingestVideo({ userId: a.id, fileName: 'a.mp4', mimeType: 'video/mp4', bytes });
    const second = await ingestVideo({ userId: b.id, fileName: 'b.mp4', mimeType: 'video/mp4', bytes });

    assert.notEqual(second.video.id, first.video.id);
    assert.equal(second.deduplicated, false);
    assert.equal(await prisma.video.count(), 2);
  });

  it('writes the bytes to storage under the recorded key', async () => {
    const user = await createUser();
    const bytes = Buffer.from('bytes that must land in storage');

    const { video } = await ingestVideo({
      userId: user.id,
      fileName: 'stored.mp4',
      mimeType: 'video/mp4',
      bytes,
    });

    const storage = await getStorage();
    assert.equal(await storage.exists(video.storageKey), true);
  });

  it('rejects a file that is not parseable as video without raising a server error', async () => {
    const user = await createUser();

    // Regression guard: a probe failure used to be rethrown, turning a corrupt
    // upload into a 500 instead of a validation result.
    const { video, issues } = await ingestVideo({
      userId: user.id,
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('plain text masquerading as an upload'),
    });

    if (!(await isFfmpegAvailable())) {
      // Without ffprobe there is nothing to validate against; ingest accepts and
      // flags that, which is the documented behaviour.
      assert.equal(video.status, VideoStatus.READY);
      return;
    }

    assert.equal(video.status, VideoStatus.INVALID);
    assert.ok(
      issues.some((issue) => issue.field === 'file'),
      `expected an unreadable-file issue, got ${JSON.stringify(issues)}`,
    );
  });
});

describe('media validation against real files', () => {
  it('accepts a vertical clip and records its metadata and thumbnail', async (t) => {
    if (!(await isFfmpegAvailable())) {
      t.skip('ffmpeg/ffprobe not available');
      return;
    }

    const user = await createUser();
    const bytes = await renderVideo({ width: 1080, height: 1920, seconds: 2 });

    const { video, issues } = await ingestVideo({
      userId: user.id,
      fileName: 'vertical.mp4',
      mimeType: 'video/mp4',
      bytes,
    });

    assert.deepEqual(issues, [], `expected a clean bill of health, got ${JSON.stringify(issues)}`);
    assert.equal(video.status, VideoStatus.READY);
    assert.equal(video.width, 1080);
    assert.equal(video.height, 1920);
    assert.ok(video.durationSeconds && video.durationSeconds > 1.5);
    assert.ok(video.thumbnailKey, 'a thumbnail should have been generated');

    const storage = await getStorage();
    assert.equal(await storage.exists(video.thumbnailKey!), true);
  });

  it('flags a declared mime type the spec does not allow', async (t) => {
    if (!(await isFfmpegAvailable())) {
      t.skip('ffmpeg/ffprobe not available');
      return;
    }

    const user = await createUser();
    // Real, probeable video bytes so validation reaches the mime-type rule
    // instead of stopping at "cannot read this file".
    const bytes = await renderVideo({ width: 1080, height: 1920, seconds: 2 });

    const { video, issues } = await ingestVideo({
      userId: user.id,
      fileName: 'clip.avi',
      mimeType: 'video/x-msvideo',
      bytes,
    });

    assert.equal(video.status, VideoStatus.INVALID);
    assert.ok(
      issues.some((issue) => issue.field === 'mimeType'),
      `expected a mimeType issue, got ${JSON.stringify(issues)}`,
    );
  });

  it('rejects a clip whose aspect ratio is outside the accepted range', async (t) => {
    if (!(await isFfmpegAvailable())) {
      t.skip('ffmpeg/ffprobe not available');
      return;
    }

    const user = await createUser();
    // 1920x480 is far wider than the 1.8 maximum.
    const bytes = await renderVideo({ width: 1920, height: 480, seconds: 2 });

    const { video, issues } = await ingestVideo({
      userId: user.id,
      fileName: 'ultrawide.mp4',
      mimeType: 'video/mp4',
      bytes,
    });

    assert.equal(video.status, VideoStatus.INVALID);
    assert.ok(
      issues.some((issue) => issue.field === 'aspectRatio'),
      `expected an aspectRatio issue, got ${JSON.stringify(issues)}`,
    );
    assert.equal(video.thumbnailKey, null, 'an invalid video should not get a thumbnail');
  });
});
