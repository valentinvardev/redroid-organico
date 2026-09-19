import type { JobLogger } from '@/lib/logging/jobLogger';
import { AdbDevice, type AndroidDevice } from './device';

export interface AcquireContext {
  jobId: string;
  accountId: string;
  packageName: string;
  /**
   * APK on the worker's filesystem, installed when the device does not already
   * have the package.
   *
   * Baking the app into a ReDroid image does not work: user apps live under
   * /data, which ReDroid mounts at runtime, and `docker commit` only captures
   * the container's writable layer. The image builds and verifies fine and then
   * comes out empty — so installation has to happen against a live device.
   */
  apkPath?: string;
  /**
   * Whether a missing app is fatal. True everywhere except interactive
   * onboarding, where handing a person a usable phone is worth more than the
   * guarantee — they can sideload the app themselves, which is often the very
   * reason the device was asked for. Publishing keeps the guarantee: a flow
   * driven against an app that is not there is the failure that reports
   * success without doing anything.
   */
  requirePackage?: boolean;
  log: JobLogger;
  signal: AbortSignal;
}

export interface AcquiredDevice {
  device: AndroidDevice;
  /** What ADB and Appium's `udid` must both be pointed at. */
  serial: string | undefined;
  /**
   * The address the device was measured leaving from, when a proxy was in play
   * and the check ran. Carried out of here rather than re-measured later: it is
   * the number the egress gate already proved, and asking twice could answer
   * differently on a rotating proxy.
   */
  egressIp?: string;
  /**
   * Returns the device. Must never throw and must never be skipped — this is
   * what stops a failed run from leaving an Android instance behind.
   */
  release(): Promise<void>;
}

export interface DeviceProvider {
  readonly kind: string;
  acquire(context: AcquireContext): Promise<AcquiredDevice>;
}

export interface AttachedDeviceConfig {
  adbCommand: string;
  deviceSerial?: string;
  adbHost?: string;
  adbPort?: number;
  bootTimeoutSeconds: number;
}

/**
 * The device already exists and outlives the job: a local AVD, a phone on USB,
 * a ReDroid container someone else manages. Acquiring is just addressing it,
 * and releasing does nothing — tearing down a device this system did not create
 * would be a surprise, not a cleanup.
 */
export class AttachedDeviceProvider implements DeviceProvider {
  readonly kind = 'attached';

  constructor(private readonly config: AttachedDeviceConfig) {}

  async acquire(context: AcquireContext): Promise<AcquiredDevice> {
    const device = new AdbDevice(this.config.adbCommand, {
      serial: this.config.deviceSerial,
      host: this.config.adbHost,
      port: this.config.adbPort,
    });

    await device.waitUntilReady(this.config.bootTimeoutSeconds * 1_000, context.signal);
    await ensurePackageInstalled(device, context);

    return {
      device,
      serial: this.config.deviceSerial,
      release: async () => undefined,
    };
  }
}

/** The app under test is absent. Retrying cannot install it. */
export class PackageNotInstalledError extends Error {
  constructor(readonly packageName: string) {
    super(
      `${packageName} is not installed on the device. For an ephemeral container this means ` +
        'the golden image was built without the app under test.',
    );
    this.name = 'PackageNotInstalledError';
  }
}

/**
 * Guarantees the app is on the device before anything tries to drive it.
 *
 * Checked up front because "the app is not installed" and "your selector is
 * wrong" look identical four steps into a flow. Installed here rather than
 * baked into an image because a ReDroid image cannot carry it — see apkPath.
 *
 * On a persistent session volume this costs nothing after the first run: the
 * install survives in /data along with the login.
 */
export async function ensurePackageInstalled(
  device: AndroidDevice,
  context: AcquireContext,
): Promise<void> {
  const required = context.requirePackage ?? true;

  if (await device.isPackageInstalled(context.packageName, context.signal)) {
    return;
  }

  if (!context.apkPath) {
    if (!required) {
      await context.log.warn(
        'The app is not on the device and no apkPath was configured. Handing over the phone anyway — ' +
          'install it yourself before confirming, or the verification flow will have nothing to check.',
        { packageName: context.packageName },
      );
      return;
    }

    throw new PackageNotInstalledError(context.packageName);
  }

  await context.log.info('App is missing from the device, installing it', {
    packageName: context.packageName,
    apkPath: context.apkPath,
  });

  try {
    await device.installPackage(context.apkPath, context.signal);
  } catch (error) {
    if (required) {
      throw error;
    }

    // A broken APK path, a signature conflict with an older install, no space
    // on the device: all of them leave a working phone that a person can still
    // use, so none of them are worth destroying it over here.
    await context.log.warn('Could not install the app; handing over the phone without it', {
      packageName: context.packageName,
      apkPath: context.apkPath,
      error: error instanceof Error ? error.message : String(error),
    });

    return;
  }

  // Trust the check, not the installer: `adb install` has been known to report
  // success for a package the package manager then cannot resolve.
  if (!(await device.isPackageInstalled(context.packageName, context.signal))) {
    if (!required) {
      await context.log.warn(
        'The installer reported success but the package manager cannot resolve the app. ' +
          'Handing over the phone anyway.',
        { packageName: context.packageName },
      );
      return;
    }

    throw new PackageNotInstalledError(context.packageName);
  }

  await context.log.info('App installed', { packageName: context.packageName });
}
