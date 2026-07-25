import 'dotenv/config';
import { readFile } from 'fs/promises';
import path from 'path';
import { prisma } from '@/lib/db';
import { seal } from '@/lib/crypto/secretBox';
import { androidCredentialsSchema } from '@/lib/publisher/android';

function arg(flag: string, argv: string[]): string | undefined {
  const index = argv.indexOf(flag);
  return index !== -1 ? argv[index + 1] : undefined;
}

function numericArg(flag: string, argv: string[]): number | undefined {
  const raw = arg(flag, argv);

  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(`${flag} must be a number, got "${raw}"`);
  }

  return value;
}

interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | number | Date;
  openId?: string;
}

function usage(): string {
  return [
    'Usage: npm run account:add -- --user <userId> --name <accountName> --driver <tiktok|android>',
    '   or: npm run account:add -- --account <accountId> --driver android --credentials-file <file>',
    '       (rewrites an existing account instead of creating another one)',
    '',
    '  tiktok:  --access-token <token> [--refresh-token <token>] [--expires-at <iso>] [--open-id <id>]',
    '',
    '  android: --credentials-file <path/to/credentials.json>   (whole config in one file)',
    '           ...or build it from flags:',
    '           --appium-url <url> --package-name <pkg> --flow <path/to/flow.json>',
    '           [--verify-flow <path/to/verify.json>]   (required for interactive onboarding)',
    '           [--activity-name <activity>] [--device-serial <serial>]',
    '           [--adb-command <cmd>] [--adb-host <host>] [--adb-port <port>]',
    '           [--remote-video-path <path>] [--boot-timeout-seconds <n>]',
    '           [--appium-timeout-seconds <n>] [--launch-settle-ms <n>]',
  ].join('\n');
}

async function readFlow(argv: string[], flag: string, required: boolean, example: string): Promise<unknown> {
  const flowPath = arg(flag, argv);

  if (!flowPath) {
    if (!required) {
      return undefined;
    }

    throw new Error(
      `Android driver requires ${flag} <path to a JSON file describing the UI steps>. See ${example}.`,
    );
  }

  const resolved = path.resolve(process.cwd(), flowPath);
  let raw: string;

  try {
    raw = await readFile(resolved, 'utf8');
  } catch (cause) {
    throw new Error(`Could not read the flow file at ${resolved}: ${cause instanceof Error ? cause.message : cause}`);
  }

  try {
    // Editors on Windows — PowerShell's Set-Content among them — happily write
    // a UTF-8 BOM, and JSON.parse rejects it with a message that says nothing
    // about a byte-order mark. Stripping it is cheaper than explaining it.
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (cause) {
    throw new Error(`The flow file at ${resolved} is not valid JSON: ${cause instanceof Error ? cause.message : cause}`);
  }
}

/**
 * Android credentials are validated against the very schema the publisher uses,
 * so a flow that could never pass — no assertion, an unsupported locator
 * strategy — is rejected now rather than at 3am inside a worker.
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  const resolved = path.resolve(process.cwd(), filePath);
  let raw: string;

  try {
    raw = await readFile(resolved, 'utf8');
  } catch (cause) {
    throw new Error(`Could not read ${resolved}: ${cause instanceof Error ? cause.message : cause}`);
  }

  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (cause) {
    throw new Error(`${resolved} is not valid JSON: ${cause instanceof Error ? cause.message : cause}`);
  }
}

async function buildAndroidCredentials(argv: string[]): Promise<Record<string, unknown>> {
  /**
   * The whole credentials object from one file. Anything with a `redroid` block
   * is easier to write and review as JSON than as fifteen flags, and it is the
   * same shape the worker reads — so what you edit is what runs.
   */
  const credentialsFile = arg('--credentials-file', argv);

  if (credentialsFile) {
    const parsed = androidCredentialsSchema.safeParse(await readJsonFile(credentialsFile));

    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');

      throw new Error(`${credentialsFile} is not a valid Android configuration:\n${issues}`);
    }

    return parsed.data;
  }

  const appiumUrl = arg('--appium-url', argv);

  if (!appiumUrl) {
    throw new Error('Android driver requires --appium-url (or --credentials-file with the whole config)');
  }

  if (!arg('--package-name', argv)) {
    throw new Error('Android driver requires --package-name (the package of the app under test)');
  }

  const candidate = {
    appiumUrl,
    packageName: arg('--package-name', argv),
    activityName: arg('--activity-name', argv),
    adbCommand: arg('--adb-command', argv),
    deviceSerial: arg('--device-serial', argv),
    adbHost: arg('--adb-host', argv),
    adbPort: numericArg('--adb-port', argv),
    remoteVideoPath: arg('--remote-video-path', argv),
    bootTimeoutSeconds: numericArg('--boot-timeout-seconds', argv),
    appiumTimeoutSeconds: numericArg('--appium-timeout-seconds', argv),
    launchSettleMs: numericArg('--launch-settle-ms', argv),
    flow: await readFlow(argv, '--flow', true, 'examples/flows/upload-video.json'),
    // Optional here, but INTERACTIVE_ONBOARDING refuses to run without it —
    // see the note in lib/publisher/android.ts.
    verifyFlow: await readFlow(argv, '--verify-flow', false, 'examples/flows/verify-session.json'),
  };

  // Drop unset flags so the schema's own defaults apply instead of overwriting
  // them with undefined.
  const cleaned = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined));

  const parsed = androidCredentialsSchema.safeParse(cleaned);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`The Android configuration is not valid:\n${issues}`);
  }

  return parsed.data;
}

