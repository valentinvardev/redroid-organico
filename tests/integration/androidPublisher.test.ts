import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { PublishRequest } from '@/lib/publisher/types';
import { AndroidPublisher, uniqueRemotePath } from '@/lib/publisher/android';
import { PublishError } from '@/lib/publisher/errors';
import { FakeAppium, FakeDevice, FakeDeviceProvider, type FakeDeviceOptions } from '../helpers/fakeAppium';

const MEDIA_BYTES = Buffer.from('fake video content');
const tempDir = path.join(tmpdir(), 'redroid-organico-android');
const mediaPath = path.join(tempDir, `video-${randomUUID()}.mp4`);

const silentLog = {
  debug: async () => undefined,
  info: async () => undefined,
  warn: async () => undefined,
  error: async () => undefined,
} as unknown as PublishRequest['log'];

let appium: FakeAppium;

/** The minimal honest flow: do something, then assert that it worked. */
function workingFlow() {
  return [
    { action: 'tap', name: 'open composer', using: 'accessibility id', value: 'compose', timeoutMs: 300 },
    {
      action: 'type',
      name: 'write caption',
      using: 'id',
      value: 'com.sportreels.app:id/caption',
      text: '{{caption}}',
      timeoutMs: 300,
    },
    { action: 'tap', name: 'submit', using: 'id', value: 'com.sportreels.app:id/submit', timeoutMs: 300 },
    {
      action: 'assertVisible',
      name: 'upload confirmed',
      using: 'id',
      value: 'com.sportreels.app:id/upload_id',
      captureText: true,
      timeoutMs: 300,
    },
  ];
}

function credentials(overrides: Record<string, unknown> = {}) {
  return {
    appiumUrl: appium.baseUrl,
    deviceSerial: 'emulator-5554',
    packageName: 'com.sportreels.app',
    remoteVideoPath: '/sdcard/DCIM/upload.mp4',
    launchSettleMs: 0,
    bootTimeoutSeconds: 1,
    flow: workingFlow(),
    ...overrides,
  };
}

function request(
  overrides: {
    credentials?: unknown;
    caption?: string;
    sizeBytes?: number;
    proxy?: PublishRequest['account']['proxy'];
  } = {},
): PublishRequest {
  return {
    jobId: 'job-under-test',
    caption: overrides.caption ?? 'Caption from the job',
    account: {
      id: 'account-1',
      name: 'Android device',
      platform: 'SPORT_REELS',
      externalId: null,
      credentials: 'credentials' in overrides ? overrides.credentials : credentials(),
      proxy: overrides.proxy ?? null,
    },
    video: {
      id: 'video-1',
      localPath: mediaPath,
      fileName: 'video.mp4',
      mimeType: 'video/mp4',
      sizeBytes: overrides.sizeBytes ?? MEDIA_BYTES.length,
      durationSeconds: 5,
      width: 1080,
      height: 1920,
    },
    log: silentLog,
    signal: new AbortController().signal,
  };
}

function publisher(deviceOptions: FakeDeviceOptions = {}) {
  const device = new FakeDevice(deviceOptions);
  const provider = new FakeDeviceProvider(device);
  return { device, provider, publisher: new AndroidPublisher({ createProvider: () => provider }) };
}

async function rejection(promise: Promise<unknown>): Promise<PublishError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PublishError, `expected a PublishError, got ${String(error)}`);
    return error;
  }

  throw new assert.AssertionError({ message: 'expected the publish to reject, but it resolved' });
}

