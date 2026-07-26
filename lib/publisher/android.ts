import { stat } from 'fs/promises';
import { z } from 'zod';
import type {
  OnboardingDriver,
  OnboardingRequest,
  OnboardingResult,
  Publisher,
  PublishRequest,
  PublishResult,
} from './types';
import { getEnv } from '@/lib/env';
import { PublishError, permanent, transient } from './errors';
import { AdbError } from '@/lib/android/adb';
import type { AndroidDevice } from '@/lib/android/device';
import {
  AttachedDeviceProvider,
  PackageNotInstalledError,
  type AcquiredDevice,
  type DeviceProvider,
} from '@/lib/android/deviceProvider';
import { EphemeralRedroidProvider, redroidConfigSchema } from '@/lib/android/redroidProvider';
import {
  AppiumProtocolError,
  AppiumTransportError,
  createAppiumSession,
  deleteAppiumSession,
  type AppiumSessionInfo,
} from '@/lib/android/appium';
import { captureEvidence } from '@/lib/android/evidence';
import { redactProxyUrl, type ProxyRuntimeConfig } from '@/lib/proxy/config';
import { runUiFlow, uiFlowSchema, type UiFlowResult, UiStepError } from '@/lib/android/uiFlow';

/**
 * No platform defaults live here on purpose. The previous version defaulted to
 * TikTok's package and a set of guessed selectors, which meant a
 * misconfigured account silently drove the wrong app. The package and the flow
 * are now required: an account that has not declared what to automate cannot
 * produce a run at all, let alone a passing one.
 */
export const androidCredentialsSchema = z.object({
  appiumUrl: z.string().url(),
  adbCommand: z.string().min(1).default('adb'),

  /**
   * Addresses the adb *server*. Point it at the one Appium uses so both see the
   * same device list — that is what lets the worker `adb connect` a container
   * and have Appium find it.
   */
  adbHost: z.string().min(1).optional(),
  adbPort: z.number().int().positive().optional(),

  /** Only for an already-running device; an ephemeral container names its own. */
  deviceSerial: z.string().min(1).optional(),

  /** Present means: create a throwaway Android container for every job. */
  redroid: redroidConfigSchema.optional(),

  remoteVideoPath: z.string().min(1).startsWith('/').default('/sdcard/DCIM/upload.mp4'),

  packageName: z.string().min(1),
  /** Optional: without it the launcher activity is resolved by Android itself. */
  activityName: z.string().min(1).optional(),

  /**
   * APK on the worker's filesystem, installed onto the device when the package
   * is absent.
   *
   * This is how the app reaches an ephemeral container. Baking it into a
   * ReDroid image does not work — user apps live under /data, which ReDroid
   * mounts at runtime, so `docker commit` never captures them. The image builds
   * and verifies and still comes out empty.
   */
  apkPath: z.string().min(1).optional(),

  bootTimeoutSeconds: z.number().int().positive().max(900).default(180),
  appiumTimeoutSeconds: z.number().int().positive().max(900).default(120),
  /** Grace period between launching the app and the first step of the flow. */
  launchSettleMs: z.number().int().nonnegative().max(60_000).default(3_000),

  flow: uiFlowSchema,

  /**
   * Run after a person says they finished logging in, to check that they
   * actually did. Required to use INTERACTIVE_ONBOARDING at all: marking an
   * account VERIFIED because someone clicked a button is the same category of
   * lie as the synthetic post id this driver used to return.
   */
  verifyFlow: uiFlowSchema.optional(),
});

export type AndroidCredentials = z.infer<typeof androidCredentialsSchema>;

export interface AndroidPublisherDeps {
  /** Injected by tests; production picks a provider from the account's credentials. */
  createProvider?: (credentials: AndroidCredentials, proxy: ProxyRuntimeConfig | null) => DeviceProvider;
}

function parseCredentials(raw: unknown): AndroidCredentials {
  // Worth its own message: schema output for a null root reads "expected
  // object, received null", which is true and tells you nothing about the
  // account never having been given credentials in the first place. The seeded
  // development account is deliberately in this state.
  if (raw === null || raw === undefined) {
    throw permanent(
      'account_has_no_credentials',
      'This account has no stored credentials, so there is nothing telling the worker which app to drive. ' +
        'Create one with:  npm run account:add -- --user <userId> --name <name> --driver android --credentials-file <file.json>',
    );
  }

  const parsed = androidCredentialsSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    throw permanent('invalid_android_credentials', `Android account is misconfigured — ${issues}`);
  }

  return parsed.data;
}