function buildOAuthCredentials(argv: string[]): OAuthCredentials {
  const accessToken = arg('--access-token', argv);

  if (!accessToken) {
    throw new Error('TikTok driver requires --access-token');
  }

  return {
    accessToken,
    refreshToken: arg('--refresh-token', argv),
    expiresAt: arg('--expires-at', argv),
    openId: arg('--open-id', argv),
  };
}

export async function runAddAccount(argv: string[]): Promise<string> {
  const userId = arg('--user', argv);
  const name = arg('--name', argv);
  const driver = arg('--driver', argv) ?? 'tiktok';
  const updateId = arg('--account', argv);

  if (!['tiktok', 'android'].includes(driver)) {
    throw new Error('Unsupported driver. Valid values are tiktok or android.');
  }

  /**
   * Rewriting an existing account rather than making another one. Selectors and
   * package names get corrected several times before a flow is right, and a new
   * account per correction leaves a pile of near-identical rows and a session
   * volume for each.
   */
  if (updateId) {
    const existing = await prisma.account.findUnique({ where: { id: updateId } });

    if (!existing) {
      throw new Error(`Account ${updateId} not found`);
    }

    const updated = await prisma.account.update({
      where: { id: existing.id },
      data: {
        credentials: seal(driver === 'android' ? await buildAndroidCredentials(argv) : buildOAuthCredentials(argv)),
        ...(name ? { name } : {}),
      },
    });

    return `Updated ${driver} account ${updated.id} (${updated.name})`;
  }

  if (!userId || !name) {
    throw new Error(usage());
  }

  const credentials =
    driver === 'android' ? await buildAndroidCredentials(argv) : buildOAuthCredentials(argv);

  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const account = await prisma.account.create({
    data: {
      userId: user.id,
      name,
      platform: driver === 'android' ? 'SPORT_REELS' : 'TIKTOK',
      status: 'ACTIVE',
      credentials: seal(credentials),
      maxConcurrent: 1,
      minIntervalSeconds: 60,
    },
  });

  const summary =
    driver === 'android'
      ? ` driving ${(credentials as { packageName: string }).packageName} with ${
          (credentials as { flow: unknown[] }).flow.length
        } UI steps`
      : '';

  return `Created ${driver} account ${account.id} (${account.name}) for user ${user.email}${summary}`;
}

export default async function main(argv: string[] = process.argv): Promise<void> {
  try {
    const message = await runAddAccount(argv);
    console.log(message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('/scripts/addAccount.ts') || process.argv[1]?.endsWith('\\scripts\\addAccount.ts')) {
  void main();
}
