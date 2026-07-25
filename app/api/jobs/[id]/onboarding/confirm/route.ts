import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { JobValidationError, confirmOnboarding } from '@/lib/jobs/service';
import { serializeJob } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

/**
 * "I finished logging in". Wakes the worker that is holding the device, which
 * then runs the verification flow and tears the container down.
 *
 * Returning 200 does not mean the session is verified — it means the worker has
 * been told. The client keeps polling the job until it reaches a terminal
 * status, because the verification can still disagree with the operator.
 */
export const POST = guarded(async (_request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();

  try {
    const job = await confirmOnboarding(userId, params.id);

    return NextResponse.json({
      message: 'Confirmation received, verifying the session',
      job: serializeJob(job),
    });
  } catch (error) {
    if (error instanceof JobValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    console.error('[api/jobs/:id/onboarding/confirm] failed', error);
    return NextResponse.json({ message: 'Could not confirm onboarding' }, { status: 500 });
  }
});
