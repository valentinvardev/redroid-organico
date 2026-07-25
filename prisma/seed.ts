import 'dotenv/config';
import { randomBytes } from 'crypto';
import { prisma } from '../lib/db';
import { hashPassword } from '../lib/auth/password';

/**
 * Creates the initial user and one account so the dashboard has something
 * selectable on first run.
 *
 * The password comes from SEED_PASSWORD when set; otherwise a random one is
 * generated and printed once. It is never written to a file — a seeded
 * credential that lives in the repo is a credential that reaches production.
 */
async function main() {
  const email = (process.env.SEED_EMAIL ?? 'dev@localhost').toLowerCase();
  const provided = process.env.SEED_PASSWORD;
  const password = provided ?? randomBytes(12).toString('base64url');

  const existing = await prisma.user.findUnique({ where: { email } });

  const user = await prisma.user.upsert({
    where: { email },
    // Never silently rotate the password of an existing user on re-seed.
    update: existing?.passwordHash ? {} : { passwordHash: await hashPassword(password) },
    create: {
      email,
      name: 'Development User',
      passwordHash: await hashPassword(password),
    },
  });

  const account = await prisma.account.findFirst({
    where: { userId: user.id, name: 'Development Account' },
  });

  if (!account) {
    await prisma.account.create({
      data: {
        userId: user.id,
        name: 'Development Account',
        platform: 'SPORT_REELS',
        status: 'ACTIVE',
        // No credentials: the stub publisher does not need them, and a real
        // adapter should refuse to run without going through OAuth first.
        maxConcurrent: 1,
        minIntervalSeconds: 10,
      },
    });
  }

  const accounts = await prisma.account.count({ where: { userId: user.id } });

  console.log(`Seeded ${email} with ${accounts} account(s)`);

  if (existing?.passwordHash) {
    console.log('Password left unchanged (user already existed).');
  } else if (provided) {
    console.log('Password set from SEED_PASSWORD.');
  } else {
    console.log(`\n  Generated password: ${password}\n`);
    console.log('  Save it now — it is not stored anywhere and will not be shown again.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
