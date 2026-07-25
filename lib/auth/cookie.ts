/**
 * Deliberately dependency-free.
 *
 * middleware.ts runs on the Edge runtime and needs this name. Importing it from
 * lib/auth/session would drag Prisma and the pg driver into the Edge bundle —
 * which is both wrong (no TCP sockets there) and what produced a spurious
 * "Can't resolve 'pg-native'" build warning.
 */
export const SESSION_COOKIE = 'redroid_session';
