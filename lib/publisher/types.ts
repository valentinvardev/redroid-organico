import type { Platform } from '@prisma/client';
import type { JobLogger } from '@/lib/logging/jobLogger';
import type { HumanOutcome } from '@/lib/onboarding/signal';
import type { ProxyRuntimeConfig } from '@/lib/proxy/config';

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
  /**
   * The account's egress, decrypted alongside the credentials and under the
   * same rule: the password must never reach a log. Null means the driver may
   * use the host's own network. A driver that cannot honour a non-null value
   * must fail rather than run without it.
   */
  proxy: ProxyRuntimeConfig | null;
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
  /** Empty for a flow that posts no text (a login or scroll run). */
  caption: string;
  account: PublisherAccount;
  /**
   * Absent for a flow that stages no media. Only the default upload flow needs
   * a video; a login or scroll run carries none, and a driver must not assume
   * one is present.
   */
  video?: PublisherVideo;
  /**
   * Which named flow to run. Null or undefined selects the account's default
   * flow (the historical upload behaviour); any other value looks the flow up
   * by name in the account's credentials.
   */
  flowType?: string | null;
  log: JobLogger;
  /** Aborted when the job exceeds its timeout or the worker is shutting down. */
  signal: AbortSignal;
}

/** Per-step and total durations, plus whatever a driver wants to attach for a run report. */
export interface RunMetrics {
  totalMs: number;
  steps: Array<{ name: string; action: string; ms: number; skipped: boolean }>;
  [key: string]: unknown;
}

export interface PublishResult {
  externalPostId: string;
  url?: string;
  /** Timing breakdown for the load-test reports; absent for drivers that do not measure. */
  metrics?: RunMetrics;
}

export interface Publisher {
  readonly name: string;
  publish(request: PublishRequest): Promise<PublishResult>;
}

/** Everything the dashboard needs to put this device's screen in front of a person. */
export interface DeviceEndpoint {
  serial: string;
  adbHost?: string;
  adbPort?: number;
  /** Built from DEVICE_VIEWER_URL_TEMPLATE; absent when no bridge is configured. */
  viewerUrl?: string;
  /**
   * Where this phone appears from while someone is using it. Shown next to the
   * screen because it is the context that decides whether the app's behaviour
   * makes sense: a login challenge is expected from a new region and odd from
   * the usual one.
   */
  egressIp?: string;
  egressLocation?: string;
}

export interface OnboardingRequest {
  jobId: string;
  account: PublisherAccount;
  log: JobLogger;
  signal: AbortSignal;
  /**
   * Called once the device is up and the app is on screen. Publishing the
   * endpoint is what flips the job to AWAITING_HUMAN and lets the UI connect —
   * so it must happen before the wait, never after.
   */
  onDeviceReady(endpoint: DeviceEndpoint): Promise<void>;
  /** Resolves when a person confirms, the job is cancelled, or the deadline passes. */
  awaitHuman(): Promise<HumanOutcome>;
}

export type OnboardingOutcome =
  | 'verified'
  /** The person confirmed but the verification flow disagreed. */
  | 'unverified'
  /** Nobody confirmed in time — a closed tab, a distracted partner. */
  | 'abandoned'
  | 'cancelled';

export interface OnboardingResult {
  outcome: OnboardingOutcome;
  details?: string;
}

/**
 * Kept separate from `Publisher` because the shapes genuinely differ: publishing
 * runs to completion on its own, onboarding hands the device to a person and
 * waits. A driver may implement one, the other, or both.
 */
export interface OnboardingDriver {
  readonly name: string;
  onboard(request: OnboardingRequest): Promise<OnboardingResult>;
}
