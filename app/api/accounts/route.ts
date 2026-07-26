import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { AccountValidationError, createAndroidAccount } from '@/lib/accounts/service';
import { serializeAccount } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

export const GET = guarded(async () => {
  const userId = await getCurrentUserId();

  const accounts = await prisma.account.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    // The dashboard shows each account's egress next to its session state, so
    // the assignment travels with the account rather than in a second request
    // the list would have to join client-side.
    include: { proxy: true },
  });

  return NextResponse.json(accounts.map(serializeAccount));
});

export const POST = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();

  let body: { name?: unknown; config?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Body must be JSON' }, { status: 400 });
  }

  if (typeof body.name !== 'string') {
    return NextResponse.json({ message: 'A name is required' }, { status: 422 });
  }

  try {
    const account = await createAndroidAccount({ userId, name: body.name, config: body.config });
    return NextResponse.json(serializeAccount(account), { status: 201 });
  } catch (error) {
    // The validation message is a field-by-field list, meant to be shown as-is.
    if (error instanceof AccountValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    console.error('[api/accounts] create failed', error);
    return NextResponse.json({ message: 'Could not create the account' }, { status: 500 });
  }
});
