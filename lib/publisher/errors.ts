/**
 * The worker's retry policy keys off `retryable`. Anything a publisher throws
 * that is not a PublishError is treated as retryable, on the assumption that an
 * unclassified failure is more likely transient than permanent.
 */
export class PublishError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { code: string; retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = 'PublishError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Bad caption, unsupported media, video rejected by the platform. */
export function permanent(code: string, message: string, cause?: unknown): PublishError {
  return new PublishError(message, { code, retryable: false, cause });
}

/** Network blip, 5xx, upload interrupted. */
export function transient(code: string, message: string, cause?: unknown): PublishError {
  return new PublishError(message, { code, retryable: true, cause });
}

/** Provider asked us to slow down; the worker honours retryAfterMs exactly. */
export function rateLimited(message: string, retryAfterMs: number): PublishError {
  return new PublishError(message, { code: 'rate_limited', retryable: true, retryAfterMs });
}

/** Credentials expired or were revoked — retrying will not help until re-auth. */
export function needsReauth(message: string, cause?: unknown): PublishError {
  return new PublishError(message, { code: 'needs_reauth', retryable: false, cause });
}

export function isRetryable(error: unknown): boolean {
  return error instanceof PublishError ? error.retryable : true;
}

export function retryAfterMs(error: unknown): number | undefined {
  return error instanceof PublishError ? error.retryAfterMs : undefined;
}
