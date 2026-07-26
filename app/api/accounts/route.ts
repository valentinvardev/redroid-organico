import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
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
