import 'dotenv/config';
import { writeFileSync } from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { open as openSecret } from '@/lib/crypto/secretBox';

/**
 * Prints an account's stored credentials as the JSON that
 * `account:add --credentials-file` accepts.
 *
 * The missing half of that command: several things could write credentials and
 * nothing could read them back, so editing one field of an existing account
 * meant retyping the whole configuration from memory — flows included.
 *
 *   npm run account:export -- --account <id> --out cuenta.json
 *   # edit it
 *   npm run account:add -- --account <id> --driver android --credentials-file cuenta.json
 *
 * `--out` rather than a shell redirect, because `npm run` prints its own two
 * banner lines to stdout and they land in the file ahead of the JSON — which
 * fails as "Unexpected token '>'" one command later, at the point where nothing
 * suggests the export was to blame. Redirecting still works when the script is
 * invoked directly.
 *
 * Unlike `account:list`, this redacts nothing: round-tripping is the whole
 * point, and a file with holes in it would overwrite real values with the word
 * "[redacted]". Write it somewhere private.
 */
function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  const accountId = arg('--account');
  const out = arg('--out');

  if (!accountId) {
    throw new Error(
      'Usage: npm run account:export -- --account <accountId> --out cuenta.json\n' +
        'Account ids come from `npm run account:list`.',
    );
  }

  const account = await prisma.account.findUnique({ where: { id: accountId } });

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  if (!account.credentials) {
    throw new Error(`Account ${account.name} has no credentials stored`);
  }

  const json = `${JSON.stringify(openSecret(account.credentials), null, 2)}\n`;

  if (out) {
    const resolved = path.resolve(process.cwd(), out);
    writeFileSync(resolved, json, { mode: 0o600 });
    console.error(`Wrote ${account.name} (${account.id}) to ${resolved}`);
    return;
  }

  // stdout carries the JSON and nothing else, so a direct invocation can still
  // be redirected. Anything human-readable goes to stderr.
  console.error(`# ${account.name} (${account.id})`);
  process.stdout.write(json);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
