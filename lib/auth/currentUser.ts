import { getSessionUser, type SessionUser } from './session';

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Resolves the caller from their session cookie. Every query in the app is
 * scoped by the id this returns, so this is the single point that decides who
 * the caller is.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();

  if (!user) {
    throw new UnauthorizedError();
  }

  return user;
}

export async function getCurrentUserId(): Promise<string> {
  return (await requireUser()).id;
}

/** Null instead of throwing, for places that render differently when signed out. */
export async function getOptionalUser(): Promise<SessionUser | null> {
  return getSessionUser();
}
