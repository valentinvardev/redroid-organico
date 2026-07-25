import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 moved the migration/introspection connection URL out of
 * schema.prisma and into this file. The runtime client does not read it — see
 * the pg driver adapter in lib/db.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
