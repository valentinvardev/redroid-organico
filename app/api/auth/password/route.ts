import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';
import { UserValidationError, changePassword } from '@/lib/auth/users';

export const dynamic = 'force-dynamic';

const schema = z.object({
  currentPassword: z.string().min(1).max(1_024),
  newPassword: z.string().min(1).max(1_024),
});

export const POST = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Expected a JSON body' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { message: 'currentPassword and newPassword are required' },
      { status: 400 },
    );
  }

  try {
    await changePassword({
      userId,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });
  } catch (error) {
    if (error instanceof UserValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    throw error;
  }

  // changePassword invalidated every session including this one, so clear the
  // cookie rather than leaving the client holding a token that no longer works.
  cookies().set(SESSION_COOKIE, '', { ...sessionCookieOptions(0), maxAge: 0 });

  return NextResponse.json({
    message: 'Password changed. All sessions were signed out — please sign in again.',
  });
});