/**
 * Builds the viewer URL from the configured template.
 *
 * Two placeholders, because ws-scrcpy needs the serial at two nesting levels:
 * once in its own `udid` parameter, and again inside the `ws` parameter, whose
 * whole value is percent-encoded — so the serial there ends up encoded twice
 * (`:` becomes `%253A`, not `%3A`). Getting that wrong produces a viewer that
 * loads and shows a grey rectangle, with no error anywhere.
 *
 *   {serial}        serial encoded once
 *   {serialDouble}  serial encoded twice, for use inside an encoded parameter
 *
 * Empty template means no screen bridge is wired up; the job still runs.
 */
/**
 * A remote path nothing has used before.
 *
 * MediaStore keeps a row per file under /sdcard, and a delete performed outside
 * MediaProvider — `adb shell rm`, or a container torn down mid-run — removes
 * the file and leaves the row behind. Creating that same path again then fails
 * with "remote couldn't create file: Operation not permitted", in a directory
 * that accepts any other name perfectly well. Since /sdcard lives inside the
 * persisted session volume, a single interrupted run would otherwise poison
 * that path for every future job on the account.
 *
 * Nothing depends on the name: the flow picks the most recent item in the
 * gallery, and `{{remoteVideoPath}}` resolves to whatever this returns.
 */
export function uniqueRemotePath(configured: string, jobId: string): string {
  if (configured.includes('{jobId}')) {
    return configured.split('{jobId}').join(jobId);
  }

  const slash = configured.lastIndexOf('/');
  const dot = configured.lastIndexOf('.');

  return dot > slash
    ? `${configured.slice(0, dot)}-${jobId}${configured.slice(dot)}`
    : `${configured}-${jobId}`;
}

function viewerUrlFor(serial: string): string | undefined {
  const template = getEnv().DEVICE_VIEWER_URL_TEMPLATE;

  if (!template) {
    return undefined;
  }

  const once = encodeURIComponent(serial);

  return template.split('{serialDouble}').join(encodeURIComponent(once)).split('{serial}').join(once);
}

function defaultProvider(
  credentials: AndroidCredentials,
  proxy: ProxyRuntimeConfig | null,
): DeviceProvider {
  const adbServer =
    credentials.adbHost || credentials.adbPort
      ? { host: credentials.adbHost, port: credentials.adbPort }
      : undefined;

  if (credentials.redroid) {
    return new EphemeralRedroidProvider({
      config: credentials.redroid,
      proxy,
      adbCommand: credentials.adbCommand,
      adbServer,
      bootTimeoutSeconds: credentials.bootTimeoutSeconds,
    });
  }

  // An account with a proxy cannot run on a device this system did not create:
  // the isolation comes from owning the container's network namespace, and
  // there is no namespace to own here. Refusing is the only honest answer —
  // running anyway would put the account's traffic on the host's address while
  // the dashboard shows a proxy next to its name.
  if (proxy) {
    throw permanent(
      'proxy_requires_ephemeral_device',
      'This account is assigned a proxy, which is enforced by running the device inside a gateway ' +
        "container's network namespace. That is only possible for containers this worker creates, so " +
        'the account needs a `redroid` block in its credentials — or no proxy.',
    );
  }

  return new AttachedDeviceProvider({
    adbCommand: credentials.adbCommand,
    deviceSerial: credentials.deviceSerial,
    adbHost: credentials.adbHost,
    adbPort: credentials.adbPort,
    bootTimeoutSeconds: credentials.bootTimeoutSeconds,
  });
}

/**
 * Maps a failure onto the worker's retry policy. The distinction that matters:
 * infrastructure that is not up yet is worth retrying, a flow whose selectors
 * do not match is not — three retries on a wrong selector burn five minutes and
 * report the same thing, while hiding a genuine app defect behind "attempt 3/3".
 */
