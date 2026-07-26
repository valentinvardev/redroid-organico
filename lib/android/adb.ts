import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AdbTarget {
  serial?: string;
  host?: string;
  port?: number;
}

export interface AdbCommandOptions {
  signal?: AbortSignal;
  /**
   * Return the non-zero exit instead of throwing. Needed for probes whose
   * "false" answer is an exit code — `pidof` on a dead process, `ls` on a
   * missing file — where a throw would be indistinguishable from adb itself
   * being broken.
   */
  allowFailure?: boolean;
  /** Overrides the default budget; a large `push` legitimately takes minutes. */
  timeoutMs?: number;
}

/**
 * Generous, but bounded. Without a limit a wedged transfer holds the job until
 * the 15-minute job timeout with no indication of what it is waiting on.
 */
const DEFAULT_ADB_TIMEOUT_MS = 10 * 60_000;

/**
 * `adb push` reports progress on a carriage-returned line, so a long transfer
 * emits thousands of updates. Well above what that needs, because exceeding it
 * kills the process with an error about buffers that says nothing about the
 * transfer.
 */
const ADB_MAX_BUFFER = 64 * 1024 * 1024;

export interface AdbResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** adb speaks a device-unreachable failure through stderr, not the exit code. */
const UNREACHABLE_PATTERNS = [
  'device not found',
  'device offline',
  'no devices/emulators found',
  'device unauthorized',
  'connection refused',
  'protocol fault',
  'cannot connect to daemon',
];

export class AdbError extends Error {
  readonly code: number;
  readonly stderr: string;
  /** True when the failure is the device being absent rather than the command being wrong. */
  readonly unreachable: boolean;

  constructor(message: string, options: { code: number; stderr: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'AdbError';
    this.code = options.code;
    this.stderr = options.stderr;

    const haystack = `${message} ${options.stderr}`.toLowerCase();
    this.unreachable = UNREACHABLE_PATTERNS.some((pattern) => haystack.includes(pattern));
  }
}

function buildAdbArgs(target: AdbTarget | undefined): string[] {
  const args: string[] = [];

  if (target?.host) {
    args.push('-H', target.host);
  }

  if (target?.port !== undefined) {
    args.push('-P', String(target.port));
  }

  if (target?.serial) {
    args.push('-s', target.serial);
  }

  return args;
}

async function execAdb(
  adbCommand: string,
  target: AdbTarget | undefined,
  args: string[],
  options: AdbCommandOptions = {},
): Promise<AdbResult> {
  const commandArgs = [...buildAdbArgs(target), ...args];

  try {
    const { stdout, stderr } = await execFileAsync(adbCommand, commandArgs, {
      signal: options.signal,
      timeout: options.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS,
      maxBuffer: ADB_MAX_BUFFER,
    });

    return { stdout: String(stdout).trim(), stderr: String(stderr).trim(), code: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    const stderr = String(failure.stderr ?? '').trim();
    const stdout = String(failure.stdout ?? '').trim();
    const exitCode = typeof failure.code === 'number' ? failure.code : 1;

    if (options.signal?.aborted) {
      throw new Error(`ADB command aborted: ${adbCommand} ${commandArgs.join(' ')}`);
    }

    if (options.allowFailure) {
      return { stdout, stderr, code: exitCode };
    }

    // adb explains itself on stderr — "No space left on device", "Permission
    // denied", "closed" — and this used to report only Node's generic "Command
    // failed", throwing away the one line that says what happened. stdout is
    // included too because `adb push` reports its failures there.
    const detail = [
      failure.killed ? `killed after ${options.timeoutMs ?? DEFAULT_ADB_TIMEOUT_MS}ms` : '',
      stderr,
      stdout.split('\n').slice(-3).join('\n'),
    ]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' | ');

    throw new AdbError(
      `ADB command failed (${adbCommand} ${commandArgs.join(' ')}) exit ${exitCode}: ${
        detail || failure.message || String(error)
      }`,
      { code: exitCode, stderr: `${stderr}\n${stdout}`.trim(), cause: error },
    );
  }
}

export async function adbListDevices(adbCommand: string, target: AdbTarget | undefined, signal?: AbortSignal) {
  const { stdout } = await execAdb(adbCommand, target, ['devices', '-l'], { signal });

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('List of devices attached'))
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 2 || parts[1] !== 'device') {
        return '';
      }
      return parts[0];
    })
    .filter((serial): serial is string => serial.length > 0);
}

