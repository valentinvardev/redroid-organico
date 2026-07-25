import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db';
import { resetEnvCache } from '@/lib/env';
import { openDetailed, seal } from '@/lib/crypto/secretBox';
import { createAccount, createUser, reset, teardown } from '../helpers/harness';

const ORIGINAL_KEY = process.env.CREDENTIALS_KEY;
const ORIGINAL_OLD = process.env.CREDENTIALS_KEYS_OLD;

function newKey(): string {
  return randomBytes(32).toString('base64');
}

/** Points the crypto layer at a different key set, as a restart would. */
function useKeys(primary: string, old?: string): void {
  process.env.CREDENTIALS_KEY = primary;

  if (old === undefined) {
    delete process.env.CREDENTIALS_KEYS_OLD;
  } else {
    process.env.CREDENTIALS_KEYS_OLD = old;
  }

  resetEnvCache();
}

beforeEach(reset);

afterEach(() => {
  useKeys(ORIGINAL_KEY!, ORIGINAL_OLD);
});

after(teardown);

describe('credential envelopes', () => {
  it('round-trips and reports that the primary key opened it', () => {
    const secret = { accessToken: 'abc', refreshToken: 'def' };
    const opened = openDetailed<typeof secret>(seal(secret));

    assert.deepEqual(opened.value, secret);
    assert.equal(opened.usedFallback, false);
  });

  it('refuses an envelope sealed with an unrelated key', () => {
    const stranger = randomBytes(32);
    const envelope = seal({ token: 'x' }, stranger);

    assert.throws(() => openDetailed(envelope));
  });

  it('rejects a truncated envelope', () => {
    assert.throws(() => openDetailed(Buffer.alloc(4)), /truncated/);
  });

  it('rejects a tampered envelope rather than returning garbage', () => {
    const envelope = seal({ token: 'authentic' });
    envelope[envelope.length - 1] ^= 0xff;

    assert.throws(() => openDetailed(envelope));
  });
});

describe('key rotation', () => {
  it('opens old envelopes through the fallback and flags them for re-sealing', () => {
    const oldKey = newKey();
    const freshKey = newKey();

    useKeys(oldKey);
    const envelope = seal({ accessToken: 'sealed-with-the-old-key' });

    // As after step 3 of the rotation procedure: new primary, old one retired.
    useKeys(freshKey, oldKey);

    const opened = openDetailed<{ accessToken: string }>(envelope);

    assert.equal(opened.value.accessToken, 'sealed-with-the-old-key');
    assert.equal(opened.usedFallback, true, 'it should report that a retired key was needed');
  });

  it('stops needing the fallback once the value is re-sealed', () => {
    const oldKey = newKey();
    const freshKey = newKey();

    useKeys(oldKey);
    const envelope = seal({ accessToken: 'rotate-me' });

    useKeys(freshKey, oldKey);
    const resealed = seal(openDetailed(envelope).value);

    // Step 6: the retired key is removed. The re-sealed value must still open.
    useKeys(freshKey);

    const opened = openDetailed<{ accessToken: string }>(resealed);
    assert.equal(opened.value.accessToken, 'rotate-me');
    assert.equal(opened.usedFallback, false);
  });

  it('becomes unreadable if the retired key is dropped before re-sealing', () => {
    const oldKey = newKey();
    const freshKey = newKey();

    useKeys(oldKey);
    const envelope = seal({ accessToken: 'orphaned' });

    // The mistake the procedure exists to prevent: rotating without keeping the
    // previous key around long enough to re-seal.
    useKeys(freshKey);

    assert.throws(() => openDetailed(envelope));
  });

  it('tries every retired key, not just the first', () => {
    const first = newKey();
    const second = newKey();
    const current = newKey();

    useKeys(second);
    const sealedWithSecond = seal({ accessToken: 'two generations back' });

    useKeys(current, `${first},${second}`);

    const opened = openDetailed<{ accessToken: string }>(sealedWithSecond);
    assert.equal(opened.value.accessToken, 'two generations back');
    assert.equal(opened.usedFallback, true);
  });

  it('rejects a key that is not 32 bytes, at config load', () => {
    useKeys(randomBytes(16).toString('base64'));

    // Caught by the environment schema, so a misconfigured deployment fails on
    // boot instead of at the first credential it tries to seal.
    assert.throws(() => seal({ token: 'x' }), /32 bytes/);
  });

  it('rejects a retired key that is not 32 bytes', () => {
    useKeys(newKey(), randomBytes(8).toString('base64'));

    assert.throws(() => openDetailed(Buffer.alloc(40)), /32 bytes/);
  });

  it('re-seals stored account credentials end to end', async () => {
    const oldKey = newKey();
    const freshKey = newKey();

    const user = await createUser();

    useKeys(oldKey);
    const account = await createAccount(user.id);
    await prisma.account.update({
      where: { id: account.id },
      data: { credentials: seal({ accessToken: 'stored-under-the-old-key' }) },
    });

    useKeys(freshKey, oldKey);

    // What scripts/rotateCredentials.ts does for every row.
    const stored = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    const opened = openDetailed<{ accessToken: string }>(stored.credentials!);

    assert.equal(opened.usedFallback, true);

    await prisma.account.update({
      where: { id: account.id },
      data: { credentials: seal(opened.value) },
    });

    useKeys(freshKey);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: account.id } });
    const reopened = openDetailed<{ accessToken: string }>(after.credentials!);

    assert.equal(reopened.value.accessToken, 'stored-under-the-old-key');
    assert.equal(reopened.usedFallback, false);
  });
});
