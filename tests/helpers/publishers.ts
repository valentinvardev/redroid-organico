import { randomUUID } from 'crypto';
import { needsReauth, transient } from '@/lib/publisher/errors';
import type { Publisher, PublishRequest, PublishResult } from '@/lib/publisher/types';

/** Records every call so a test can assert how many attempts actually happened. */
export class RecordingPublisher implements Publisher {
  readonly name = 'recording';
  readonly calls: string[] = [];

  async publish(request: PublishRequest): Promise<PublishResult> {
    this.calls.push(request.jobId);
    return { externalPostId: `rec_${randomUUID()}` };
  }
}

/** Always fails with a retryable error, so the full retry budget is consumed. */
export class AlwaysTransientPublisher implements Publisher {
  readonly name = 'always-transient';
  attempts = 0;

  async publish(request: PublishRequest): Promise<PublishResult> {
    this.attempts += 1;
    throw transient('upstream_unavailable', `synthetic transient failure #${this.attempts}`);
  }
}

/** Fails with a non-retryable error, so the worker must not retry at all. */
export class PermanentFailurePublisher implements Publisher {
  readonly name = 'permanent-failure';
  attempts = 0;

  async publish(): Promise<PublishResult> {
    this.attempts += 1;
    throw needsReauth('synthetic permanent failure');
  }
}

/** Fails the first `failures` attempts, then succeeds. */
export class FlakyPublisher implements Publisher {
  readonly name = 'flaky';
  attempts = 0;

  constructor(private readonly failures: number) {}

  async publish(): Promise<PublishResult> {
    this.attempts += 1;

    if (this.attempts <= this.failures) {
      throw transient('flaky', `synthetic failure #${this.attempts}`);
    }

    return { externalPostId: `flaky_${randomUUID()}` };
  }
}

/** Blocks until released, so a test can hold a job in flight. */
export class BlockingPublisher implements Publisher {
  readonly name = 'blocking';
  started = 0;
  private release?: () => void;
  private readonly gate: Promise<void>;

  constructor() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async publish(): Promise<PublishResult> {
    this.started += 1;
    await this.gate;
    return { externalPostId: `blocked_${randomUUID()}` };
  }

  unblock(): void {
    this.release?.();
  }
}
