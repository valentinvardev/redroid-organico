import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { JobValidationError, retryJob } from '@/lib/jobs/service';
import { serializeJob } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export const POST = guarded(async (_request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();

  try {
    const job = await retryJob(userId, params.id);
    return NextResponse.json({ message: 'Job re-queued', job: serializeJob(job) });
  } catch (error) {
    if (error instanceof JobValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    console.error('[api/jobs/:id/retry] failed', error);
    return NextResponse.json({ message: 'Could not retry job' }, { status: 500 });
  }
});
