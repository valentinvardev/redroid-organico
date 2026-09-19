import { z } from 'zod';

function isThirtyTwoBytes(value: string): boolean {
  try {
    return Buffer.from(value.trim(), 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * Fail fast on boot rather than at the first request that happens to need a
 * variable. Both the Next.js server and the worker import this module.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  /// 32 bytes, base64-encoded. Generate with:
  ///   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ///
  /// Validated here rather than at first use: a wrong-length key used to boot
  /// fine and only fail later, at the moment a credential was sealed.
  CREDENTIALS_KEY: z.string().refine(isThirtyTwoBytes, {
    message: 'must be base64 that decodes to exactly 32 bytes',
  }),

  /// Comma-separated retired keys, base64. Decrypt-only: new data is always
  /// sealed with CREDENTIALS_KEY. Set this during a rotation so credentials
  /// sealed with the previous key stay readable until `npm run keys:rotate`
  /// has re-sealed them, then remove it.
  CREDENTIALS_KEYS_OLD: z
    .string()
    .optional()
    .refine(
      (value) =>
        !value ||
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .every(isThirtyTwoBytes),
      { message: 'every retired key must be base64 that decodes to exactly 32 bytes' },
    ),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.storage'),

  /// Where the worker materialises a video before pushing it to a device.
  ///
  /// Must be on a real filesystem. The obvious choice, os.tmpdir(), is /tmp —
  /// which on most cloud images is a tmpfs, i.e. RAM. Staging a few hundred
  /// megabytes of video there competes with the Android containers for the
  /// same memory, and the loser is whichever process the kernel picks.
  MEDIA_STAGING_DIR: z.string().default('./.staging'),

  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),

  /// Which publisher adapter the worker uses. See lib/publisher/registry.ts.
  PUBLISHER_DRIVER: z.enum(['stub', 'noop', 'tiktok', 'android']).default('stub'),

  /// How often the worker sweeps for Android containers whose job is no longer
  /// running. Only relevant with PUBLISHER_DRIVER=android. 0 disables the
  /// periodic sweep; the one-shot sweep at startup always runs, and it is the
  /// only thing that cleans up after a SIGKILLed worker.
  ANDROID_REAPER_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),

  /// How long an interactive onboarding job holds a live device waiting for a
  /// person. A closed browser tab sends nothing, so this deadline is the only
  /// thing that ends an abandoned session.
  ONBOARDING_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(20 * 60_000),

  /// Where the dashboard points the screen-sharing iframe. `{serial}` is
  /// replaced with the device serial. Empty means no viewer is wired up yet and
  /// the job still runs — the endpoint is reported without a URL.
  DEVICE_VIEWER_URL_TEMPLATE: z.string().default(''),

  /// v4l2loopback indices available to lend to devices, e.g. "10,11,12,13".
  /// These must match the `video_nr=` the module was loaded with on the host —
  /// see deploy/. Empty means no account can use a camera, and a job that asks
  /// for one fails saying so rather than starting a blind device.
  CAMERA_DEVICE_POOL: z.string().default(''),

  /// Where the browser publishes the operator's webcam. `{jobId}` names the
  /// stream and `{host}` is substituted in the browser, the same way the viewer
  /// template is — the worker has no request to read a hostname from. Empty
  /// disables lending a camera.
  CAMERA_INGEST_URL_TEMPLATE: z.string().default(''),

  /// Where the worker asks whether the browser is actually publishing yet.
  /// MediaMTX's control API, reachable from the worker only.
  CAMERA_CONTROL_API_URL: z.string().default(''),

  /// How long the worker waits for the operator to grant their camera before
  /// giving up. Shorter than the onboarding timeout on purpose: this failure
  /// happens before a device exists, so there is nothing to hold open.
  CAMERA_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(120_000),

  /// Retry budget per job and the base delay for exponential backoff.
  /// Defaults give 15s -> 60s -> 240s across 3 attempts. Lowered in .env.test so
  /// the integration suite does not spend minutes waiting on backoff.
  RETRY_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  RETRY_BACKOFF_MS: z.coerce.number().int().min(50).default(15_000),

  /// How long a job waits after being turned away by an account's concurrency
  /// limit. Unlike a retry, this does not consume an attempt.
  RATE_LIMIT_DEFER_MS: z.coerce.number().int().min(50).default(30_000),

  /// Opens /api/auth/register to anyone who can reach it. Off by default:
  /// operators are added with `npm run user:create`.
  ALLOW_REGISTRATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

function load() {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  if (env.STORAGE_DRIVER === 's3') {
    const missing = (['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter(
      (key) => !env[key],
    );

    if (missing.length > 0) {
      throw new Error(`STORAGE_DRIVER=s3 requires: ${missing.join(', ')}`);
    }
  }

  return env;
}

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    cached = load();
  }

  return cached;
}

/**
 * Test seam. The cache exists so validation runs once per process, which means a
 * test that mutates process.env — key rotation, for instance — would otherwise
 * see stale values. Not for use outside tests.
 */
export function resetEnvCache(): void {
  cached = undefined;
}
