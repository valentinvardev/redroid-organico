import 'dotenv/config';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db';
import { createUserWithPassword, setPassword, normaliseEmail } from '@/lib/auth/users';

/**
 * Creates a user, or resets an existing user's password with --reset.
 *
 *   npm run user:create -- alice@example.com
 *   npm run user:create -- alice@example.com --password 'chosen-password'
 *   npm run user:create -- alice@example.com --name 'Alice' --reset
 *
 * With no --password a strong one is generated and printed once. This is the
 * intended way to add operators: registration over HTTP stays off unless
 * ALLOW_REGISTRATION is explicitly enabled.
 */
function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main() {
  const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
  const email = arg('--email') ?? positional[0];

  if (!email) {
    console.error('Usage: npm run user:create -- <email> [--name "Name"] [--password "..."] [--reset]');
    process.exit(1);
  }

  const reset = process.argv.includes('--reset');
  const provided = arg('--password');
  const password = provided ?? randomBytes(12).toString('base64url');

  const existing = await prisma.user.findUnique({ where: { email: normaliseEmail(email) } });

  if (existing && !reset) {
    console.error(`${normaliseEmail(email)} already exists. Pass --reset to set a new password.`);
    process.exit(1);
  }

  if (existing) {
    await setPassword(existing.id, password);
    console.log(`Password reset for ${existing.email}. All of their sessions were signed out.`);
  } else {
    const user = await createUserWithPassword({ email, password, name: arg('--name') });
    console.log(`Created ${user.email}`);
  }

  if (provided) {
    console.log('Password set from --password.');
  } else {
    console.log(`\n  Generated password: ${password}\n`);
    console.log('  Save it now — it is not stored anywhere and will not be shown again.');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
