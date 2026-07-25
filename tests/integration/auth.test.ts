import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { PASSWORD_MIN_LENGTH, hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { createSession, destroyAllSessions, resolveSessionToken } from '@/lib/auth/session';
import { createUser, reset, teardown } from '../helpers/harness';

beforeEach(reset);
after(teardown);

describe('password hashing', () => {
  it('accepts the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');

    assert.equal(await verifyPassword('correct horse battery', hash), true);
    assert.equal(await verifyPassword('Correct horse battery', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('produces a different hash each time for the same password', async () => {
    const a = await hashPassword('same password here');
    const b = await hashPassword('same password here');

    assert.notEqual(a, b, 'the salt must be random per hash');
    assert.equal(await verifyPassword('same password here', a), true);
    assert.equal(await verifyPassword('same password here', b), true);
  });

  it('never stores the password in the hash', async () => {
    const password = 'a-very-distinctive-passphrase';
    const hash = await hashPassword(password);

    assert.ok(!hash.includes(password));
  });

  it('rejects a password shorter than the minimum', async () => {
    await assert.rejects(() => hashPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1)), /at least/);
  });

  it('rejects an absurdly long password rather than truncating it', async () => {
    await assert.rejects(() => hashPassword('x'.repeat(2_000)), /at most/);
  });

  it('treats malformed stored hashes as non-matching instead of throwing', async () => {
    for (const malformed of ['', 'garbage', '1$2$3', 'a$b$c$d$e', '16384$8$1$$']) {
      assert.equal(await verifyPassword('anything', malformed), false, `should reject "${malformed}"`);
    }
  });

  it('flags hashes made with weaker parameters for rehashing', async () => {
    const current = await hashPassword('current parameters');

    assert.equal(needsRehash(current), false);
    assert.equal(needsRehash('1024$8$1$c2FsdA==$a2V5'), true);
  });
});

describe('sessions', () => {
  it('resolves a freshly created session to its user', async () => {
    const user = await createUser();
    const token = await createSession(user.id, 'test-agent');

    const resolved = await resolveSessionToken(token);

    assert.equal(resolved?.id, user.id);
    assert.equal(resolved?.email, user.email);
  });

  it('stores only the hash of the token, never the token itself', async () => {
    const user = await createUser();
    const token = await createSession(user.id);

    const rows = await prisma.session.findMany();

    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].tokenHash, token);
    assert.equal(rows[0].tokenHash, createHash('sha256').update(token).digest('hex'));
  });

  it('rejects an unknown token', async () => {
    assert.equal(await resolveSessionToken('not-a-real-token'), null);
    assert.equal(await resolveSessionToken(''), null);
  });

  it('rejects an expired session and deletes the row', async () => {
    const user = await createUser();
    const token = await createSession(user.id);

    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } });

    assert.equal(await resolveSessionToken(token), null);
    assert.equal(await prisma.session.count(), 0, 'the expired row should have been cleaned up');
  });

  it('extends an expiry that is close to lapsing', async () => {
    const user = await createUser();
    const token = await createSession(user.id);

    const soon = new Date(Date.now() + 60_000);
    await prisma.session.updateMany({ data: { expiresAt: soon } });

    assert.ok(await resolveSessionToken(token));

    const renewed = await prisma.session.findFirstOrThrow();
    assert.ok(
      renewed.expiresAt.getTime() > soon.getTime() + 60_000,
      'a session used near its expiry should be extended',
    );
  });

  it('invalidates every session for a user at once', async () => {
    const user = await createUser();
    const other = await createUser();

    const tokens = [await createSession(user.id), await createSession(user.id)];
    const survivor = await createSession(other.id);

    await destroyAllSessions(user.id);

    for (const token of tokens) {
      assert.equal(await resolveSessionToken(token), null);
    }

    assert.ok(await resolveSessionToken(survivor), "another user's session must be untouched");
  });

  it('drops sessions when the user is deleted', async () => {
    const user = await createUser();
    const token = await createSession(user.id);

    await prisma.user.delete({ where: { id: user.id } });

    assert.equal(await resolveSessionToken(token), null);
    assert.equal(await prisma.session.count(), 0);
  });
});
