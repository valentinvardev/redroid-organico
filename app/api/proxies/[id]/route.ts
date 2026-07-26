import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { deleteProxy, ProxyConflictError, ProxyValidationError, updateProxy } from '@/lib/proxy/service';
import { serializeProxy } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

/**
 * A patch, not a replacement: the API never returns a password, so a form that
 * had to send the whole object back would erase the one it could not read.
 */
export const PATCH = guarded(async (request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Body must be JSON' }, { status: 400 });
  }

  try {
    const proxy = await updateProxy(userId, params.id, body);
    return NextResponse.json(serializeProxy(proxy));
  } catch (error) {
    return failure(error, 'update');
  }
});

export const DELETE = guarded(async (_request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();

  try {
    await deleteProxy(userId, params.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return failure(error, 'delete');
  }
});

function failure(error: unknown, action: string): Response {
  if (error instanceof ProxyConflictError) {
    return NextResponse.json({ message: error.message }, { status: 409 });
  }

  if (error instanceof ProxyValidationError) {
    // Covers "not found" as well: an id belonging to another user is not
    // distinguishable from one that does not exist, and should not be.
    return NextResponse.json({ message: error.message }, { status: 422 });
  }

  console.error(`[api/proxies/:id] ${action} failed`, error);
  return NextResponse.json({ message: `Could not ${action} the proxy` }, { status: 500 });
}
