import { z } from 'zod';
import { getEnv } from '@/lib/env';
import type { JobLogger } from '@/lib/logging/jobLogger';
import {
  ACCOUNT_LABEL,
  CAMERA_LABEL,
  CAMERA_ROLE,
  CREATED_AT_LABEL,
  JOB_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  ROLE_LABEL,
  type DockerClient,
} from './docker';

/**
 * Carries the operator's webcam from the media server onto the host V4L2 device
 * the emulator was lent.
 *
 * A container per job rather than one long-running service, for the same reason
 * the egress gateway is one: the thing it owns — a specific `/dev/videoN` — is
 * per job, and tying its lifetime to the job means teardown and the reaper both
 * already know how to collect it.
 *
 * It sits on the ordinary compose network, deliberately **not** inside the
 * account's egress namespace. This is a local feed into a kernel device, not
 * traffic belonging to the account: Android never sees a socket here, only
 * `/dev/video0`. Putting it behind the proxy would push the operator's webcam
 * through a residential exit for no benefit and a great deal of latency.
 */

export const cameraBridgeConfigSchema = z.object({
  /**
   * Pinned: the argument spelling below is the contract, and ffmpeg has broken
   * `-f v4l2` output flags between majors before.
   */
  image: z.string().min(1).default('jrottenberg/ffmpeg:7.1-alpine'),

  /** Where the bridge reads from. `{stream}` is replaced with the job's path. */
  sourceUrlTemplate: z.string().min(1).default('rtsp://mediamtx:8554/{stream}'),

  /**
   * The pixel format written into the loopback device, and the one thing here
   * most likely to be the reason a camera "does not work".
   *
   * The emulator opens a webcam expecting YUYV or MJPEG. v4l2loopback
   * advertises whatever format was last written to it, so feeding it yuv420p
   * produces a device that exists, streams fine to ffplay, and that the
   * emulator silently declines to list.
   */
  pixelFormat: z.string().min(1).default('yuyv422'),

  /** Matched to the AVD's camera resolution; a mismatch is rescaled here. */
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(720),
  frameRate: z.number().int().positive().max(60).default(30),

  /**
   * How long the bridge is watched before the device is started. ffmpeg exits
   * immediately on an unreachable source or a device it cannot open, and
   * catching that here costs two seconds instead of the several minutes an
   * Android boot takes to fail afterwards.
   */
  settleMs: z.number().int().min(0).max(60_000).default(2_000),

  /** Extra ffmpeg arguments, appended before the output device. */
  extraArgs: z.array(z.string()).default([]),
});

export type CameraBridgeConfig = z.infer<typeof cameraBridgeConfigSchema>;

export interface StartCameraBridgeOptions {
  docker: DockerClient;
  jobId: string;
  accountId: string;
  /** The index leased from lib/android/cameraSlots.ts. */
  cameraIndex: number;
  /** Host device mapped onto the container's `/dev/video0`. */
  deviceMapping: string;
  config: CameraBridgeConfig;
  /** The compose network the media server is reachable on. */
  network?: string;
  log: JobLogger;
  signal: AbortSignal;
}

export interface RunningCameraBridge {
  name: string;
  cameraIndex: number;
  /** Never throws; the reaper is the backstop. */
  remove(): Promise<void>;
}

export function bridgeContainerName(jobId: string): string {
  return `redroid-cam-${jobId}`.slice(0, 60);
}

/** The media-server path a job's webcam is published to and read back from. */
export function cameraStreamName(jobId: string): string {
  return `cam-${jobId}`;
}

function ffmpegArgs(config: CameraBridgeConfig, source: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    // The default UDP transport loses whole frames on a congested bridge and
    // shows up as a camera that stutters rather than one that fails.
    '-rtsp_transport',
    'tcp',
    '-i',
    source,
    '-vf',
    `scale=${config.width}:${config.height},fps=${config.frameRate}`,
    '-pix_fmt',
    config.pixelFormat,
    ...config.extraArgs,
    '-f',
    'v4l2',
    // Always video0: the mapping in cameraSlots.ts puts whichever host index
    // this job was lent at that path inside the namespace.
    '/dev/video0',
  ];
}

