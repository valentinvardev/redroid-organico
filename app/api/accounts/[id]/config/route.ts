import { NextResponse } from 'next/server';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { accountConfigForCloning } from '@/lib/accounts/service';

export const dynamic = 'force-dynamic';

/**
 * The decrypted, secret-stripped config of an existing account, so the "new
 * account" dialog can start from a working one. Android accounts only; nothing
 * here carries a token or password.
 */
export const GET = guarded(async (_request: Request, { params }: { params: { id: string } }) => {
  const userId = await getCurrentUserId();
  const config = await accountConfigForCloning(userId, params.id);

  if (!config) {
    return NextResponse.json({ message: 'No cloneable Android config for that account' }, { status: 404 });
  }

  return NextResponse.json({ config });
});
