import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { FlowValidationError, readFlows, writeFlows } from '@/lib/accounts/flows';

export const dynamic = 'force-dynamic';

/**
 * The account's automations, and only those.
 *
 * The rest of the credentials — the Appium URL, the APK path, any OAuth token —
 * never leaves the server, here or anywhere else. Selectors are not secrets and
 * are the only part that changes weekly.
 */
export const GET = guarded(async (_request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();

  try {
    return NextResponse.json(await readFlows(userId, params.id));
  } catch (error) {
    return failure(error, 'read');
  }
});

export const PUT = guarded(async (request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Body must be JSON' }, { status: 400 });
  }

  try {
    return NextResponse.json(await writeFlows(userId, params.id, body));
  } catch (error) {
    return failure(error, 'save');
  }
});

function failure(error: unknown, action: string): Response {
  if (error instanceof FlowValidationError) {
    return NextResponse.json({ message: error.message }, { status: 422 });
  }

  // Never `error` itself: the credentials it was opening are in scope.
  console.error(`[api/accounts/:id/flows] ${action} failed`, error);
  return NextResponse.json({ message: `Could not ${action} the automations` }, { status: 500 });
}
