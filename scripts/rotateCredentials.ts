import 'dotenv/config';
import { prisma } from '@/lib/db';
import { openDetailed, seal } from '@/lib/crypto/secretBox';

/**
 * Re-seals every stored credential with the current CREDENTIALS_KEY.
 *
 * Rotation procedure:
 *   1. Generate a new key.
 *   2. Move the current CREDENTIALS_KEY value into CREDENTIALS_KEYS_OLD.
 *   3. Set CREDENTIALS_KEY to the new key.
 *   4. Restart the app and worker — everything still opens via the fallback.
 *   5. Run `npm run keys:rotate` (this script).
 *   6. Remove CREDENTIALS_KEYS_OLD and restart.
 *
 * Safe to re-run: records already sealed with the primary key are skipped.
 * Pass --dry-run to report without writing.
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const accounts = await prisma.account.findMany({
    where: { credentials: { not: null } },
    select: { id: true, name: true, credentials: true },
  });

  if (accounts.length === 0) {
    console.log('No stored credentials to rotate.');
    return;
  }

  let resealed = 0;
  let alreadyCurrent = 0;
  const failed: Array<{ id: string; name: string; error: string }> = [];

  for (const account of accounts) {
    if (!account.credentials) {
      continue;
    }

    let opened;

    try {
      opened = openDetailed(account.credentials);
    } catch (error) {
      // Neither the primary nor any fallback could open it. Do not touch the
      // row — the operator needs to supply the right key, not lose the data.
      failed.push({
        id: account.id,
        name: account.name,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!opened.usedFallback) {
      alreadyCurrent += 1;
      continue;
    }

    if (!dryRun) {
      await prisma.account.update({
        where: { id: account.id },
        data: { credentials: seal(opened.value) },
      });
    }

    resealed += 1;
    console.log(`${dryRun ? '[dry-run] would reseal' : 'resealed'} ${account.name} (${account.id})`);
  }

  console.log(
    `\n${resealed} re-sealed, ${alreadyCurrent} already on the current key, ${failed.length} failed.`,
  );

  if (failed.length > 0) {
    console.error('\nCould not open these with any configured key:');

    for (const entry of failed) {
      console.error(`  ${entry.name} (${entry.id}): ${entry.error}`);
    }

    console.error(
      '\nAdd the missing key to CREDENTIALS_KEYS_OLD and re-run. ' +
        'These accounts will need to re-authenticate if the key is truly lost.',
    );

    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
