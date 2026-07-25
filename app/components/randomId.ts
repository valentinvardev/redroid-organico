'use client';

/**
 * A UUID that also works over plain HTTP.
 *
 * `crypto.randomUUID()` is restricted to secure contexts — HTTPS, or localhost.
 * A dashboard served from `http://<public-ip>:3000` is neither, so the function
 * is simply absent and every call throws "crypto.randomUUID is not a function".
 *
 * `crypto.getRandomValues()` carries no such restriction, so the fallback is
 * still cryptographically random. These ids only need to be unique — they are
 * idempotency keys, not secrets — but there is no reason to weaken them.
 */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));

    // Version 4, variant 1, so the result is a well-formed UUID rather than
    // 32 random hex characters that merely look like one.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // No Web Crypto at all. Not expected in any browser this runs in, but an
  // idempotency key that is merely unlikely to collide beats a crash.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
