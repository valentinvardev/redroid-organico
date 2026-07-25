import { Prisma, type User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { PASSWORD_MIN_LENGTH, hashPassword, verifyPassword } from './password';
import { destroyAllSessions } from './session';

export class UserValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserValidationError';
  }
}

export class EmailTakenError extends UserValidationError {
  constructor(email: string) {
    super(`An account already exists for ${email}`);
    this.name = 'EmailTakenError';
  }
}

/**
 * Format is enforced here, at creation — not at login, where refusing an
 * identifier we could simply fail to find would only leak which shapes are
 * valid. Deliberately permissive: it rejects obvious mistakes without
 * pretending to implement RFC 5322.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidEmail(email: string): void {
  if (email.length < 3 || email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new UserValidationError(`"${email}" is not a valid email address`);
  }
}

/**
 * Rejects the failure modes a length check alone misses. Not a substitute for a
 * breach-corpus check, which needs a wordlist this project does not ship.
 */
export function assertPasswordStrength(password: string, email?: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new UserValidationError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  if (new Set(password).size < 4) {
    throw new UserValidationError('Password must use more than a handful of distinct characters');
  }

  const lowered = password.toLowerCase();

  if (email) {
    const local = email.split('@')[0]?.toLowerCase();

    // Four characters and up: shorter local parts like "ops" or "dev" collide
    // with ordinary words too often to be a useful signal.
    if (local && local.length >= 4 && lowered.includes(local)) {
      throw new UserValidationError('Password must not contain your email address');
    }
  }

  if (/^(.)\1+$/.test(password)) {
    throw new UserValidationError('Password must not be a single repeated character');
  }
}

export interface CreateUserInput {
  email: string;
  password: string;
  name?: string | null;
}

export async function createUserWithPassword(input: CreateUserInput): Promise<User> {
  const email = normaliseEmail(input.email);

  assertValidEmail(email);
  assertPasswordStrength(input.password, email);

  try {
    return await prisma.user.create({
      data: {
        email,
        name: input.name?.trim() || null,
        passwordHash: await hashPassword(input.password),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new EmailTakenError(email);
    }

    throw error;
  }
}

/**
 * Changing a password invalidates every session, including the caller's. A
 * password change is the standard response to a suspected compromise, so
 * leaving other sessions alive would defeat the point.
 */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });

  if (!user?.passwordHash) {
    throw new UserValidationError('This account has no password set');
  }

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new UserValidationError('Current password is incorrect');
  }

  if (await verifyPassword(input.newPassword, user.passwordHash)) {
    throw new UserValidationError('New password must differ from the current one');
  }

  assertPasswordStrength(input.newPassword, user.email);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });

  await destroyAllSessions(user.id);
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  assertPasswordStrength(password, user.email);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(password) },
  });

  await destroyAllSessions(userId);
}
