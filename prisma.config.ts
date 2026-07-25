import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the migration/introspection connection URL out of
 * schema.prisma and into this file. The runtime client does not read it — see
 * the pg driver adapter in lib/db.ts.
 *
 * Read straight from process.env rather than through prisma's `env()` helper,
 * which throws when the variable is absent. `prisma generate` only needs the
 * schema, so requiring a database URL just to produce a client breaks every
 * build that legitimately has no credentials — the Docker image build being the
 * obvious one. Commands that do need a connection (migrate, introspect) still
 * fail with their own clear error when it is missing.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