/**
 * `adb connect host:port` — how a ReDroid container is attached over TCP.
 *
 * `target` addresses the adb *server*, not a device: pointing it at the server
 * Appium uses is what makes the device visible to Appium as well, since both
 * sides then share one device list.
 */
export async function adbConnect(
  adbCommand: string,
  target: AdbTarget | undefined,
  address: string,
  signal?: AbortSignal,
): Promise<void> {
  const { stdout } = await execAdb(adbCommand, target, ['connect', address], { signal });

  // adb connect exits 0 even when it fails; the verdict is in stdout.
  if (/unable to connect|failed to connect|cannot connect/i.test(stdout)) {
    throw new AdbError(`adb connect ${address} failed: ${stdout}`, { code: 1, stderr: stdout });
  }
}

/**
 * Drops the TCP device from the shared adb server. Without this the server
 * accumulates `offline` entries for every container that has been torn down,
 * and Appium starts picking the wrong one.
 */
export async function adbDisconnect(
  adbCommand: string,
  target: AdbTarget | undefined,
  address: string,
  signal?: AbortSignal,
): Promise<void> {
  await execAdb(adbCommand, target, ['disconnect', address], { signal, allowFailure: true });
}

export async function adbPushFile(
  adbCommand: string,
  target: AdbTarget,
  localPath: string,
  remotePath: string,
  signal?: AbortSignal,
) {
  // `adb push` exits 0 while printing "adb: error: failed to copy ...", so the
  // output decides. Out-of-space and permission failures both arrive this way.
  const { stdout, stderr, code } = await execAdb(adbCommand, target, ['push', localPath, remotePath], {
    signal,
    allowFailure: true,
  });

  const output = `${stdout}\n${stderr}`.trim();

  if (code !== 0 || /error:|failed to copy|No space left|Permission denied|Read-only/i.test(output)) {
    throw new AdbError(`adb push ${localPath} -> ${remotePath} failed (exit ${code}): ${output}`, {
      code,
      stderr: output,
    });
  }
}

export async function adbShell(
  adbCommand: string,
  target: AdbTarget,
  shellArgs: string[],
  signal?: AbortSignal,
) {
  const { stdout } = await execAdb(adbCommand, target, ['shell', ...shellArgs], { signal });
  return stdout;
}

export async function adbShellProbe(
  adbCommand: string,
  target: AdbTarget,
  shellArgs: string[],
  signal?: AbortSignal,
): Promise<AdbResult> {
  return execAdb(adbCommand, target, ['shell', ...shellArgs], { signal, allowFailure: true });
}

export async function adbMkdir(
  adbCommand: string,
  target: AdbTarget,
  remoteDirectory: string,
  signal?: AbortSignal,
) {
  await adbShell(adbCommand, target, ['mkdir', '-p', remoteDirectory], signal);
}

export async function adbRemoveFile(
  adbCommand: string,
  target: AdbTarget,
  remotePath: string,
  signal?: AbortSignal,
) {
  await adbShell(adbCommand, target, ['rm', '-f', remotePath], signal);
}

export async function adbStartActivity(
  adbCommand: string,
  target: AdbTarget,
  component: string,
  signal?: AbortSignal,
) {
  const stdout = await adbShell(adbCommand, target, ['am', 'start', '-W', '-n', component], signal);

  // `am start` exits 0 while printing an error for a bad component. Without
  // this check a typo in activityName looks like a successful launch and only
  // surfaces later as a confusing "element not found".
  if (/^Error:/m.test(stdout)) {
    throw new AdbError(`am start ${component} failed: ${stdout}`, { code: 1, stderr: stdout });
  }
}

