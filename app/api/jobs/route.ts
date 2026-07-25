import { NextResponse } from 'next/server';
import { z } from 'zod';
import { JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { JobConflictError, JobValidationError, createPublishJob } from '@/lib/jobs/service';
import { serializeJob } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  accountId: z.string().min(1),
  videoId: z.string().min(1),
  caption: z.string().min(1).max(2_200),
  idempotencyKey: z.string().min(8).max(255).optional(),
  scheduledAt: z.string().datetime().optional(),
});

export const GET = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();
  const url = new URL(request.url);

  const statusParam = url.searchParams.get('status');
  const take = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);

  const status =
    statusParam && statusParam in JobStatus ? (statusParam as JobStatus) : undefined;

  const jobs = await prisma.job.findMany({
    where: { userId, ...(status ? { status } : {}) },
    include: { account: true, video: true },
    orderBy: { createdAt: 'desc' },
    take,
  });

  return NextResponse.json(jobs.map((job) => serializeJob(job)));
});

export const POST = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Expected a JSON body' }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: 'Invalid request', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Header takes precedence so clients can follow the conventional
  // Idempotency-Key contract without changing their payload.
  const headerKey = request.headers.get('idempotency-key') ?? undefined;

  try {
    const { job, created } = await createPublishJob({
      userId,
      accountId: parsed.data.accountId,
      videoId: parsed.data.videoId,
      caption: parsed.data.caption,
      idempotencyKey: headerKey ?? parsed.data.idempotencyKey,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
    });

    return NextResponse.json(
      {
        message: created ? 'Job queued' : 'Job already exists for this idempotency key',
        job: serializeJob(job),
      },
      { status: created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof JobConflictError) {
      return NextResponse.json(
        { message: error.message, existingJobId: error.existingJobId },
        { status: 409 },
      );
    }

    if (error instanceof JobValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    console.error('[api/jobs] create failed', error);
    return NextResponse.json({ message: 'Could not create job' }, { status: 500 });
  }
});
