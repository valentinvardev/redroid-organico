import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, resolveSessionToken } from '@/lib/auth/session';
import {
  EmailTakenError,
  UserValidationError,
  assertPasswordStrength,
  changePassword,
  createUserWithPassword,
  normaliseEmail,
  setPassword,
} from '@/lib/auth/users';
import { reset, teardown } from '../helpers/harness';

const GOOD_PASSWORD = 'a-perfectly-fine-passphrase';

beforeEach(reset);
after(teardown);

describe('user creation', () => {
  it('creates a user with a usable password', async () => {
    const user = await createUserWithPassword({
      email: 'Alice@Example.COM',
      password: GOOD_PASSWORD,
      name: '  Alice  ',
    });

    assert.equal(user.email, 'alice@example.com', 'the email should be normalised');
    assert.equal(user.name, 'Alice', 'the name should be trimmed');
    assert.ok(user.passwordHash);
    assert.equal(await verifyPassword(GOOD_PASSWORD, user.passwordHash), true);
  });

  it('rejects a duplicate email regardless of casing', async () => {
    await createUserWithPassword({ email: 'bob@example.com', password: GOOD_PASSWORD });

    await assert.rejects(
      () => createUserWithPassword({ email: 'BOB@example.com', password: GOOD_PASSWORD }),
      EmailTakenError,
    );

    assert.equal(await prisma.user.count(), 1);
  });

  it('rejects malformed email addresses', async () => {
    for (const email of ['', 'nope', 'a@', '@b', 'has space@example.com']) {
      await assert.rejects(
        () => createUserWithPassword({ email, password: GOOD_PASSWORD }),
        UserValidationError,
        `should have rejected "${email}"`,
      );
    }
  });

  it('accepts a local address without a TLD', async () => {
    // Regression guard: strict email validation used to make the seeded
    // dev@localhost account impossible to use.
    const user = await createUserWithPassword({ email: 'dev@localhost', password: GOOD_PASSWORD });
    assert.equal(user.email, 'dev@localhost');
  });

  it('normalises emails consistently', () => {
    assert.equal(normaliseEmail('  MiXeD@Case.IO  '), 'mixed@case.io');
  });
});

describe('password strength', () => {
  it('rejects passwords that are too short', () => {
    assert.throws(() => assertPasswordStrength('short'), UserValidationError);
  });

  it('rejects a single repeated character even when long enough', () => {
    assert.throws(() => assertPasswordStrength('aaaaaaaaaaaaaaaa'), UserValidationError);
  });

  it('rejects passwords built from too few distinct characters', () => {
    assert.throws(() => assertPasswordStrength('abababababab'), UserValidationError);
  });

  it('rejects a password containing the email local part', () => {
    assert.throws(
      () => assertPasswordStrength('valentin-is-my-password', 'valentin@example.com'),
      UserValidationError,
    );
  });

  it('accepts a reasonable passphrase', () => {
    assert.doesNotThrow(() => assertPasswordStrength(GOOD_PASSWORD, 'someone@example.com'));
  });
});

describe('changing a password', () => {
  it('replaces the hash and signs out every session', async () => {
    const user = await createUserWithPassword({ email: 'carol@example.com', password: GOOD_PASSWORD });

    const tokens = [await createSession(user.id), await createSession(user.id)];
    assert.ok(await resolveSessionToken(tokens[0]));

    await changePassword({
      userId: user.id,
      currentPassword: GOOD_PASSWORD,
      newPassword: 'an-entirely-different-phrase',
    });

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    assert.equal(await verifyPassword('an-entirely-different-phrase', updated.passwordHash!), true);
    assert.equal(await verifyPassword(GOOD_PASSWORD, updated.passwordHash!), false);

    // A password change is the standard response to a compromise, so leaving
    // other sessions alive would defeat the point.
    for (const token of tokens) {
      assert.equal(await resolveSessionToken(token), null);
    }
  });

  it('refuses an incorrect current password and leaves sessions intact', async () => {
    const user = await createUserWithPassword({ email: 'dave@example.com', password: GOOD_PASSWORD });
    const token = await createSession(user.id);

    await assert.rejects(
      () =>
        changePassword({
          userId: user.id,
          currentPassword: 'not-the-current-password',
          newPassword: 'some-other-valid-phrase',
        }),
      UserValidationError,
    );

    assert.ok(await resolveSessionToken(token), 'a failed attempt must not sign anyone out');
  });

  it('refuses to reuse the current password', async () => {
    const user = await createUserWithPassword({ email: 'erin@example.com', password: GOOD_PASSWORD });

    await assert.rejects(
      () =>
        changePassword({
          userId: user.id,
          currentPassword: GOOD_PASSWORD,
          newPassword: GOOD_PASSWORD,
        }),
      /must differ/,
    );
  });

  it('rejects a weak replacement before writing anything', async () => {
    const user = await createUserWithPassword({ email: 'frank@example.com', password: GOOD_PASSWORD });

    await assert.rejects(
      () => changePassword({ userId: user.id, currentPassword: GOOD_PASSWORD, newPassword: 'aaaa' }),
      UserValidationError,
    );

    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(await verifyPassword(GOOD_PASSWORD, unchanged.passwordHash!), true);
  });

  it('setPassword resets without needing the old one, and signs out sessions', async () => {
    const user = await createUserWithPassword({ email: 'grace@example.com', password: GOOD_PASSWORD });
    const token = await createSession(user.id);

    await setPassword(user.id, 'an-administratively-set-phrase');

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(await verifyPassword('an-administratively-set-phrase', updated.passwordHash!), true);
    assert.equal(await resolveSessionToken(token), null);
  });
});
