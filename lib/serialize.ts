import type { Account, Job, JobLog, Proxy, Video } from '@prisma/client';

/**
 * Prisma returns BigInt for sizeBytes, which JSON.stringify throws on. Every
 * route funnels through these so a new field cannot reintroduce that crash.
 */
export function serializeVideo(video: Video) {
  return {
    id: video.id,
    fileName: video.fileName,
    mimeType: video.mimeType,
    sizeBytes: Number(video.sizeBytes),
    durationSeconds: video.durationSeconds,
    width: video.width,
    height: video.height,
    status: video.status,
    thumbnailKey: video.thumbnailKey,
    validationErrors: video.validationErrors,
    createdAt: video.createdAt.toISOString(),
  };
}

/**
 * The password is a sealed envelope and stays on the server; the dashboard only
 * ever needs to know whether there is one. `accountCount` is what tells an
 * operator that two accounts are about to share an IP address.
 */
export function serializeProxy(proxy: Proxy & { _count?: { accounts: number } }) {
  return {
    id: proxy.id,
    label: proxy.label,
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    hasPassword: proxy.password !== null,
    timezone: proxy.timezone,
    locale: proxy.locale,
    accountCount: proxy._count?.accounts,
    createdAt: proxy.createdAt.toISOString(),
  };
}

/** Credentials and externalId are intentionally absent. */
export function serializeAccount(account: Account & { proxy?: Proxy | null }) {
  return {
    id: account.id,
    name: account.name,
    platform: account.platform,
    status: account.status,
    maxConcurrent: account.maxConcurrent,
    minIntervalSeconds: account.minIntervalSeconds,
    hasCredentials: account.credentials !== null,
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    sessionState: account.sessionState,
    sessionVerifiedAt: account.sessionVerifiedAt?.toISOString() ?? null,
    proxyId: account.proxyId,
    proxy: account.proxy ? serializeProxy(account.proxy) : null,
    createdAt: account.createdAt.toISOString(),
  };
}

export function serializeJob(
  job: Job & { account?: Account | null; video?: Video | null; logs?: JobLog[] },
) {
  return {
    id: job.id,
    type: job.type,
    runProfile: job.runProfile,
    regionLabel: job.regionLabel,
    metrics: job.metrics ?? null,
    // Needed by the dashboard to reattach a reloaded tab to the linking session
    // that is already running for an account.
    accountId: job.accountId,
    caption: job.caption,
    status: job.status,
    // The dashboard needs this to know where to point the screen iframe while
    // the job is AWAITING_HUMAN. It carries no secrets: a serial and a URL.
    deviceEndpoint: job.deviceEndpoint ?? null,
    awaitingSince: job.awaitingSince?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    humanConfirmedAt: job.humanConfirmedAt?.toISOString() ?? null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    externalPostId: job.externalPostId,
    errorMessage: job.errorMessage,
    scheduledAt: job.scheduledAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    account: job.account ? serializeAccount(job.account) : undefined,
    video: job.video ? serializeVideo(job.video) : undefined,
    logs: job.logs?.map(serializeJobLog),
  };
}

export function serializeJobLog(log: JobLog) {
  return {
    id: log.id,
    level: log.level,
    message: log.message,
    data: log.data,
    createdAt: log.createdAt.toISOString(),
  };
}
