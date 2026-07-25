import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { SESSION_COOKIE, createSession, sessionCookieOptions } from '@/lib/auth/session';
import {
  checkLoginThrottle,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from '@/lib/auth/loginThrottle';

export const dynamic = 'force-dynamic';

/**
 * Login deliberately does not validate email *format*. Zod 4's email rule
 * requires a TLD, which rejects perfectly real local addresses like
 * `dev@localhost` — and a sign-in endpoint has no business refusing an
 * identifier it could simply look up and not find. Format enforcement belongs
 * at registration, not here.
 */
const schema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1_024),
});

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Expected a JSON body' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ message: 'Email and password are required' }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const ip = clientIp(request);

  const throttle = await checkLoginThrottle(email, ip);

  if (throttle.blocked) {
    return NextResponse.json(
      { message: 'Too many failed attempts. Try again later.' },
      { status: 429, headers: { 'Retry-After': String(throttle.retryAfterSeconds) } },
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Same response and comparable work whether the email exists or not, so the
  // endpoint does not reveal which accounts are registered.
  const valid = user?.passwordHash
    ? await verifyPassword(parsed.data.password, user.passwordHash)
    : await burnComparableTime(parsed.data.password);

  if (!user || !user.passwordHash || !valid) {
    await recordLoginFailure(email, ip);
    return NextResponse.json({ message: 'Invalid email or password' }, { status: 401 });
  }

  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(parsed.data.password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } });
  }

  await clearLoginFailures(email, ip);

  const token = await createSession(user.id, request.headers.get('user-agent'));
  cookies().set(SESSION_COOKIE, token, sessionCookieOptions());

  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
  });
}

/**
 * Runs a scrypt derivation against a throwaway hash so a request for an unknown
 * email costs roughly the same as one for a known email.
 */
let decoyHash: string | undefined;

async function burnComparableTime(password: string): Promise<false> {
  if (!decoyHash) {
    decoyHash = await hashPassword('decoy-password-never-matches');
  }

  await verifyPassword(password, decoyHash);
  return false;
}