/**
 * Launch by package alone, letting Android resolve the launcher activity.
 * Preferred over a hardcoded `am start -n` because it survives the target app
 * renaming or relocating its entry activity between builds.
 *
 * Asks the package manager first and only falls back to `monkey`. monkey exits
 * non-zero for benign reasons — it prints warnings like "SYS_KEYS has no
 * physical keys" on a headless device and still launches the app — so its exit
 * code is not a verdict. The caller's `isAppRunning` check is; this function
 * only fails when Android says there is nothing to launch.
 */
export async function adbLaunchPackage(
  adbCommand: string,
  target: AdbTarget,
  packageName: string,
  signal?: AbortSignal,
) {
  const resolved = await adbShellProbe(
    adbCommand,
    target,
    ['cmd', 'package', 'resolve-activity', '--brief', packageName],
    signal,
  );

  // `--brief` puts the component on the last non-empty line.
  const component = resolved.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();

  if (resolved.code === 0 && component && /^[\w.]+\/[\w.$]+$/.test(component)) {
    await adbStartActivity(adbCommand, target, component, signal);
    return;
  }

  const monkey = await adbShellProbe(
    adbCommand,
    target,
    ['monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'],
    signal,
  );

  const output = `${monkey.stdout}\n${monkey.stderr}`;

  if (/No activities found|Monkey aborted/i.test(output)) {
    throw new AdbError(
      `${packageName} has no launcher activity, so there is nothing to open. ` +
        'Set activityName in the account credentials to name the entry point explicitly.',
      { code: monkey.code, stderr: output },
    );
  }
}

/** `sys.boot_completed` is 1 only once Android finished booting — ReDroid needs ~20-60s. */
export async function adbIsBootCompleted(
  adbCommand: string,
  target: AdbTarget,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await adbShellProbe(adbCommand, target, ['getprop', 'sys.boot_completed'], signal);
  return result.code === 0 && result.stdout.trim() === '1';
}

/** The boot animation stops after the system is genuinely usable, not before. */
export async function adbIsBootAnimationDone(
  adbCommand: string,
  target: AdbTarget,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await adbShellProbe(adbCommand, target, ['getprop', 'init.svc.bootanim'], signal);
  return result.code === 0 && result.stdout.trim() === 'stopped';
}

/**
 * Installs an APK read from the worker's own filesystem.
 *
 * `adb install` is client-side: it reads the file locally and streams it, so
 * this works through a remote adb server the same as a local one.
 *
 * The exit code lies — adb returns 0 while printing `Failure [INSTALL_FAILED…]`
 * — so the output is what decides.
 */
export async function adbInstallPackage(
  adbCommand: string,
  target: AdbTarget,
  localApkPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const { stdout, stderr } = await execAdb(adbCommand, target, ['install', '-r', '-g', localApkPath], { signal });
  const output = `${stdout}\n${stderr}`;

  if (/Failure|Error:|INSTALL_FAILED/i.test(output)) {
    throw new AdbError(`adb install ${localApkPath} failed: ${output.trim()}`, { code: 1, stderr: output });
  }
}

/** Whether the app under test is actually present on the device. */
export async function adbIsPackageInstalled(
  adbCommand: string,
  target: AdbTarget,
  packageName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await adbShellProbe(adbCommand, target, ['pm', 'path', packageName], signal);
  return result.code === 0 && result.stdout.includes('package:');
}

/** Byte size of a file on the device, or null when it does not exist. */
export async function adbFileSize(
  adbCommand: string,
  target: AdbTarget,
  remotePath: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const result = await adbShellProbe(adbCommand, target, ['stat', '-c', '%s', remotePath], signal);

  if (result.code !== 0) {
    return null;
  }

  const size = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(size) ? size : null;
}

/** Whether the package currently has a live process — the cheapest crash detector. */
export async function adbIsAppRunning(
  adbCommand: string,
  target: AdbTarget,
  packageName: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await adbShellProbe(adbCommand, target, ['pidof', packageName], signal);
  return result.code === 0 && result.stdout.trim().length > 0;
}
