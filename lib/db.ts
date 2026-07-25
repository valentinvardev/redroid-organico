import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 7 takes its runtime connection from a driver adapter rather than from
 * the `url` in schema.prisma. prisma.config.ts covers the CLI (migrate,
 * introspect); this covers the application.
 *
 * Next.js dev mode reloads modules on every edit, so the client is cached on
 * globalThis — without that, each reload opens a fresh pool until Postgres
 * refuses new connections.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __prisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma = globalForPrisma.__prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}
