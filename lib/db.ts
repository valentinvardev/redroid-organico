import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 7 takes its runtime connection from a driver adapter rather than from
 * the `url` in schema.prisma. prisma.config.ts covers the CLI (migrate,
 * introspect); this covers the application.
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

function getClient(): PrismaClient {
  // Next.js dev mode reloads modules on every edit. Without caching the client
  // on globalThis each reload opens a fresh connection pool until Postgres
  // refuses new connections.
  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = createClient();
  }

  return globalForPrisma.__prisma;
}

/**
 * Lazily constructed. `next build` imports every route module to read its
 * config, so instantiating the client at import time made the whole build
 * require DATABASE_URL — which broke building the Docker image, where no
 * database exists or should be needed. The connection is now opened on first
 * actual use.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getClient();
    const value = Reflect.get(client, property, receiver);

    // Model delegates (prisma.job, prisma.user) are objects and pass through
    // untouched; top-level methods ($queryRaw, $transaction) need their
    // receiver rebound to the real client.
    return typeof value === 'function' ? value.bind(client) : value;
  },

  has(_target, property) {
    return property in getClient();
  },
});
