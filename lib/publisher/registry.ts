import { getEnv } from '@/lib/env';
import { StubPublisher } from './stub';
import type { Publisher } from './types';

/**
 * Everything upstream of this file — the API, the queue, the worker, the media
 * pipeline, the dashboard — is agnostic to how a post actually reaches a
 * platform. Adding a real adapter means implementing `Publisher`, registering
 * it here, and widening PUBLISHER_DRIVER in lib/env.ts.
 *
 * The intended production adapter is TikTok's official Content Posting API,
 * driven by per-account OAuth tokens held in Account.credentials.
 */
const publishers: Record<string, () => Publisher> = {
  stub: () => new StubPublisher(),
};

let cached: Publisher | undefined;

export function getPublisher(): Publisher {
  if (cached) {
    return cached;
  }

  const driver = getEnv().PUBLISHER_DRIVER;
  const factory = publishers[driver];

  if (!factory) {
    throw new Error(
      `Unknown PUBLISHER_DRIVER "${driver}". Registered drivers: ${Object.keys(publishers).join(', ')}`,
    );
  }

  cached = factory();
  return cached;
}

export type { Publisher, PublishRequest, PublishResult } from './types';
