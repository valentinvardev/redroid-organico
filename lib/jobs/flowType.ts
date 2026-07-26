/**
 * A job's `flowType` names which flow the driver runs for it. It is deliberately
 * a plain string rather than an enum: the set of flows an account supports lives
 * in that account's credentials, not in the schema, so adding one ("scroll",
 * "login", "search") never needs a migration.
 *
 * "upload" is the one reserved name — the default flow every account already has
 * as its single `flow`, and the only flow that stages a video. A null flowType
 * means exactly that default, so an ordinary publish carries no string at all.
 */
export const DEFAULT_FLOW_TYPE = 'upload';

export function isDefaultFlow(flowType: string | null | undefined): boolean {
  return !flowType || flowType === DEFAULT_FLOW_TYPE;
}

/**
 * Only the default upload flow stages media. A login or scroll run drives the
 * UI without pushing a video, so a job for one carries neither a video nor a
 * caption — and requiring them would force an operator to pick an irrelevant
 * video just to run a login latency test.
 */
export function flowRequiresVideo(flowType: string | null | undefined): boolean {
  return isDefaultFlow(flowType);
}
