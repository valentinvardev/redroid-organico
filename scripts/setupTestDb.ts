import { execFile } from 'child_process';
import { promisify } from 'util';
import { Client } from 'pg';

const execFileAsync = promisify(execFile);

/**
 * Creates the test database if it does not exist and brings its schema up to
 * date. Idempotent, so it is safe to run before every suite locally and in CI.
 *
 * Run with: npm run test:setup
 */
async function main() {
  const url = process.env.DATABASE_URL ?? readFromEnvFile('DATABASE_URL');

  if (!url) {
    throw new Error('DATABASE_URL is not set and could not be read from .env.test');
  }

  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, '').split('?')[0];

  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to operate on "${database}": the test database name must end in _test`);
  }

  // Connect to the maintenance database to issue CREATE DATABASE.
  const admin = new URL(url);
  admin.pathname = '/postgres';
  admin.search = '';

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();

  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);

    if (existing.rowCount === 0) {
      // Identifiers cannot be parameterised; the _test suffix check above plus
      // this quoting keep it safe.
      await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
      console.log(`Created database ${database}`);
    } else {
      console.log(`Database ${database} already exists`);
    }
  } finally {
    await client.end();
  }

  const { stdout } = await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    timeout: 120_000,
    // Node refuses to spawn .cmd shims directly on Windows (EINVAL), and npx is
    // one; going through the shell is the portable way to invoke it.
    shell: process.platform === 'win32',
  });

  console.log(stdout.trim().split('\n').slice(-3).join('\n'));
}

function readFromEnvFile(key: string): string | undefined {
  try {
    const contents = require('fs').readFileSync('.env.test', 'utf8') as string;
    const match = contents.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n\\r]+)"?`, 'm'));
    return match?.[1];
  } catch {
    return undefined;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