function classify(error: unknown): PublishError {
  if (error instanceof PublishError) {
    return error;
  }

  if (error instanceof PackageNotInstalledError) {
    return permanent('app_not_installed', error.message, error);
  }

  if (error instanceof UiStepError) {
    if (error.kind === 'interaction_failed') {
      return transient('ui_interaction_failed', error.message, error);
    }

    return permanent(
      error.kind === 'not_found' ? 'ui_step_not_found' : 'ui_step_still_present',
      error.message,
      error,
    );
  }

  if (error instanceof AppiumTransportError) {
    return transient('appium_unreachable', error.message, error);
  }

  if (error instanceof AppiumProtocolError) {
    // A dead session usually means the device or the Appium server restarted.
    const sessionLost = error.appiumError === 'invalid session id' || error.status === 404;
    return sessionLost
      ? transient('appium_session_lost', error.message, error)
      : permanent('appium_rejected_request', error.message, error);
  }

  if (error instanceof AdbError) {
    return error.unreachable
      ? transient('device_unreachable', error.message, error)
      : permanent('adb_command_rejected', error.message, error);
  }

  return transient('android_flow_failed', error instanceof Error ? error.message : String(error), error);
}

export class AndroidPublisher implements Publisher, OnboardingDriver {
  readonly name = 'android';

  constructor(private readonly deps: AndroidPublisherDeps = {}) {}

  /**
   * Brings up a device, puts the app on screen, hands it to a person, and waits.
   *
   * The shape is deliberately the inverse of publish(): nothing here drives the
   * UI. The worker's only jobs are to make the device reachable, to stay out of
   * the way while a human uses it, and to guarantee the device is destroyed
   * afterwards no matter how the wait ended.
   */
  async onboard(request: OnboardingRequest): Promise<OnboardingResult> {
    const { account, log, signal, jobId } = request;
    const credentials = parseCredentials(account.credentials);

    // Checked before a container is created, not after a person has spent five
    // minutes logging in, because the answer does not depend on either.
    if (!credentials.verifyFlow) {
      throw permanent(
        'no_verify_flow',
        'Interactive onboarding requires a verifyFlow in the account credentials — ' +
          'without one there is no way to confirm the login actually happened.',
      );
    }

    const provider = (this.deps.createProvider ?? defaultProvider)(credentials, account.proxy);

    await log.info('Starting interactive onboarding', {
      accountId: account.id,
      packageName: credentials.packageName,
      provider: provider.kind,
      egress: account.proxy ? redactProxyUrl(account.proxy) : 'host network',
    });

    let acquired: AcquiredDevice | null = null;
    let session: AppiumSessionInfo | null = null;

    try {
      acquired = await this.acquire(provider, credentials, account.id, jobId, log, signal);

      await acquired.device.launch(credentials.packageName, credentials.activityName, signal);

      if (credentials.launchSettleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, credentials.launchSettleMs));
      }

      // This, not the launch command's exit code, is what decides whether the
      // app came up.
      if (!(await acquired.device.isAppRunning(credentials.packageName, signal))) {
        throw permanent(
          'app_not_running',
          `${credentials.packageName} is not running after launch — nothing for the operator to log into`,
        );
      }

      const serial = acquired.serial ?? credentials.deviceSerial ?? 'unknown';

      await request.onDeviceReady({
        serial,
        adbHost: credentials.adbHost,
        adbPort: credentials.adbPort,
        viewerUrl: viewerUrlFor(serial),
      });

      const outcome = await request.awaitHuman();

      if (outcome.kind === 'cancelled') {
        await log.warn('Onboarding cancelled while waiting for the operator', { reason: outcome.reason });
        return { outcome: 'cancelled', details: outcome.reason };
      }

      if (outcome.kind === 'expired') {
        await log.warn('Onboarding abandoned', { reason: outcome.reason });
        return { outcome: 'abandoned', details: outcome.reason };
      }

      await log.info('Operator confirmed, verifying the session', { confirmedAt: outcome.at.toISOString() });

      session = await this.startSession(credentials, acquired.serial, signal);

