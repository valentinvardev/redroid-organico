import { getEnv } from '@/lib/env';
import { NoOpPublisher } from './noop';
import { StubPublisher } from './stub';
import { TikTokPublisher } from './tiktok';
import { AndroidPublisher } from './android';
import type { OnboardingDriver, Publisher } from './types';

/**
 * Everything upstream of this file — the API, the queue, the worker, the media
 * pipeline, the dashboard — is agnostic to how a post actually reaches a
 * platform. Adding a real adapter means implementing `Publisher`, registering
 * it here, and widening PUBLISHER_DRIVER in lib/env.ts.
 *
 * `android` is the adapter this project is built around: it drives the app
 * under test on a real or containerised Android device over ADB + Appium, using
 * a per-account UI flow. It asserts its way to success — see lib/android/uiFlow.ts.
 */
const publishers: Record<string, () => Publisher> = {
  stub: () => new StubPublisher(),
  noop: () => new NoOpPublisher(),
  tiktok: () => new TikTokPublisher(),
  android: () => new AndroidPublisher(),
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

/** Test seam for code that needs to exercise different adapter selections. */
export function resetPublisherCache(): void {
  cached = undefined;
}

function supportsOnboarding(publisher: Publisher): publisher is Publisher & OnboardingDriver {
  return typeof (publisher as Partial<OnboardingDriver>).onboard === 'function';
}

/**
 * Interactive onboarding needs a driver that can hand a real screen to a
 * person, which only the Android driver can do. Asking the stub to onboard is a
 * configuration mistake, and it fails here rather than by quietly marking an
 * account verified without a device ever existing.
 */
export function getOnboardingDriver(): OnboardingDriver {
  const publisher = getPublisher();

  if (!supportsOnboarding(publisher)) {
    throw new Error(
      `PUBLISHER_DRIVER="${getEnv().PUBLISHER_DRIVER}" cannot run interactive onboarding. ` +
        'Only the "android" driver can put a device in front of an operator.',
    );
  }

  return publisher;
}

export type {
  OnboardingDriver,
  OnboardingRequest,
  OnboardingResult,
  Publisher,
  PublishRequest,
  PublishResult,
} from './types';
