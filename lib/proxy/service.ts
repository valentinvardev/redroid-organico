import { Prisma, type Account, type Proxy } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { open as openSecret, seal } from '@/lib/crypto/secretBox';
import {
  proxyInputSchema,
  proxyPatchSchema,
  type ProxyInput,
  type ProxyRuntimeConfig,
} from './config';

export class ProxyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyValidationError';
  }
}

/** The operation is refused because something else still depends on the proxy. */
export class ProxyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConflictError';
  }
}

/** A proxy plus the number of accounts pointing at it. */
export type ProxyWithUsage = Proxy & { _count: { accounts: number } };

const withUsage = { _count: { select: { accounts: true } } } as const;

function fail(error: z.ZodError): never {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');

  throw new ProxyValidationError(issues);
}

export async function listProxies(userId: string): Promise<ProxyWithUsage[]> {
  return prisma.proxy.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    include: withUsage,
  });
}

/**
 * Validation lives here rather than in the route so the CLI, the tests and the
 * dashboard cannot disagree about what a valid proxy is.
 */
export async function createProxy(userId: string, raw: unknown): Promise<ProxyWithUsage> {
  const parsed = proxyInputSchema.safeParse(raw);

  if (!parsed.success) {
    fail(parsed.error);
  }

  const input = parsed.data;

  try {
    return await prisma.proxy.create({
      data: {
        userId,
        label: input.label,
        type: input.type,
        host: input.host,
        port: input.port,
        username: input.username,
        password: input.password ? seal(input.password) : null,
      },
      include: withUsage,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ProxyConflictError(`You already have a proxy named "${input.label}"`);
    }

    throw error;
  }
}

/**
 * Applies a patch to an existing proxy.
 *
 * The merged result is validated, not the patch: "password without username" is
 * only answerable once you know what the other field currently holds.
 */
export async function updateProxy(
  userId: string,
  proxyId: string,
  raw: unknown,
): Promise<ProxyWithUsage> {
  const patch = proxyPatchSchema.safeParse(raw);

  if (!patch.success) {
    fail(patch.error);
  }

  const existing = await prisma.proxy.findFirst({ where: { id: proxyId, userId } });

  if (!existing) {
    throw new ProxyValidationError(`Proxy ${proxyId} not found`);
  }

  const changesPassword = patch.data.password !== undefined;

  const merged = proxyInputSchema.safeParse({
    label: patch.data.label ?? existing.label,
    type: patch.data.type ?? existing.type,
    host: patch.data.host ?? existing.host,
    port: patch.data.port ?? existing.port,
    username: patch.data.username !== undefined ? patch.data.username : existing.username,
    // The stored password is an envelope, not a string, so it cannot take part
    // in the merge. A placeholder stands in for "there is one" purely so the
    // cross-field check sees the truth.
    password: changesPassword ? patch.data.password : existing.password ? 'unchanged' : null,
  });

  if (!merged.success) {
    fail(merged.error);
  }

  const input: ProxyInput = merged.data;

  try {
    return await prisma.proxy.update({
      where: { id: existing.id },
      data: {
        label: input.label,
        type: input.type,
        host: input.host,
        port: input.port,
        username: input.username,
        ...(changesPassword ? { password: input.password ? seal(input.password) : null } : {}),
      },
      include: withUsage,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ProxyConflictError(`You already have a proxy named "${input.label}"`);
    }

    throw error;
  }
}

/**
 * Deleting a proxy an account still uses is refused rather than allowed to
 * quietly null the column: the account would keep running, only now straight
 * out of the host's datacentre address, and nothing about the run would say so.
 */
export async function deleteProxy(userId: string, proxyId: string): Promise<void> {
  const existing = await prisma.proxy.findFirst({
    where: { id: proxyId, userId },
    include: { accounts: { select: { name: true } } },
  });

  if (!existing) {
    throw new ProxyValidationError(`Proxy ${proxyId} not found`);
  }

  if (existing.accounts.length > 0) {
    throw new ProxyConflictError(
      `"${existing.label}" is still used by ${existing.accounts
        .map((account) => account.name)
        .join(', ')}. Point those accounts at another proxy first.`,
    );
  }

  await prisma.proxy.delete({ where: { id: existing.id } });
}

/** Points an account at a proxy, or at none when `proxyId` is null. */
export async function assignProxy(
  userId: string,
  accountId: string,
  proxyId: string | null,
): Promise<Account> {
  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });

  if (!account) {
    throw new ProxyValidationError(`Account ${accountId} not found`);
  }

  if (proxyId !== null) {
    // Scoped to the user: without this, an id from another tenant would attach
    // their egress — and their bandwidth bill — to this account.
    const proxy = await prisma.proxy.findFirst({ where: { id: proxyId, userId } });

    if (!proxy) {
      throw new ProxyValidationError(`Proxy ${proxyId} not found`);
    }
  }

  return prisma.account.update({
    where: { id: account.id },
    data: { proxyId },
  });
}

/**
 * Turns a stored row into what the gateway needs. The only place a proxy
 * password exists in the clear, and only inside the worker, for the duration of
 * one job.
 */
export function openProxy(proxy: Proxy): ProxyRuntimeConfig {
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password ? openSecret<string>(proxy.password) : null,
  };
}
