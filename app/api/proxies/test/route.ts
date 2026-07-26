import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { proxyConnectionSchema } from '@/lib/proxy/config';
import { openProxy } from '@/lib/proxy/service';
import { testProxy } from '@/lib/proxy/test';

export const dynamic = 'force-dynamic';

/**
 * Connects through a proxy and reports the exit IP, so the operator can check a
 * proxy before saving it. Accepts the form's values directly.
 *
 * `proxyId` handles the edit case: the form never holds a saved password, so a
 * blank one means "use the stored one" — the same rule the PATCH route follows.
 */
export const POST = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const parsed = proxyConnectionSchema.safeParse(body);

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join('; ');
    return NextResponse.json({ ok: false, error: message }, { status: 422 });
  }

  const config = parsed.data;

  // Testing a saved proxy with the password left blank: pull the stored one so
  // the operator does not have to retype it just to test.
  if (!config.password && typeof body.proxyId === 'string') {
    const stored = await prisma.proxy.findFirst({ where: { id: body.proxyId, userId } });
    if (stored?.password) {
      config.password = openProxy(stored).password ?? null;
    }
  }

  const result = await testProxy(config);
  return NextResponse.json(result);
});
