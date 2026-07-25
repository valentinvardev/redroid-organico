import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { JobValidationError, cancelJob } from '@/lib/jobs/service';
import { serializeJob } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

type Context = { params: { id: string } };

export const GET = guarded(async (_request: Request, { params }: Context) => {
  const userId = await getCurrentUserId();

  const job = await prisma.job.findFirst({
    where: { id: params.id, userId },
    include: {
      account: true,
      video: true,
      logs: { orderBy: { createdAt: 'asc' }, take: 500 },
    },
  });

  if (!job) {
    return NextResponse.json({ message: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json(serializeJob(job));
});

export const DELETE = guarded(async (_request: Request, { params }: Context) => {
  const userId = await getCurrentUserId();

  try {
    const job = await cancelJob(userId, params.id);
    return NextResponse.json({ message: 'Job cancelled', job: serializeJob(job) });
  } catch (error) {
    if (error instanceof JobValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    console.error('[api/jobs/:id] cancel failed', error);
    return NextResponse.json({ message: 'Could not cancel job' }, { status: 500 });
  }
});
