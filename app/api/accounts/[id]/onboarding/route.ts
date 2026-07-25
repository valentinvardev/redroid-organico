import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { JobConflictError, JobValidationError, createOnboardingJob } from '@/lib/jobs/service';
import { serializeJob } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

/**
 * "Link account" in the dashboard. Returns immediately with a queued job; the
 * client then polls GET /api/jobs/:id until the status is AWAITING_HUMAN and a
 * deviceEndpoint is present, which is its cue to show the screen.
 */
export const POST = guarded(async (request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();
  const idempotencyKey = request.headers.get('Idempotency-Key') ?? undefined;

  try {
    const { job, created } = await createOnboardingJob({
      userId,
      accountId: params.id,
      idempotencyKey,
    });

    return NextResponse.json(
      { message: created ? 'Onboarding queued' : 'Onboarding already queued', job: serializeJob(job) },
      { status: created ? 202 : 200 },
    );
  } catch (error) {
    if (error instanceof JobConflictError) {
      return NextResponse.json({ message: error.message, jobId: error.existingJobId }, { status: 409 });
    }

    if (error instanceof JobValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    console.error('[api/accounts/:id/onboarding] failed', error);
    return NextResponse.json({ message: 'Could not start onboarding' }, { status: 500 });
  }
});
