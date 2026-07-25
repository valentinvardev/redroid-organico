import type { Account, Job, JobLog, Video } from '@prisma/client';

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

/** Credentials and externalId are intentionally absent. */
export function serializeAccount(account: Account) {
  return {
    id: account.id,
    name: account.name,
    platform: account.platform,
    status: account.status,
    maxConcurrent: account.maxConcurrent,
    minIntervalSeconds: account.minIntervalSeconds,
    hasCredentials: account.credentials !== null,
    tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
  };
}

export function serializeJob(
  job: Job & { account?: Account | null; video?: Video | null; logs?: JobLog[] },
) {
  return {
    id: job.id,
    caption: job.caption,
    status: job.status,
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
