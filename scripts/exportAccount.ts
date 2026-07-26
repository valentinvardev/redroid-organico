import 'dotenv/config';
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
 *   npm run account:export -- --account <id> > cuenta.json
 *   # edit it
 *   npm run account:add -- --account <id> --driver android --credentials-file cuenta.json
 *
 * Unlike `account:list`, this redacts nothing: round-tripping is the whole
 * point, and a file with holes in it would overwrite real values with the word
 * "[redacted]". Redirect it somewhere private.
 */
async function main() {
  const index = process.argv.indexOf('--account');
  const accountId = index !== -1 ? process.argv[index + 1] : undefined;

  if (!accountId) {
    throw new Error(
      'Usage: npm run account:export -- --account <accountId> > cuenta.json\n' +
        'Account ids come from `tsx scripts/listAccounts.ts`.',
    );
  }

  const account = await prisma.account.findUnique({ where: { id: accountId } });

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  if (!account.credentials) {
    throw new Error(`Account ${account.name} has no credentials stored`);
  }

  // stdout carries the JSON and nothing else, so the command can be redirected
  // straight into a file. Anything human-readable goes to stderr.
  console.error(`# ${account.name} (${account.id})`);
  console.log(JSON.stringify(openSecret(account.credentials), null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