export async function startCameraBridge(
  options: StartCameraBridgeOptions,
): Promise<RunningCameraBridge> {
  const { docker, jobId, accountId, cameraIndex, deviceMapping, config, log, signal } = options;
  const name = bridgeContainerName(jobId);
  const source = config.sourceUrlTemplate.split('{stream}').join(cameraStreamName(jobId));

  // A bridge left over from a previous attempt at this job would collide on the
  // name, and worse, would still be holding the video device open.
  await docker.remove(name).catch(() => undefined);

  await log.info('Starting the camera bridge', {
    container: name,
    cameraIndex,
    source,
    pixelFormat: config.pixelFormat,
  });

  await docker.run(
    {
      image: config.image,
      name,
      labels: {
        [OWNER_LABEL]: OWNER_VALUE,
        [JOB_LABEL]: jobId,
        [ACCOUNT_LABEL]: accountId,
        [ROLE_LABEL]: CAMERA_ROLE,
        [CAMERA_LABEL]: String(cameraIndex),
        [CREATED_AT_LABEL]: new Date().toISOString(),
      },
      devices: [deviceMapping],
      network: options.network,
      command: ffmpegArgs(config, source),
    },
    { signal },
  );

  const remove = async () => {
    try {
      await docker.remove(name);
      await log.info('Camera bridge removed', { container: name, cameraIndex });
    } catch (cause) {
      await log
        .warn('Could not remove the camera bridge; the reaper will collect it', {
          container: name,
          error: cause instanceof Error ? cause.message : String(cause),
        })
        .catch(() => undefined);
    }
  };

  try {
    await assertStillFeeding(docker, name, config.settleMs, signal);
  } catch (error) {
    const logs = await docker.logs(name, 40).catch(() => '');
    await remove();

    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
        (logs ? `\n--- last lines of ${name} ---\n${logs}` : ''),
      { cause: error },
    );
  }

  return { name, cameraIndex, remove };
}

/**
 * Blocks until the operator's browser is actually publishing its webcam.
 *
 * This is the cheap refusal that has to come before anything expensive. Without
 * it the order of events is: lease a device, start ffmpeg against a path nobody
 * is publishing to, boot an emulator, hand a person a phone whose camera shows
 * nothing — and the failure is then indistinguishable from a broken camera. Ask
 * the media server first and the answer is "this operator never granted their
 * camera", which is both true and actionable.
 *
 * Polls rather than subscribes: MediaMTX has no push for this, and a poll that
 * ends in under two minutes needs no more machinery than a loop.
 */
export async function waitForCameraPublisher(
  jobId: string,
  signal: AbortSignal,
  options: { apiUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const env = getEnv();
  const apiUrl = (options.apiUrl ?? env.CAMERA_CONTROL_API_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? env.CAMERA_PUBLISH_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  if (!apiUrl) {
    throw new Error(
      'This account is configured to lend a camera, but CAMERA_CONTROL_API_URL is not set, ' +
        'so there is no way to tell whether the operator is publishing one.',
    );
  }

  const stream = cameraStreamName(jobId);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal.aborted) {
      throw new Error('Cancelled while waiting for the operator to grant their camera');
    }

    // A failed poll is not a failed grant: the media server may still be
    // starting. Only the deadline ends this loop unhappily.
    const publishing = await doFetch(`${apiUrl}/v3/paths/get/${stream}`, { signal })
      .then(async (response) => {
        if (!response.ok) {
          return false;
        }

        const path = (await response.json()) as { ready?: boolean; source?: unknown };
        return path.ready === true && path.source !== null;
      })
      .catch(() => false);

    if (publishing) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Nothing published a camera to ${stream} within ${Math.round(timeoutMs / 1_000)}s. ` +
          'The operator never granted their camera, or the dashboard could not reach the ' +
          'media server — getUserMedia needs a secure context, so check that it is served over HTTPS.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function assertStillFeeding(
  docker: DockerClient,
  name: string,
  settleMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + settleMs;

  for (;;) {
    if (signal.aborted) {
      throw new Error('Cancelled while starting the camera bridge');
    }

    if (!(await docker.isRunning(name, { signal }))) {
      throw new Error(
        `The camera bridge ${name} exited on startup. ffmpeg does this when nothing is ` +
          'publishing to the media server yet, when the host device does not exist ' +
          '(check CAMERA_DEVICE_POOL against the v4l2loopback video_nr= on the host), or ' +
          'when the device rejects the pixel format.',
      );
    }

    if (Date.now() >= deadline) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
  }
}