describe('AndroidPublisher', () => {
  before(async () => {
    await mkdir(tempDir, { recursive: true });
    await writeFile(mediaPath, MEDIA_BYTES);
    appium = await FakeAppium.start();
  });

  after(async () => {
    await appium.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('fails instead of reporting success when a required element never appears', async () => {
    // The composer opens, and then the app never shows the caption field. The
    // old driver swallowed this and returned a synthetic post id anyway.
    appium.elements.clear();
    appium.present('accessibility id', 'compose');

    const { device, provider, publisher: subject } = publisher();
    const error = await rejection(subject.publish(request()));

    assert.equal(error.code, 'ui_step_not_found');
    assert.equal(error.retryable, false, 'a selector that never matches must not be retried');
    assert.match(error.message, /write caption/);
    assert.match(error.message, /com\.sportreels\.app:id\/caption/);

    // It got far enough to click the first button, so the failure is the
    // missing field and not an earlier problem.
    assert.equal(appium.clicks.length, 1);
    // Cleanup still ran despite the failure.
    assert.deepEqual(device.removed, ['/sdcard/DCIM/upload-job-under-test.mp4']);
    assert.equal(provider.released, 1, 'the device must be released even when the flow fails');
  });

  it('releases the device when Appium blows up catastrophically mid-run', async () => {
    appium.elements.clear();
    appium.present('accessibility id', 'compose');

    const { provider, publisher: subject } = publisher();

    // The server stops answering entirely once the run is under way. This is
    // the case that would otherwise strand a container.
    appium.offline = true;
    const error = await rejection(subject.publish(request()));
    appium.offline = false;

    assert.equal(error.retryable, true);
    assert.equal(provider.released, 1, 'a catastrophic Appium failure must still release the device');
  });

  it('does not retry when the app under test is not installed', async () => {
    appium.elements.clear();

    const { provider, publisher: subject } = publisher({ packageInstalled: false });
    const error = await rejection(subject.publish(request()));

    assert.equal(error.code, 'app_not_installed');
    assert.equal(error.retryable, false);
    assert.equal(provider.released, 0, 'acquisition failed, so there is nothing to release');
  });

  it('never reuses a remote path, because MediaStore remembers deleted ones', async () => {
    assert.equal(
      uniqueRemotePath('/sdcard/DCIM/upload.mp4', 'job-1'),
      '/sdcard/DCIM/upload-job-1.mp4',
      'the job id goes before the extension so the file stays a .mp4',
    );

    assert.equal(
      uniqueRemotePath('/sdcard/Movies/{jobId}.mp4', 'job-1'),
      '/sdcard/Movies/job-1.mp4',
      'an explicit placeholder wins over the automatic suffix',
    );

    assert.equal(
      uniqueRemotePath('/sdcard/DCIM/upload', 'job-1'),
      '/sdcard/DCIM/upload-job-1',
      'a path with no extension still gets a unique name',
    );

    // A dot in a directory name is not an extension.
    assert.equal(uniqueRemotePath('/sdcard/my.files/upload', 'job-1'), '/sdcard/my.files/upload-job-1');
  });

  it('refuses a flow that asserts nothing', async () => {
    appium.elements.clear();
    appium.present('accessibility id', 'compose');

    const { publisher: subject } = publisher();
    const error = await rejection(
      subject.publish(
        request({
          credentials: credentials({
            flow: [{ action: 'tap', name: 'open composer', using: 'accessibility id', value: 'compose' }],
          }),
        }),
      ),
    );

    assert.equal(error.code, 'invalid_android_credentials');
    assert.equal(error.retryable, false);
    assert.match(error.message, /at least one assertVisible or assertGone/);
  });

  it('completes the flow and takes the external id from the asserted element', async () => {
    appium.elements.clear();
    appium
      .present('accessibility id', 'compose')
      .present('id', 'com.sportreels.app:id/caption')
      .present('id', 'com.sportreels.app:id/submit')
      .present('id', 'com.sportreels.app:id/upload_id', { text: 'upload-9f2c' });

    const before = appium.typed.length;
    const { device, publisher: subject } = publisher();
    const result = await subject.publish(request({ caption: 'Hola desde el worker' }));

    assert.equal(result.externalPostId, 'upload-9f2c');
    assert.equal(appium.typed[before].text, 'Hola desde el worker', 'the caption placeholder must be interpolated');
    assert.deepEqual(device.launches, [{ packageName: 'com.sportreels.app', activityName: undefined }]);
    assert.deepEqual(device.scanned, ['/sdcard/DCIM/upload-job-under-test.mp4']);
    assert.deepEqual(device.removed, ['/sdcard/DCIM/upload-job-under-test.mp4']);
  });

  it('waits for an element that is slow to appear rather than failing at once', async () => {
    appium.elements.clear();
    appium
      .present('accessibility id', 'compose')
      .present('id', 'com.sportreels.app:id/caption')
      .present('id', 'com.sportreels.app:id/submit')
      .present('id', 'com.sportreels.app:id/upload_id', { text: 'slow-1', appearsAfterLookups: 3 });

    const { publisher: subject } = publisher();
    const result = await subject.publish(request({ credentials: credentials({ flow: workingFlow() }) }));

    assert.equal(result.externalPostId, 'slow-1');
  });

  it('skips an optional step whose element is absent, and says so', async () => {
    appium.elements.clear();
    appium
      .present('accessibility id', 'compose')
      .present('id', 'com.sportreels.app:id/upload_id', { text: 'ok-1' });

    const flow = [
      {
        action: 'tap',
        name: 'dismiss notifications dialog',
        using: 'id',
        value: 'android:id/button1',
        optional: true,
        timeoutMs: 300,
      },
      { action: 'tap', name: 'open composer', using: 'accessibility id', value: 'compose', timeoutMs: 300 },
      {
        action: 'assertVisible',
        name: 'upload confirmed',
        using: 'id',
        value: 'com.sportreels.app:id/upload_id',
        captureText: true,
        timeoutMs: 300,
      },
    ];

    const { publisher: subject } = publisher();
    const result = await subject.publish(request({ credentials: credentials({ flow }) }));

    assert.equal(result.externalPostId, 'ok-1');
  });

  it('retries later when the device has not finished booting', async () => {
    appium.elements.clear();

    const { publisher: subject } = publisher({ bootsWithin: false });
    const error = await rejection(subject.publish(request()));

    assert.equal(error.code, 'device_not_ready');
    assert.equal(error.retryable, true, 'a container that is still booting deserves another attempt');
  });

  it('retries later when the pushed media does not land intact', async () => {
    appium.elements.clear();

    const { publisher: subject } = publisher({ reportedSize: 4 });
    const error = await rejection(subject.publish(request()));

    assert.equal(error.code, 'media_push_truncated');
    assert.equal(error.retryable, true);
    assert.match(error.message, /reports 4/);
  });

  it('reports a crash on launch as a finding, not as a flake', async () => {
    appium.elements.clear();

    const { publisher: subject } = publisher({ appRuns: false });
    const error = await rejection(subject.publish(request()));

    assert.equal(error.code, 'app_not_running');
    assert.equal(error.retryable, false);
  });

  it('says so plainly when the account has no credentials at all', async () => {
    const { publisher: subject } = publisher();
    const error = await rejection(subject.publish(request({ credentials: null })));

    assert.equal(error.code, 'account_has_no_credentials');
    assert.equal(error.retryable, false);
    assert.match(error.message, /account:add/, 'the message should say how to fix it');
  });

  it('rejects an account that never declared which package to drive', async () => {
    const { publisher: subject } = publisher();
    const invalid = credentials();
    delete (invalid as Record<string, unknown>).packageName;

    const error = await rejection(subject.publish(request({ credentials: invalid })));

    assert.equal(error.code, 'invalid_android_credentials');
    assert.equal(error.retryable, false);
    assert.match(error.message, /packageName/);
  });

  it('retries when Appium itself is unreachable', async () => {
    appium.elements.clear();

    const { publisher: subject } = publisher();
    const error = await rejection(
      subject.publish(request({ credentials: credentials({ appiumUrl: 'http://127.0.0.1:1/' }) })),
    );

    assert.equal(error.code, 'appium_unreachable');
    assert.equal(error.retryable, true);
  });
});
