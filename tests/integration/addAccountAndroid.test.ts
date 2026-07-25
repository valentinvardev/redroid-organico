import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { resetEnvCache } from '@/lib/env';
import { runAddAccount } from '@/scripts/addAccount';

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  CREDENTIALS_KEY: process.env.CREDENTIALS_KEY,
};

describe('addAccount script', () => {
  before(() => {
    process.env.DATABASE_URL ||= 'postgresql://localhost:5432/redroid_test?schema=public';
    process.env.REDIS_URL ||= 'redis://localhost:6379/1';
    process.env.CREDENTIALS_KEY ||= randomBytes(32).toString('base64');
    resetEnvCache();
  });

  after(() => {
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.REDIS_URL = originalEnv.REDIS_URL;
    process.env.CREDENTIALS_KEY = originalEnv.CREDENTIALS_KEY;
    resetEnvCache();
  });

  it('accepts the shipped example flows, so the templates cannot rot', async () => {
    // Parsed with the same schema the worker uses. If a template ever stops
    // being valid, this fails here rather than at 3am inside a worker.
    const { androidCredentialsSchema } = await import('@/lib/publisher/android');
    const { readFile } = await import('fs/promises');

    // No BOM stripping here on purpose: the templates themselves must be clean,
    // and a BOM sneaking back in should fail this test loudly.
    const flow = JSON.parse(await readFile('examples/flows/upload-video.json', 'utf8'));
    const verifyFlow = JSON.parse(await readFile('examples/flows/verify-session.json', 'utf8'));

    const parsed = androidCredentialsSchema.safeParse({
      appiumUrl: 'http://appium:4723',
      packageName: 'com.sportreels.app',
      flow,
      verifyFlow,
    });

    assert.ok(parsed.success, `example flows must validate: ${JSON.stringify(parsed.error?.issues)}`);
    assert.ok(
      parsed.data.verifyFlow?.some((step) => step.action === 'assertVisible' && step.captureText),
      'the verify flow should capture the handle, so the logs show which account was linked',
    );
  });

  it('rejects creating an android account without appium url', async () => {
    await assert.rejects(
      async () => {
        await runAddAccount([
          'node',
          'scripts/addAccount.ts',
          '--user',
          'missing-user',
          '--name',
          'Android Account',
          '--driver',
          'android',
        ]);
      },
      {
        message: 'Android driver requires --appium-url',
      },
    );
  });
});