      return await this.verify(credentials.verifyFlow, session, jobId, log, signal);
    } catch (error) {
      await this.recordFailure(error, session, jobId, log, signal);
      throw classify(error);
    } finally {
      if (session) {
        await deleteAppiumSession(session, signal).catch(() => undefined);
      }

      // The device dies here whatever happened — confirmed, abandoned,
      // cancelled or crashed. The session volume it was mounting survives, and
      // that is the entire point of the exercise.
      if (acquired) {
        await acquired.release().catch(() => undefined);
      }
    }
  }

  private async verify(
    verifyFlow: AndroidCredentials['flow'],
    session: AppiumSessionInfo,
    jobId: string,
    log: PublishRequest['log'],
    signal: AbortSignal,
  ): Promise<OnboardingResult> {
    try {
      const result = await runUiFlow(session, verifyFlow, { jobId }, log, signal);
      const evidence = await captureEvidence(session, jobId, 'onboarding-verified', signal);

      await log.info('Session verified', {
        executed: result.executed,
        capturedText: result.capturedText,
        screenshotKey: evidence.screenshotKey,
      });

      return { outcome: 'verified', details: result.capturedText };
    } catch (error) {
      // The person said they were done and the app disagrees. That is a real
      // answer, not a crash: report it and leave the account unverified.
      const evidence = await captureEvidence(session, jobId, 'onboarding-unverified', signal);
      const details = error instanceof Error ? error.message : String(error);

      await log.error('Operator confirmed but the session could not be verified', {
        error: details,
        screenshotKey: evidence.screenshotKey,
        pageSourceKey: evidence.pageSourceKey,
      });

      return { outcome: 'unverified', details };
    }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const { caption, account, video, log, signal, jobId } = request;
    const credentials = parseCredentials(account.credentials);

    await this.assertMediaIsStaged(video);

    const provider = (this.deps.createProvider ?? defaultProvider)(credentials, account.proxy);
    const remotePath = uniqueRemotePath(credentials.remoteVideoPath, jobId);

    await log.info('Starting Android run', {
      accountId: account.id,
      packageName: credentials.packageName,
      provider: provider.kind,
      // Recorded per run because the assignment can change between runs, and
      // "which IP did this publication come from" is the first question asked
      // when an account gets flagged. Redacted — see redactProxyUrl.
      egress: account.proxy ? redactProxyUrl(account.proxy) : 'host network',
      remotePath,
      steps: credentials.flow.length,
    });

    let acquired: AcquiredDevice | null = null;
    let mediaPushed = false;
    let session: AppiumSessionInfo | null = null;

    try {
      acquired = await this.acquire(provider, credentials, account.id, jobId, log, signal);

      await this.stageMedia(acquired.device, remotePath, video.localPath, video.sizeBytes, log, signal);
      mediaPushed = true;

      session = await this.startSession(credentials, acquired.serial, signal);
      await log.info('Appium session started', { sessionId: session.sessionId });

      await acquired.device.launch(credentials.packageName, credentials.activityName, signal);

      if (credentials.launchSettleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, credentials.launchSettleMs));
      }

      // A crash on launch is a finding, not a flake. Catching it here gives a
      // precise error instead of a downstream "element not found" that sends
      // you hunting for a selector problem that does not exist.
      if (!(await acquired.device.isAppRunning(credentials.packageName, signal))) {
        throw permanent(
          'app_not_running',
          `${credentials.packageName} is not running after launch — it failed to start or crashed immediately`,
        );
      }

      const result = await runUiFlow(
        session,
        credentials.flow,
        { caption, remoteVideoPath: remotePath, fileName: video.fileName, jobId },
        log,
        signal,
      );

      return await this.succeed(result, jobId, session, log, signal);
    } catch (error) {
      await this.recordFailure(error, session, jobId, log, signal);
      throw classify(error);
    } finally {
      // Ordered innermost-first, and every step is independently guarded: a
      // failure to close the Appium session must not skip destroying the
      // container, which is the expensive thing to leak.
      if (session) {
        await deleteAppiumSession(session, signal).catch(() => undefined);
      }

      if (mediaPushed && acquired) {
        await acquired.device.removeFile(remotePath, signal).catch(() => undefined);
      }

      if (acquired) {
        await acquired.release().catch(() => undefined);
      }
    }
  }

  private async acquire(
    provider: DeviceProvider,
    credentials: AndroidCredentials,
    accountId: string,
    jobId: string,
    log: PublishRequest['log'],
    signal: AbortSignal,
  ): Promise<AcquiredDevice> {
    try {
      return await provider.acquire({
        jobId,
        accountId,
        packageName: credentials.packageName,
        apkPath: credentials.apkPath,
        log,
        signal,
      });
    } catch (error) {
      if (error instanceof PackageNotInstalledError || error instanceof PublishError) {
        throw error;
      }

      // Everything else about bringing up a device — the image pulling, the
      // container booting, ADB refusing the first connection — is the textbook
      // transient failure: one backoff later it usually works.
      throw transient(
        'device_not_ready',
        `Could not obtain an Android device: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  private async assertMediaIsStaged(video: PublishRequest['video']): Promise<void> {
    let sizeOnDisk: number;

    try {
      sizeOnDisk = (await stat(video.localPath)).size;
    } catch (cause) {
      throw transient('media_unreadable', `Staged media is not readable at ${video.localPath}`, cause);
    }

    if (sizeOnDisk !== video.sizeBytes) {
      throw permanent(
        'media_size_mismatch',
        `Staged media is ${sizeOnDisk} bytes but the record says ${video.sizeBytes}`,
      );
    }
  }

  private async stageMedia(
    device: AndroidDevice,
    remotePath: string,
    localPath: string,
    expectedBytes: number,
    log: PublishRequest['log'],
    signal: AbortSignal,
  ): Promise<void> {
    const remoteSize = await device.pushMedia(localPath, remotePath, signal);

    // Verifying the push is what stops a silently truncated transfer from
    // becoming a mysterious failure four steps into the flow.
    if (remoteSize === null) {
      throw transient('media_push_missing', `Pushed ${remotePath} but the device reports no such file`);
    }

    if (remoteSize !== expectedBytes) {
      throw transient(
        'media_push_truncated',
        `Pushed ${expectedBytes} bytes but the device reports ${remoteSize} at ${remotePath}`,
      );
    }

    await device.scanMedia(remotePath, signal);
    await log.debug('Media staged on device', { remotePath, bytes: remoteSize });
  }

  private async startSession(
    credentials: AndroidCredentials,
    serial: string | undefined,
    signal: AbortSignal,
  ): Promise<AppiumSessionInfo> {
    return createAppiumSession(
      credentials.appiumUrl,
      {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:appPackage': credentials.packageName,
        ...(credentials.activityName ? { 'appium:appActivity': credentials.activityName } : {}),
        ...(serial ? { 'appium:udid': serial } : {}),
        'appium:noReset': true,
        'appium:newCommandTimeout': credentials.appiumTimeoutSeconds,
      },
      signal,
    );
  }

  /**
   * The external id is derived from evidence and only reached after the flow's
   * assertions passed. It is deliberately not a random UUID: the old code
   * minted one before touching the UI, so a run that clicked nothing still
   * produced an id that looked like proof of a publication.
   */
  private async succeed(
    result: UiFlowResult,
    jobId: string,
    session: AppiumSessionInfo,
    log: PublishRequest['log'],
    signal: AbortSignal,
  ): Promise<PublishResult> {
    const evidence = await captureEvidence(session, jobId, 'success', signal);

    await log.info('Android flow completed', {
      executed: result.executed,
      skipped: result.skipped,
      capturedText: result.capturedText,
      totalMs: result.totalMs,
      timings: result.timings,
      screenshotKey: evidence.screenshotKey,
      pageSourceKey: evidence.pageSourceKey,
    });

    return {
      externalPostId: result.capturedText ?? `android_${jobId}`,
      metrics: {
        totalMs: result.totalMs,
        steps: result.timings.map((timing) => ({
          name: timing.name,
          action: timing.action,
          ms: timing.ms,
          skipped: timing.skipped,
        })),
      },
    };
  }

  private async recordFailure(
    error: unknown,
    session: AppiumSessionInfo | null,
    jobId: string,
    log: PublishRequest['log'],
    signal: AbortSignal,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const step = error instanceof UiStepError ? { stepName: error.stepName, stepIndex: error.stepIndex } : {};

    if (!session) {
      await log.error('Android run failed before a session existed', { error: message, ...step });
      return;
    }

    const evidence = await captureEvidence(session, jobId, `failure-${'stepName' in step ? step.stepName : 'run'}`, signal);

    await log.error('Android run failed', {
      error: message,
      ...step,
      screenshotKey: evidence.screenshotKey,
      pageSourceKey: evidence.pageSourceKey,
      evidenceFailures: evidence.failures.length > 0 ? evidence.failures : undefined,
    });
  }
}
