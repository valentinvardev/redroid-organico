import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { assignProxy, ProxyValidationError } from '@/lib/proxy/service';
import { serializeAccount } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

/**
 * Points the account at a proxy — `{ "proxyId": null }` to send it back out
 * through the host's own address.
 *
 * Takes effect on the next job. A run already holding a device keeps the
 * gateway it started with, because moving a live Android container into another
 * network namespace is not a thing Docker can do.
 */
export const PUT = guarded(async (request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Body must be JSON' }, { status: 400 });
  }

  const proxyId = (body as { proxyId?: unknown } | null)?.proxyId ?? null;

  if (proxyId !== null && typeof proxyId !== 'string') {
    return NextResponse.json({ message: 'proxyId must be a string or null' }, { status: 422 });
  }

  try {
    const account = await assignProxy(userId, params.id, proxyId);

    // Re-read with the relation so the client can render the new assignment
    // without a second request.
    const withProxy = await prisma.account.findUniqueOrThrow({
      where: { id: account.id },
      include: { proxy: true },
    });

    return NextResponse.json(serializeAccount(withProxy));
  } catch (error) {
    if (error instanceof ProxyValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    console.error('[api/accounts/:id/proxy] assign failed', error);
    return NextResponse.json({ message: 'Could not assign the proxy' }, { status: 500 });
  }
});
