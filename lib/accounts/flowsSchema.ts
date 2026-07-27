import { z } from 'zod';
import { uiFlowSchema } from '@/lib/android/uiFlow';

/**
 * The automations of an account, apart from the rest of its credentials.
 *
 * Kept in its own module because the dashboard's editor validates with it, and
 * the service next door reaches for Prisma and the encryption key — importing
 * that from a client component would drag the ORM into the browser bundle.
 *
 * `flow` is the default and also answers to "upload"; `flows` holds the named
 * ones a job selects by `flowType`; `verifyFlow` is what confirms a login.
 */
export const accountFlowsSchema = z.object({
  flow: uiFlowSchema,
  flows: z.record(z.string().min(1), uiFlowSchema).optional(),
  verifyFlow: uiFlowSchema.optional(),
});

export type AccountFlows = z.infer<typeof accountFlowsSchema>;
