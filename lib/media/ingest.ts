import { createHash, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { writeFile } from 'fs/promises';
import { Prisma, VideoStatus, type Video } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getStorage } from './storage';
import { extractThumbnail, isFfmpegAvailable, probe } from './probe';
import { DEFAULT_SPEC, validateMedia, type ValidationIssue } from './validate';

export interface IngestInput {
  userId: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

export interface IngestResult {
  video: Video;
  issues: ValidationIssue[];
  /** True when an identical upload already existed and was reused. */
  deduplicated: boolean;
}

export async function ingestVideo(input: IngestInput): Promise<IngestResult> {
  const checksum = createHash('sha256').update(input.bytes).digest('hex');

  const existing = await prisma.video.findFirst({
    where: { userId: input.userId, checksumSha256: checksum },
  });

  if (existing) {
    return { video: existing, issues: [], deduplicated: true };
  }

  const extension = path.extname(input.fileName).toLowerCase() || '.mp4';
  const storageKey = `videos/${input.userId}/${randomUUID()}${extension}`;
  const storage = await getStorage();

  await storage.put(storageKey, input.bytes);

  const video = await createVideoRecord({
    userId: input.userId,
    fileName: path.basename(input.fileName),
    storageKey,
    storageDriver: storage.name,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
    checksum,
  });

  // Probing needs a real path on disk, so the bytes are staged in a temp dir
  // that is removed regardless of how validation turns out.
  const scratch = await mkdtemp(path.join(tmpdir(), 'ingest-'));
  const localPath = path.join(scratch, `source${extension}`);

  try {
    await writeFile(localPath, input.bytes);

    if (!(await isFfmpegAvailable())) {
      // Without ffprobe there is nothing to validate against; the video is
      // accepted and flagged so the gap is visible rather than silent.
      const accepted = await prisma.video.update({
        where: { id: video.id },
        data: {
          status: VideoStatus.READY,
          validationErrors: [
            { field: 'ffprobe', message: 'ffprobe unavailable, media was not validated' },
          ] as Prisma.InputJsonValue,
        },
      });

      return { video: accepted, issues: [], deduplicated: false };
    }

    let metadata;

    try {
      metadata = await probe(localPath);
    } catch (cause) {
      // A file ffprobe cannot parse is an invalid upload, not a server error.
      // Rethrowing here turned a corrupt or non-video file into a 500.
      const message = cause instanceof Error ? cause.message : String(cause);
      const issues = [
        { field: 'file', message: 'File could not be read as video' },
      ];

      const rejected = await prisma.video.update({
        where: { id: video.id },
        data: {
          status: VideoStatus.INVALID,
          validationErrors: [
            ...issues,
            { field: 'probe', message: message.slice(0, 500) },
          ] as unknown as Prisma.InputJsonValue,
        },
      });

      return { video: rejected, issues, deduplicated: false };
    }

    const issues = validateMedia(
      { mimeType: input.mimeType, sizeBytes: input.bytes.byteLength, metadata },
      DEFAULT_SPEC,
    );

    let thumbnailKey: string | null = null;

    if (issues.length === 0) {
      thumbnailKey = await buildThumbnail(scratch, localPath, storageKey);
    }

    const updated = await prisma.video.update({
      where: { id: video.id },
      data: {
        status: issues.length === 0 ? VideoStatus.READY : VideoStatus.INVALID,
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        thumbnailKey,
        validationErrors: issues.length > 0 ? (issues as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });

    return { video: updated, issues, deduplicated: false };
  } catch (error) {
    // Unparseable media is handled above, so anything reaching here is an
    // infrastructure failure — disk, storage or the database. The row is flagged
    // so it cannot sit in VALIDATING forever, but the error propagates: the
    // caller should see a 500, not a validation result.
    await prisma.video
      .update({
        where: { id: video.id },
        data: {
          status: VideoStatus.INVALID,
          validationErrors: [
            {
              field: 'ingest',
              message: `Ingest failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
            },
          ] as unknown as Prisma.InputJsonValue,
        },
      })
      // If the database is what broke, this update fails too; do not mask the
      // original error with a secondary one.
      .catch(() => undefined);

    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function buildThumbnail(scratch: string, localPath: string, storageKey: string): Promise<string | null> {
  const thumbnailPath = path.join(scratch, 'thumb.jpg');

  try {
    await extractThumbnail(localPath, thumbnailPath);
    const key = `${storageKey.replace(/\.[^.]+$/, '')}-thumb.jpg`;
    const storage = await getStorage();
    await storage.put(key, await readFile(thumbnailPath));
    return key;
  } catch {
    // A missing thumbnail is cosmetic; it must not fail an otherwise valid upload.
    return null;
  }
}

async function createVideoRecord(data: {
  userId: string;
  fileName: string;
  storageKey: string;
  storageDriver: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
}): Promise<Video> {
  try {
    return await prisma.video.create({
      data: {
        userId: data.userId,
        fileName: data.fileName,
        storageKey: data.storageKey,
        storageDriver: data.storageDriver,
        mimeType: data.mimeType,
        sizeBytes: BigInt(data.sizeBytes),
        checksumSha256: data.checksum,
        status: VideoStatus.VALIDATING,
      },
    });
  } catch (error) {
    // Concurrent uploads of the same bytes race on the (userId, checksum)
    // unique index; the loser reuses the winner's row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await prisma.video.findFirst({
        where: { userId: data.userId, checksumSha256: data.checksum },
      });

      if (winner) {
        return winner;
      }
    }

    throw error;
  }
}
