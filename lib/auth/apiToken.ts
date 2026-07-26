import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/db';
import type { SessionUser } from './session';

/**
 * A token is `rdo_<43 url-safe base64 chars>` — 32 bytes of entropy. The prefix
 * is only there to make one recognisable in a log or an env file; it carries no
 * meaning and is part of what gets hashed.
 */
const PREFIX = 'rdo_';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedToken {
  id: string;
  /** Shown once, at creation, then unrecoverable. */
  token: string;
}

export async function createApiToken(
  userId: string,
  name: string,
  expiresAt?: Date | null,
): Promise<IssuedToken> {
  const token = PREFIX + randomBytes(32).toString('base64url');

  const row = await prisma.apiToken.create({
    data: {
      userId,
      name: name.trim() || 'unnamed',
      tokenHash: hashToken(token),
      expiresAt: expiresAt ?? null,
    },
  });

  return { id: row.id, token };
}

/**
 * Resolves a raw bearer token to its user, or null. Mirrors resolveSessionToken:
 * expired tokens are deleted on encounter, and lastUsedAt is refreshed so an
 * operator can see which tokens are live. The constant-prefix check short-
 * circuits a database read for anything that is obviously not one of ours.
 */
export async function resolveApiToken(raw: string): Promise<SessionUser | null> {
  if (!raw.startsWith(PREFIX)) {
    return null;
  }

  const token = await prisma.apiToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: true },
  });

  if (!token) {
    return null;
  }

  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
    await prisma.apiToken.delete({ where: { id: token.id } }).catch(() => undefined);
    return null;
  }

  // Best-effort, and never on the request's critical path: a write failure here
  // must not turn a valid token into a rejected one.
  void prisma.apiToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return { id: token.user.id, email: token.user.email, name: token.user.name };
}

/**
 * Pulls the bearer token out of an Authorization header. Accepts `Bearer <t>`
 * case-insensitively; anything else is treated as absent.
 */
export function bearerFromHeader(header: string | null | undefined): string | null {
  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Constant-time compare, for the rare place that compares two tokens directly. */
export function tokensEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
