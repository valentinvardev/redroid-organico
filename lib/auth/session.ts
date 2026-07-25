import { createHash, randomBytes } from 'crypto';
import { cookies } from 'next/headers';
import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SESSION_COOKIE } from './cookie';

export { SESSION_COOKIE };

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** Sessions past this point get a fresh expiry on use, so active users are not logged out mid-work. */
const RENEW_WHEN_REMAINING_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The cookie carries a random token; the database stores only its SHA-256. A
 * plain hash (no salt, no KDF) is right here because the token is 256 bits of
 * entropy — there is nothing to brute-force — and lookups must be a single
 * indexed read.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string, userAgent?: string | null): Promise<string> {
  const token = randomBytes(32).toString('base64url');

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      userAgent: userAgent?.slice(0, 500) ?? null,
    },
  });

  return token;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return token ? resolveSessionToken(token) : null;
}

/**
 * Validates a raw token against the database. Split out from getSessionUser so
 * the rule — expiry, cleanup, renewal — can be tested without a request scope,
 * which `cookies()` requires.
 */
export async function resolveSessionToken(token: string): Promise<SessionUser | null> {
  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    // Expired sessions are removed on encounter rather than by a sweeper.
    await prisma.session.delete({ where: { tokenHash: session.tokenHash } }).catch(() => undefined);
    return null;
  }

  if (session.expiresAt.getTime() - Date.now() < RENEW_WHEN_REMAINING_MS) {
    await prisma.session
      .update({
        where: { tokenHash: session.tokenHash },
        data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      })
      .catch(() => undefined);
  }

  return toSessionUser(session.user);
}

export async function destroySession(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE)?.value;

  if (token) {
    await prisma.session.delete({ where: { tokenHash: hashToken(token) } }).catch(() => undefined);
  }
}

/** Invalidates every session for a user — used after a password change. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

export function sessionCookieOptions(maxAgeSeconds = SESSION_TTL_MS / 1_000) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

function toSessionUser(user: User): SessionUser {
  return { id: user.id, email: user.email, name: user.name };
}
