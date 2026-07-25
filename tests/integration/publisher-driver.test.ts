import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { after, before, describe, it } from 'node:test';
import { NoOpPublisher } from '@/lib/publisher/noop';
import { AndroidPublisher } from '@/lib/publisher/android';
import { getPublisher, resetPublisherCache } from '@/lib/publisher/registry';
import { resetEnvCache } from '@/lib/env';

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  CREDENTIALS_KEY: process.env.CREDENTIALS_KEY,
  PUBLISHER_DRIVER: process.env.PUBLISHER_DRIVER,
};

describe('publisher registry', () => {
  before(() => {
    process.env.DATABASE_URL ||= 'postgresql://localhost:5432/redroid_test?schema=public';
    process.env.REDIS_URL ||= 'redis://localhost:6379/1';
    process.env.CREDENTIALS_KEY ||= randomBytes(32).toString('base64');
    resetEnvCache();
    resetPublisherCache();
  });

  after(() => {
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.REDIS_URL = originalEnv.REDIS_URL;
    process.env.CREDENTIALS_KEY = originalEnv.CREDENTIALS_KEY;
    process.env.PUBLISHER_DRIVER = originalEnv.PUBLISHER_DRIVER;
    resetEnvCache();
    resetPublisherCache();
  });

  it('resolves noop driver when configured', () => {
    process.env.PUBLISHER_DRIVER = 'noop';
    resetEnvCache();
    resetPublisherCache();

    const publisher = getPublisher();
    assert.ok(publisher instanceof NoOpPublisher, 'expected NoOpPublisher');
  });

  it('resolves stub driver by default', () => {
    delete process.env.PUBLISHER_DRIVER;
    resetEnvCache();
    resetPublisherCache();

    const publisher = getPublisher();
    assert.equal(publisher.name, 'stub');
  });

  it('resolves android driver when configured', () => {
    process.env.PUBLISHER_DRIVER = 'android';
    resetEnvCache();
    resetPublisherCache();

    const publisher = getPublisher();
    assert.ok(publisher instanceof AndroidPublisher, 'expected AndroidPublisher');
  });
});
