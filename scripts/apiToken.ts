import 'dotenv/config';
import { prisma } from '@/lib/db';
import { createApiToken } from '@/lib/auth/apiToken';

/**
 * Mints, lists and revokes API tokens for server-to-server access.
 *
 *   npm run token:create -- --user <userId> --name "staging site"
 *   npm run token:list   -- --user <userId>
 *   npm run token:revoke -- --id <tokenId>
 */

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

async function create(argv: string[]): Promise<void> {
  const userId = arg('--user', argv);
  const name = arg('--name', argv) ?? 'api token';
  const expiresIn = arg('--expires-days', argv);

  if (!userId) {
    throw new Error('--user <userId> is required');
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  const expiresAt = expiresIn ? new Date(Date.now() + Number(expiresIn) * 86_400_000) : null;
  const issued = await createApiToken(userId, name, expiresAt);

  console.log(`\nToken created for ${user.email} (${name})`);
  console.log(`  id:      ${issued.id}`);
  console.log(`  expires: ${expiresAt ? expiresAt.toISOString() : 'never'}`);
  console.log(`\n  ${issued.token}\n`);
  console.log('Save it now — it is not stored and will not be shown again.');
  console.log('Send it as:  Authorization: Bearer <token>');
}

async function list(argv: string[]): Promise<void> {
  const userId = arg('--user', argv);
  const tokens = await prisma.apiToken.findMany({
    where: userId ? { userId } : undefined,
    orderBy: { createdAt: 'desc' },
  });

  if (tokens.length === 0) {
    console.log('No tokens.');
    return;
  }

  for (const token of tokens) {
    const state = token.expiresAt && token.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'active';
    console.log(
      `${token.id}  ${token.name.padEnd(24)}  ${state.padEnd(8)}  ` +
        `last used ${token.lastUsedAt?.toISOString() ?? 'never'}`,
    );
  }
}

async function revoke(argv: string[]): Promise<void> {
  const id = arg('--id', argv);
  if (!id) {
    throw new Error('--id <tokenId> is required');
  }

  await prisma.apiToken.delete({ where: { id } });
  console.log(`Revoked ${id}. Any request using it now fails.`);
}

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);

  switch (command) {
    case 'create':
      await create(argv);
      break;
    case 'list':
      await list(argv);
      break;
    case 'revoke':
      await revoke(argv);
      break;
    default:
      console.log('Usage: apiToken.ts <create|list|revoke> [flags]');
      process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
