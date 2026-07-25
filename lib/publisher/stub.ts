import { randomUUID } from 'crypto';
import { stat } from 'fs/promises';
import { permanent, transient } from './errors';
import type { Publisher, PublishRequest, PublishResult } from './types';

/**
 * Exercises the whole pipeline without contacting any platform: it validates
 * the request the same way a real adapter would, reads the media off disk to
 * prove the worker actually staged it, and reports a synthetic post id.
 *
 * This is what makes M0-M7 testable end to end on its own. It is a development
 * driver — `PUBLISHER_DRIVER=stub` is the only value the environment schema
 * accepts today, so nothing can silently run this in production believing it
 * published something.
 */
export class StubPublisher implements Publisher {
  readonly name = 'stub';

  async publish(request: PublishRequest): Promise<PublishResult> {
    const { caption, video, log, signal } = request;

    if (caption.trim().length === 0) {
      throw permanent('empty_caption', 'Caption must not be empty');
    }

    if (caption.length > 2_200) {
      throw permanent('caption_too_long', `Caption is ${caption.length} characters, limit is 2200`);
    }

    let sizeOnDisk: number;

    try {
      sizeOnDisk = (await stat(video.localPath)).size;
    } catch (cause) {
      throw transient('media_unreadable', `Staged media is not readable at ${video.localPath}`, cause);
    }

    if (sizeOnDisk !== video.sizeBytes) {
      throw permanent(
        'media_size_mismatch',
        `Staged media is ${sizeOnDisk} bytes but the record says ${video.sizeBytes}`,
      );
    }

    await log.info('Stub publisher accepted the request', {
      captionLength: caption.length,
      sizeBytes: sizeOnDisk,
      durationSeconds: video.durationSeconds,
    });

    // Simulate the latency of a real upload so timeouts and cancellation are
    // exercised in development rather than discovered in production.
    await delay(1_200, signal);

    return { externalPostId: `stub_${randomUUID()}` };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
