import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, destroySession, sessionCookieOptions } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  await destroySession();
  cookies().set(SESSION_COOKIE, '', { ...sessionCookieOptions(0), maxAge: 0 });

  return NextResponse.json({ message: 'Signed out' });
}
