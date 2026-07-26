import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { createProxy, listProxies, ProxyConflictError, ProxyValidationError } from '@/lib/proxy/service';
import { serializeProxy } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export const GET = guarded(async () => {
  const userId = await getCurrentUserId();
  const proxies = await listProxies(userId);

  return NextResponse.json(proxies.map(serializeProxy));
});

export const POST = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Body must be JSON' }, { status: 400 });
  }

  try {
    const proxy = await createProxy(userId, body);
    return NextResponse.json(serializeProxy(proxy), { status: 201 });
  } catch (error) {
    if (error instanceof ProxyConflictError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    if (error instanceof ProxyValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    // Deliberately not `error` in the response: a proxy password could be
    // anywhere in a stack trace from here.
    console.error('[api/proxies] create failed', error);
    return NextResponse.json({ message: 'Could not save the proxy' }, { status: 500 });
  }
});
