import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/db';
import { open as openSecret, seal } from '@/lib/crypto/secretBox';
import { FlowValidationError, readFlows, writeFlows } from '@/lib/accounts/flows';
import { createUser, reset, teardown } from '../helpers/harness';

after(async () => {
  await teardown();
});

const step = (value: string) => ({
  action: 'assertVisible' as const,
  name: 'confirms',
  using: 'id' as const,
  value,
  timeoutMs: 5_000,
});

describe('editing an account’s automations', () => {
  let userId: string;
  let accountId: string;

  before(async () => {
    await reset();
    userId = (await createUser()).id;
  });

  beforeEach(async () => {
    await prisma.account.deleteMany({});

    const account = await prisma.account.create({
      data: {
        userId,
        name: 'Cuenta',
        platform: 'SPORT_REELS',
        credentials: seal({
          appiumUrl: 'http://appium:4723',
          packageName: 'com.target.app',
          apkPath: '/srv/app.apk',
          flow: [step('com.target.app:id/old')],
          verifyFlow: [step('com.target.app:id/handle')],
        }),
      },
    });

    accountId = account.id;
  });

  after(async () => {
    await reset();
  });

  it('hands back the automations and nothing else', async () => {
    const flows = await readFlows(userId, accountId);

    // `in` rather than a cast: a step can be a `wait`, which carries no
    // locator, and the union is the schema telling the truth about that.
    const first = flows.flow[0];
    assert.ok('value' in first);
    assert.equal(first.value, 'com.target.app:id/old');

    // The rest of the credentials never travels: an OAuth account keeps live
    // tokens in that blob, and a screen that never had them cannot leak them.
    const serialized = JSON.stringify(flows);
    assert.equal(serialized.includes('appium'), false);
    assert.equal(serialized.includes('/srv/app.apk'), false);
  });

  it('replaces the flows and leaves the rest of the configuration alone', async () => {
    await writeFlows(userId, accountId, {
      flow: [step('com.target.app:id/new')],
      verifyFlow: [step('com.target.app:id/handle')],
    });

    const stored = openSecret<Record<string, unknown>>(
      (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).credentials!,
    );

    assert.equal((stored.flow as Array<{ value: string }>)[0].value, 'com.target.app:id/new');

    // The fields the editor never showed have to survive it untouched.
    assert.equal(stored.apkPath, '/srv/app.apk');
    assert.equal(stored.appiumUrl, 'http://appium:4723');
    assert.equal(stored.packageName, 'com.target.app');
  });

  it('refuses a flow with no assertion, which can only ever report success', async () => {
    await assert.rejects(
      writeFlows(userId, accountId, {
        flow: [{ action: 'tap', name: 'x', using: 'id', value: 'a', timeoutMs: 100 }],
      }),
      (error: Error) => {
        assert.ok(error instanceof FlowValidationError);
        assert.match(error.message, /assertVisible or assertGone/);
        return true;
      },
    );

    // And nothing was written: a rejected save must not leave the account half
    // edited.
    const untouched = (await readFlows(userId, accountId)).flow[0];
    assert.ok('value' in untouched);
    assert.equal(untouched.value, 'com.target.app:id/old');
  });

  it('refuses a locator strategy that does not exist', async () => {
    await assert.rejects(
      writeFlows(userId, accountId, {
        flow: [{ action: 'assertVisible', name: 'x', using: 'css selector', value: '.a', timeoutMs: 100 }],
      }),
      FlowValidationError,
    );
  });

  it('will not read or write an account belonging to someone else', async () => {
    const stranger = (await createUser()).id;

    await assert.rejects(readFlows(stranger, accountId), FlowValidationError);
    await assert.rejects(writeFlows(stranger, accountId, { flow: [step('x')] }), FlowValidationError);
  });
});
