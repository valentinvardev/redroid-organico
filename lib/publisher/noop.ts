import { randomUUID } from 'crypto';
import type { Publisher, PublishRequest, PublishResult } from './types';

/**
 * A no-op publisher for development and smoke testing that accepts the request
 * without doing any media or platform interaction. This is like `StubPublisher`
 * but intentionally alleviates the assumption that a post was uploaded.
 */
export class NoOpPublisher implements Publisher {
  readonly name = 'noop';

  async publish(_request: PublishRequest): Promise<PublishResult> {
    return {
      externalPostId: `noop_${randomUUID()}`,
    };
  }
}
