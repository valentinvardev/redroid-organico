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
  });

  return NextResponse.json(accounts.map(serializeAccount));
});
