import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'crypto';

/**
 * Hand-rolled rather than `promisify(scrypt)`: promisify's type inference picks
 * the three-argument overload and drops the options parameter, so the cost
 * parameters would be silently ignored at the type level.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derived);
    });
  });
}

/**
 * scrypt from node's stdlib rather than bcrypt/argon2: no native module to build
 * and no dependency to keep patched. The cost parameters are stored inside each
 * hash, so raising them later does not invalidate existing passwords — they are
 * rehashed on the next successful login (see needsRehash).
 */
const PARAMS = { N: 16_384, r: 8, p: 1, keyLength: 64 } as const;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  assertReasonable(password);

  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password.normalize('NFKC'), salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    // scrypt needs enough memory for these parameters or it throws.
    maxmem: 256 * PARAMS.N * PARAMS.r,
  }));

  return [PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');

  if (parts.length !== 5) {
    return false;
  }

  const [nRaw, rRaw, pRaw, saltB64, expectedB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let expected: Buffer;
  let salt: Buffer;

  try {
    expected = Buffer.from(expectedB64, 'base64');
    salt = Buffer.from(saltB64, 'base64');
  } catch {
    return false;
  }

  if (expected.length === 0 || salt.length === 0) {
    return false;
  }

  let derived: Buffer;

  try {
    derived = (await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * N * r,
    }));
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when `stored` was produced with weaker parameters than the current ones. */
export function needsRehash(stored: string): boolean {
  const [nRaw, rRaw, pRaw] = stored.split('$');
  return Number(nRaw) < PARAMS.N || Number(rRaw) < PARAMS.r || Number(pRaw) < PARAMS.p;
}

export const PASSWORD_MIN_LENGTH = 10;

function assertReasonable(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  // scrypt hashes the whole input, so a huge password is a cheap way to burn
  // server CPU. Reject rather than truncate.
  if (Buffer.byteLength(password, 'utf8') > 1_024) {
    throw new Error('Password must be at most 1024 bytes');
  }
}
