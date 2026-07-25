import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';
import { getEnv } from '@/lib/env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function decodeKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');

  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `${label} must decode to ${KEY_LENGTH} bytes, got ${key.length}. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  return key;
}

/** The key everything new is sealed with. */
export function primaryKey(): Buffer {
  return decodeKey(getEnv().CREDENTIALS_KEY, 'CREDENTIALS_KEY');
}

/**
 * Retired keys, tried in order when the primary fails to open an envelope.
 *
 * This is what makes rotation possible without a format change or a migration
 * window: set the new key as primary, move the old one here, and existing
 * credentials keep opening until the rotation script re-seals them.
 */
export function fallbackKeys(): Buffer[] {
  const raw = getEnv().CREDENTIALS_KEYS_OLD;

  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry, index) => decodeKey(entry, `CREDENTIALS_KEYS_OLD[${index}]`));
}

/**
 * Encrypts a JSON-serialisable value into a single opaque buffer laid out as
 * iv(12) || tag(16) || ciphertext, which is what Account.credentials stores.
 */
export function seal(plaintext: unknown, key: Buffer = primaryKey()): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const body = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), 'utf8'),
    cipher.final(),
  ]);

  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function openWith<T>(envelope: Buffer, key: Buffer): T {
  const iv = envelope.subarray(0, IV_LENGTH);
  const tag = envelope.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = envelope.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);

  return JSON.parse(plaintext.toString('utf8')) as T;
}

export interface OpenResult<T> {
  value: T;
  /** True when a retired key opened it, meaning the record still needs re-sealing. */
  usedFallback: boolean;
}

/**
 * Tries the primary key, then each retired key. GCM authenticates, so a wrong
 * key fails cleanly rather than yielding garbage — trying several is safe.
 */
export function openDetailed<T = unknown>(envelope: Buffer | Uint8Array): OpenResult<T> {
  const buffer = Buffer.from(envelope);

  if (buffer.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Credential envelope is truncated');
  }

  try {
    return { value: openWith<T>(buffer, primaryKey()), usedFallback: false };
  } catch (primaryError) {
    for (const key of fallbackKeys()) {
      try {
        return { value: openWith<T>(buffer, key), usedFallback: true };
      } catch {
        // Try the next retired key.
      }
    }

    throw primaryError;
  }
}

export function open<T = unknown>(envelope: Buffer | Uint8Array): T {
  return openDetailed<T>(envelope).value;
}

/**
 * Constant-time comparison for anything derived from user input that gates
 * access (webhook signatures, API keys).
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
