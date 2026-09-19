import { prisma } from '@/lib/db';
import { seal, open as openSecret } from '@/lib/crypto/secretBox';
import { androidCredentialsSchema } from '@/lib/publisher/android';

export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountValidationError';
  }
}

/** Config keys that must never travel back to the browser, whatever the driver. */
const SENSITIVE = /token|password|secret|key/i;

function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSensitive);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE.test(key) ? undefined : stripSensitive(item),
      ]),
    );
  }

  return value;
}

/**
 * Validates an Android account config against the same schema the worker reads,
 * so a config the dashboard accepts is one a job can actually run. The error is
 * a flat list of `path: message`, which the dialog shows verbatim.
 */
export function validateAndroidConfig(raw: unknown): Record<string, unknown> {
  const parsed = androidCredentialsSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new AccountValidationError(issues);
  }

  return parsed.data;
}

export interface CreateAndroidAccountInput {
  userId: string;
  name: string;
  config: unknown;
}

export async function createAndroidAccount(input: CreateAndroidAccountInput) {
  const name = input.name.trim();

  if (!name) {
    throw new AccountValidationError('name: must not be empty');
  }

  const config = validateAndroidConfig(input.config);

  return prisma.account.create({
    data: {
      userId: input.userId,
      name,
      platform: 'SPORT_REELS',
      status: 'ACTIVE',
      credentials: seal(config),
      maxConcurrent: 1,
      minIntervalSeconds: 60,
    },
  });
}

/**
 * The decrypted, secret-stripped config of an account, for pre-filling the
 * "new account" form. Android accounts only — an OAuth account's credentials
 * are a token, which stripSensitive would blank into something useless anyway.
 */
export async function accountConfigForCloning(userId: string, accountId: string): Promise<unknown | null> {
  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });

  if (!account?.credentials) {
    return null;
  }

  const config = openSecret(account.credentials);

  // Only hand back something that parses as an Android config; refuse to leak
  // the shape of anything else.
  if (!androidCredentialsSchema.safeParse(config).success) {
    return null;
  }

  return stripSensitive(config);
}

/**
 * Whether this account's device expects to be lent the operator's webcam.
 *
 * Answered before the job starts rather than from the device endpoint, because
 * the browser has to be publishing *before* the worker boots anything — an
 * emulator started against a camera nobody is feeding gets a device with no
 * frames in it, which reads as a broken camera rather than a missing operator.
 * The jobId is all the browser needs to name its stream, and it has that as
 * soon as the job is created.
 *
 * Returns false for anything that is not an Android account with an
 * `emulator.camera` block, including credentials that no longer parse.
 */
export async function accountLendsCamera(userId: string, accountId: string): Promise<boolean> {
  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });

  if (!account?.credentials) {
    return false;
  }

  const parsed = androidCredentialsSchema.safeParse(openSecret(account.credentials));

  return parsed.success && parsed.data.emulator?.camera !== undefined;
}
