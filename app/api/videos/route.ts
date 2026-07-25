import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { ingestVideo } from '@/lib/media/ingest';
import { DEFAULT_SPEC } from '@/lib/media/validate';
import { serializeVideo } from '@/lib/serialize';

export const dynamic = 'force-dynamic';
// Buffering a large upload in memory is what the ingest path does today. Beyond
// a few hundred MB this should become a presigned direct-to-storage upload with
// the server only receiving the resulting key.
export const maxDuration = 300;

export const GET = guarded(async () => {
  const userId = await getCurrentUserId();

  const videos = await prisma.video.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return NextResponse.json(videos.map(serializeVideo));
});

export const POST = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();

  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ message: 'Expected a multipart/form-data body' }, { status: 400 });
  }

  const file = form.get('file');

  if (!(file instanceof File)) {
    return NextResponse.json({ message: 'Field "file" is required' }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ message: 'File is empty' }, { status: 400 });
  }

  if (file.size > DEFAULT_SPEC.maxSizeBytes) {
    return NextResponse.json(
      {
        message: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB, limit is ${(
          DEFAULT_SPEC.maxSizeBytes / 1024 / 1024
        ).toFixed(0)} MB`,
      },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  try {
    const { video, issues, deduplicated } = await ingestVideo({
      userId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      bytes,
    });

    return NextResponse.json(
      { video: serializeVideo(video), issues, deduplicated },
      { status: deduplicated ? 200 : 201 },
    );
  } catch (error) {
    console.error('[api/videos] ingest failed', error);

    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Ingest failed' },
      { status: 500 },
    );
  }
});
