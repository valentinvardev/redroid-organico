import { NextResponse } from 'next/server';
import { getOptionalUser } from '@/lib/auth/currentUser';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getOptionalUser();

  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  return NextResponse.json({ user });
}
