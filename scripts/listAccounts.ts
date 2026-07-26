import 'dotenv/config';
import { prisma } from '@/lib/db';
import { open as openSecret } from '@/lib/crypto/secretBox';
import { redactProxyUrl } from '@/lib/proxy/config';

/** Keys whose values are secrets even in a debugging dump. */
const SENSITIVE = /token|password|secret|key/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return `[${value.length} entries]`;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE.test(key) ? '[redacted]' : redact(item),
      ]),
    );
  }

  return value;
}

/**
 * Accounts with their decrypted configuration, because "is apkPath actually in
 * there?" is the question that comes up every time a job fails on
 * configuration, and the encrypted blob cannot answer it.
 */
async function main() {
  const accounts = await prisma.account.findMany({
    orderBy: { createdAt: 'asc' },
    include: { proxy: true },
  });

  if (accounts.length === 0) {
    console.log('No accounts. Create one with `npm run account:add`.');
    return;
  }

  for (const account of accounts) {
    console.log(`\n${account.name}`);
    console.log(`  id            ${account.id}`);
    console.log(`  user          ${account.userId}`);
    console.log(`  platform      ${account.platform}  status ${account.status}  session ${account.sessionState}`);
    console.log(`  created       ${account.createdAt.toISOString()}`);

    // Redacted, not decrypted: "which egress does this account use" is a
    // question worth answering here, and the password is not part of it.
    const egress = account.proxy
      ? `${account.proxy.label} — ${redactProxyUrl({
          type: account.proxy.type,
          host: account.proxy.host,
          port: account.proxy.port,
          username: account.proxy.username,
          // Any non-empty value renders as ***; the stored one is an envelope.
          password: account.proxy.password ? 'sealed' : null,
        })}`
      : 'none — leaves through this host';

    console.log(`  egress        ${egress}`);

    if (!account.credentials) {
      console.log('  credentials   NONE — this account cannot run a job');
      continue;
    }

    try {
      console.log(`  credentials   ${JSON.stringify(redact(openSecret(account.credentials)), null, 2).replace(/\n/g, '\n                ')}`);
    } catch (error) {
      console.log(`  credentials   UNREADABLE (${error instanceof Error ? error.message : error})`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
