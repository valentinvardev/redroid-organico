import {
  adbFileSize,
  adbIsAppRunning,
  adbIsBootAnimationDone,
  adbIsBootCompleted,
  adbInstallPackage,
  adbIsPackageInstalled,
  adbLaunchPackage,
  adbMkdir,
  adbPushFile,
  adbRemoveFile,
  adbShell,
  adbStartActivity,
  type AdbTarget,
} from './adb';

/**
 * The device operations the publisher needs, behind an interface so tests can
 * drive the whole publish flow without an emulator. `AdbDevice` is the only
 * production implementation; a ReDroid container reached over TCP is the same
 * thing with a `host:port` serial.
 */
export interface AndroidDevice {
  /** Resolves once Android has finished booting; rejects on timeout. */
  waitUntilReady(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  /** Pushes the file and returns the size the device reports for it. */
  pushMedia(localPath: string, remotePath: string, signal?: AbortSignal): Promise<number | null>;
  /** Makes the file visible to the gallery / MediaStore. */
  scanMedia(remotePath: string, signal?: AbortSignal): Promise<void>;
  launch(packageName: string, activityName: string | undefined, signal?: AbortSignal): Promise<void>;
  isAppRunning(packageName: string, signal?: AbortSignal): Promise<boolean>;
  isPackageInstalled(packageName: string, signal?: AbortSignal): Promise<boolean>;
  /** Installs an APK from the worker's filesystem onto the device. */
  installPackage(localApkPath: string, signal?: AbortSignal): Promise<void>;
  removeFile(remotePath: string, signal?: AbortSignal): Promise<void>;
}

function remoteDirectory(remotePath: string): string {
  const index = remotePath.lastIndexOf('/');
  return index > 0 ? remotePath.slice(0, index) : '/sdcard';
}

export class AdbDevice implements AndroidDevice {
  constructor(
    private readonly adbCommand: string,
    private readonly target: AdbTarget,
  ) {}

  async waitUntilReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error('Cancelled while waiting for the Android device to boot');
      }

      try {
        // Both gates matter. ReDroid flips sys.boot_completed while the boot
        // animation is still running and the package manager is still settling,
        // so acting on that property alone produces launches that fail for no
        // visible reason.
        if (
          (await adbIsBootCompleted(this.adbCommand, this.target, signal)) &&
          (await adbIsBootAnimationDone(this.adbCommand, this.target, signal))
        ) {
          return;
        }
      } catch (error) {
        // A container that is still starting refuses the connection outright.
        // That is a "not ready yet", not a hard failure, until the deadline.
        lastError = error;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    throw new Error(
      `Android device ${this.target.serial ?? '(default)'} did not report sys.boot_completed=1 within ${timeoutMs}ms` +
        (lastError instanceof Error ? `: ${lastError.message}` : ''),
    );
  }

  async pushMedia(localPath: string, remotePath: string, signal?: AbortSignal): Promise<number | null> {
    await adbMkdir(this.adbCommand, this.target, remoteDirectory(remotePath), signal);

    // Android 11+ serves /sdcard through FUSE, and overwriting a file created
    // by a different owner fails with "remote couldn't create file: Operation
    // not permitted". A run killed before its cleanup leaves exactly that, so
    // every later run on the same session volume would fail on a path that
    // works fine when empty.
    await adbRemoveFile(this.adbCommand, this.target, remotePath, signal).catch(() => undefined);

    await adbPushFile(this.adbCommand, this.target, localPath, remotePath, signal);
    return adbFileSize(this.adbCommand, this.target, remotePath, signal);
  }

  async scanMedia(remotePath: string, signal?: AbortSignal): Promise<void> {
    await adbShell(
      this.adbCommand,
      this.target,
      ['am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remotePath}`],
      signal,
    );
  }

  async launch(packageName: string, activityName: string | undefined, signal?: AbortSignal): Promise<void> {
    if (activityName) {
      await adbStartActivity(this.adbCommand, this.target, `${packageName}/${activityName}`, signal);
      return;
    }

    await adbLaunchPackage(this.adbCommand, this.target, packageName, signal);
  }

  async isAppRunning(packageName: string, signal?: AbortSignal): Promise<boolean> {
    return adbIsAppRunning(this.adbCommand, this.target, packageName, signal);
  }

  async isPackageInstalled(packageName: string, signal?: AbortSignal): Promise<boolean> {
    return adbIsPackageInstalled(this.adbCommand, this.target, packageName, signal);
  }

  async installPackage(localApkPath: string, signal?: AbortSignal): Promise<void> {
    await adbInstallPackage(this.adbCommand, this.target, localApkPath, signal);
  }

  async removeFile(remotePath: string, signal?: AbortSignal): Promise<void> {
    await adbRemoveFile(this.adbCommand, this.target, remotePath, signal);
  }
}
