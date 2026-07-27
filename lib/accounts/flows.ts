import { z } from 'zod';
import type { Account } from '@prisma/client';
import { prisma } from '@/lib/db';
import { open as openSecret, seal } from '@/lib/crypto/secretBox';
import { androidCredentialsSchema } from '@/lib/publisher/android';
import { accountFlowsSchema, type AccountFlows } from './flowsSchema';

/**
 * Reading and writing just the automations of an account.
 *
 * Deliberately not "edit the credentials": that blob also carries an Appium
 * URL, filesystem paths and, for an OAuth driver, live tokens. The API has
 * never returned it and this does not change that — what travels is the part
 * that is not a secret and is the only part anybody edits day to day, which is
 * the selectors.
 *
 * The narrower surface pays for itself twice: a token cannot leak through a
 * screen that never had it, and a save cannot wipe `apkPath` because the field
 * was not on the form.
 */

export class FlowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowValidationError';
  }
}

export { accountFlowsSchema, type AccountFlows } from './flowsSchema';

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** Opens the credentials, insisting they are the shape flows belong to. */
function androidCredentials(account: Account): z.infer<typeof androidCredentialsSchema> {
  if (!account.credentials) {
    throw new FlowValidationError(
      `${account.name} has no credentials yet, so there is nothing to attach flows to.`,
    );
  }

  const parsed = androidCredentialsSchema.safeParse(openSecret(account.credentials));

  if (!parsed.success) {
    throw new FlowValidationError(
      `${account.name} is not an Android account, or its configuration is invalid — ${issues(parsed.error)}`,
    );
  }

  return parsed.data;
}

async function ownedAccount(userId: string, accountId: string): Promise<Account> {
  const account = await prisma.account.findFirst({ where: { id: accountId, userId } });

  if (!account) {
    throw new FlowValidationError(`Account ${accountId} not found`);
  }

  return account;
}

export async function readFlows(userId: string, accountId: string): Promise<AccountFlows> {
  const credentials = androidCredentials(await ownedAccount(userId, accountId));

  return {
    flow: credentials.flow,
    flows: credentials.flows,
    verifyFlow: credentials.verifyFlow,
  };
}

/**
 * Replaces the automations and leaves everything else exactly as it was.
 *
 * Validated twice on purpose: once as flows, so the message names the step that
 * is wrong, and once as the whole merged configuration, because that is what
 * the worker will parse and a save that the worker would reject is a trap set
 * for three in the morning.
 */
export async function writeFlows(userId: string, accountId: string, raw: unknown): Promise<AccountFlows> {
  const account = await ownedAccount(userId, accountId);
  const current = androidCredentials(account);

  const parsed = accountFlowsSchema.safeParse(raw);

  if (!parsed.success) {
    throw new FlowValidationError(issues(parsed.error));
  }

  const merged = {
    ...current,
    flow: parsed.data.flow,
    // Absent means absent: an operator who removes the verify flow from the
    // editor means to remove it, and leaving the old one would make the change
    // look like it did not save.
    flows: parsed.data.flows,
    verifyFlow: parsed.data.verifyFlow,
  };

  const whole = androidCredentialsSchema.safeParse(merged);

  if (!whole.success) {
    throw new FlowValidationError(
      `The account would no longer be valid with these flows — ${issues(whole.error)}`,
    );
  }

  await prisma.account.update({
    where: { id: account.id },
    data: { credentials: seal(whole.data) },
  });

  return {
    flow: whole.data.flow,
    flows: whole.data.flows,
    verifyFlow: whole.data.verifyFlow,
  };
}
