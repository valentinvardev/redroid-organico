import type { JobLogger } from '@/lib/logging/jobLogger';
import { AdbDevice, type AndroidDevice } from './device';

export interface AcquireContext {
  jobId: string;
  accountId: string;
  packageName: string;
  log: JobLogger;
  signal: AbortSignal;
}

export interface AcquiredDevice {
  device: AndroidDevice;
  /** What ADB and Appium's `udid` must both be pointed at. */
  serial: string | undefined;
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
    await assertPackageInstalled(device, context);

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
 * Checked once, up front, because "the app is not installed" and "your selector
 * is wrong" look identical four steps into a flow.
 */
export async function assertPackageInstalled(
  device: AndroidDevice,
  context: AcquireContext,
): Promise<void> {
  if (await device.isPackageInstalled(context.packageName, context.signal)) {
    return;
  }

  throw new PackageNotInstalledError(context.packageName);
}
