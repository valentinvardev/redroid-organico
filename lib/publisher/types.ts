import type { Platform } from '@prisma/client';
import type { JobLogger } from '@/lib/logging/jobLogger';

export interface PublisherAccount {
  id: string;
  name: string;
  platform: Platform;
  externalId: string | null;
  /**
   * Decrypted only inside the worker, only for the duration of one job.
   * Must never be logged or serialised into a job log.
   */
  credentials: unknown;
}

export interface PublisherVideo {
  id: string;
  /** Absolute path to the media on the worker's local disk. */
  localPath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export interface PublishRequest {
  jobId: string;
  caption: string;
  account: PublisherAccount;
  video: PublisherVideo;
  log: JobLogger;
  /** Aborted when the job exceeds its timeout or the worker is shutting down. */
  signal: AbortSignal;
}

export interface PublishResult {
  externalPostId: string;
  url?: string;
}

export interface Publisher {
  readonly name: string;
  publish(request: PublishRequest): Promise<PublishResult>;
}
