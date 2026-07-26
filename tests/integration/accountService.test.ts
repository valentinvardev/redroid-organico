import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/db';
import { open as openSecret } from '@/lib/crypto/secretBox';
import {
  AccountValidationError,
  accountConfigForCloning,
  createAndroidAccount,
} from '@/lib/accounts/service';
import { createAndroidAccountConfig } from '../helpers/fixtures';
import { createUser, reset, teardown } from '../helpers/harness';

beforeEach(reset);
after(teardown);

describe('account service', () => {
  it('creates an Android account from a config the worker would accept', async () => {
    const user = await createUser();

    const account = await createAndroidAccount({
      userId: user.id,
      name: '  SportReels v4  ',
      config: createAndroidAccountConfig(),
    });

    assert.equal(account.name, 'SportReels v4', 'the name is trimmed');
    assert.equal(account.platform, 'SPORT_REELS');
    assert.ok(account.credentials, 'credentials are sealed, not null');

    const opened = openSecret(account.credentials) as { packageName: string };
    assert.equal(opened.packageName, 'com.target.app');
  });

  it('rejects a config the worker could not run, with a field-level message', async () => {
    const user = await createUser();
    const broken = createAndroidAccountConfig();
    delete (broken as Record<string, unknown>).packageName;

    await assert.rejects(
      createAndroidAccount({ userId: user.id, name: 'broken', config: broken }),
      (error: unknown) => error instanceof AccountValidationError && /packageName/.test((error as Error).message),
    );

    assert.equal(await prisma.account.count(), 0, 'nothing is created when validation fails');
  });

  it('refuses an empty name', async () => {
    const user = await createUser();
    await assert.rejects(
      createAndroidAccount({ userId: user.id, name: '   ', config: createAndroidAccountConfig() }),
      AccountValidationError,
    );
  });

  it('returns a cloneable config without any secret keys', async () => {
    const user = await createUser();
    const account = await createAndroidAccount({
      userId: user.id,
      name: 'source',
      // A stray secret-looking key must not survive the round-trip.
      config: { ...createAndroidAccountConfig(), apiKey: 'should-not-come-back' },
    });

    const config = (await accountConfigForCloning(user.id, account.id)) as Record<string, unknown>;

    assert.ok(config, 'an Android account has a cloneable config');
    assert.equal(config.packageName, 'com.target.app');
    assert.ok(!('apiKey' in config) || config.apiKey === undefined, 'secret keys are stripped');
  });

  it('does not clone across users', async () => {
    const owner = await createUser();
    const other = await createUser();
    const account = await createAndroidAccount({
      userId: owner.id,
      name: 'owned',
      config: createAndroidAccountConfig(),
    });

    assert.equal(await accountConfigForCloning(other.id, account.id), null);
  });
});
