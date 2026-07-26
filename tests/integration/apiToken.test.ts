import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/db';
import { bearerFromHeader, createApiToken, resolveApiToken } from '@/lib/auth/apiToken';
import { createUser, reset, teardown } from '../helpers/harness';

beforeEach(reset);
after(teardown);

describe('API tokens', () => {
  it('resolves a freshly created token to its user and records use', async () => {
    const user = await createUser();
    const { token } = await createApiToken(user.id, 'staging site');

    const resolved = await resolveApiToken(token);
    assert.equal(resolved?.id, user.id);

    // lastUsedAt is written best-effort, off the request path; give it a beat.
    await new Promise((r) => setTimeout(r, 50));
    const row = await prisma.apiToken.findFirst({ where: { userId: user.id } });
    assert.ok(row?.lastUsedAt, 'a used token records when it was last used');
  });

  it('rejects a token that is not one of ours without touching the database', async () => {
    assert.equal(await resolveApiToken('not-a-real-token'), null);
    assert.equal(await resolveApiToken('Bearer something'), null);
  });

  it('rejects a well-formed token that does not exist', async () => {
    const user = await createUser();
    const { token } = await createApiToken(user.id, 'real');
    // Same prefix, wrong body.
    const forged = `${token.slice(0, 4)}${'A'.repeat(token.length - 4)}`;
    assert.equal(await resolveApiToken(forged), null);
  });

  it('rejects and deletes an expired token', async () => {
    const user = await createUser();
    const { id, token } = await createApiToken(user.id, 'short-lived', new Date(Date.now() - 1000));

    assert.equal(await resolveApiToken(token), null);
    assert.equal(await prisma.apiToken.findUnique({ where: { id } }), null, 'an expired token is removed on use');
  });

  it('parses the Authorization header case-insensitively', () => {
    assert.equal(bearerFromHeader('Bearer abc123'), 'abc123');
    assert.equal(bearerFromHeader('bearer   abc123  '), 'abc123');
    assert.equal(bearerFromHeader('Basic abc123'), null);
    assert.equal(bearerFromHeader(null), null);
  });

  it('a revoked token stops working immediately', async () => {
    const user = await createUser();
    const { id, token } = await createApiToken(user.id, 'to be revoked');

    assert.ok(await resolveApiToken(token));
    await prisma.apiToken.delete({ where: { id } });
    assert.equal(await resolveApiToken(token), null);
  });
});
