import { JobStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  CAMERA_LABEL,
  CREATED_AT_LABEL,
  DockerCli,
  GATEWAY_ROLE,
  JOB_LABEL,
  OWNER_LABEL,
  OWNER_VALUE,
  ROLE_LABEL,
  type ContainerSummary,
  type DockerClient,
} from './docker';
import { reconcileCameraSlots } from './cameraSlots';

/**
 * A container younger than this is left alone even if its job does not look
 * active yet: `acquire()` starts the container a moment before the job row
 * flips to PROCESSING, and reaping in that window would kill a healthy run.
 */
const DEFAULT_GRACE_MS = 90_000;

export interface ReapOptions {
  docker?: DockerClient;
  graceMs?: number;
  /** Overridable so the sweep can be tested without a database. */
  isJobActive?: (jobId: string) => Promise<boolean>;
  log?: (message: string) => void;
}

export interface ReapResult {
  inspected: number;
  removed: string[];
  failed: Array<{ container: string; error: string }>;
}

/**
 * States in which a container is legitimately alive.
 *
 * AWAITING_HUMAN and VERIFYING are the ones that are easy to get wrong: the
 * worker is idle by design while a person logs in, and treating "not
 * PROCESSING" as "garbage" would tear the device out from under them about
 * ninety seconds in.
 */
const LIVE_STATUSES: JobStatus[] = [
  JobStatus.PROCESSING,
  JobStatus.AWAITING_HUMAN,
  JobStatus.VERIFYING,
];

/**
 * Sweep order, not preference: a device runs inside its gateway's network
 * namespace, and Docker refuses to remove a container while another one is
 * still borrowing it. Reaping a pair in list order would leave every gateway
 * behind, to be retried on each sweep forever.
 */
function devicesBeforeGateways(containers: ContainerSummary[]): ContainerSummary[] {
  const isGateway = (container: ContainerSummary) => container.labels[ROLE_LABEL] === GATEWAY_ROLE;

  return [
    ...containers.filter((container) => !isGateway(container)),
    ...containers.filter(isGateway),
  ];
}

async function jobIsActive(jobId: string): Promise<boolean> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  return job !== null && LIVE_STATUSES.includes(job.status);
}

/**
 * Removes Android containers that no live job can still be using.
 *
 * The database is the source of truth rather than any in-process bookkeeping,
 * which is what makes this correct with several worker replicas: a container
 * whose job is not PROCESSING is garbage no matter which worker created it. It
 * also composes with `recoverOrphans()` — that runs first on boot and moves
 * jobs stranded by a dead worker back to QUEUED, at which point their
 * containers stop looking active here and get collected.
 *
 * Never throws: a broken Docker CLI must not stop the worker from starting.
 */
/**
 * Returns camera leases whose job is gone to the pool.
 *
 * Deliberately not part of the sweep above, for two reasons. Its result shape
 * is a contract the tests assert verbatim, and — more importantly — the two
 * answer different questions: the sweep asks "may this container be removed",
 * while this asks "is this lease accounted for by anything at all". A lease is
 * held for a moment before its container exists, so a lease with no container
 * is only stale once its job is also dead.
 *
 * Run at worker startup, after recoverOrphans() has moved stranded rows out of
 * the live statuses, so the liveness answers are trustworthy. Never throws: a
 * broken Docker CLI must not stop the worker from starting.
 */
export async function reconcileCameraLeases(options: ReapOptions = {}): Promise<number[]> {
  const docker = options.docker ?? new DockerCli();
  const isActive = options.isJobActive ?? jobIsActive;
  const log = options.log ?? ((message: string) => console.log(message));

  let containers: ContainerSummary[];

  try {
    containers = await docker.listByLabel(OWNER_LABEL, OWNER_VALUE);
  } catch (error) {
    log(
      `[reaper] could not list containers, skipping camera reconciliation: ${
        error instanceof Error ? error.message : error
      }`,
    );
    return [];
  }

  const held = new Set<number>();

  for (const container of containers) {
    const index = Number(container.labels[CAMERA_LABEL]);

    if (Number.isInteger(index)) {
      held.add(index);
    }
  }

  try {
    const freed = await reconcileCameraSlots(held, isActive);

    if (freed.length > 0) {
      log(`[reaper] returned ${freed.length} camera device(s) to the pool: ${freed.join(', ')}`);
    }

    return freed;
  } catch (error) {
    log(`[reaper] camera reconciliation failed: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

export async function reapAndroidContainers(options: ReapOptions = {}): Promise<ReapResult> {
  const docker = options.docker ?? new DockerCli();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const isActive = options.isJobActive ?? jobIsActive;
  const log = options.log ?? ((message: string) => console.log(message));

  const result: ReapResult = { inspected: 0, removed: [], failed: [] };

  let containers;

  try {
    containers = await docker.listByLabel(OWNER_LABEL, OWNER_VALUE);
  } catch (error) {
    log(`[reaper] could not list containers, skipping sweep: ${error instanceof Error ? error.message : error}`);
    return result;
  }

  result.inspected = containers.length;

  for (const container of devicesBeforeGateways(containers)) {
    const jobId = container.labels[JOB_LABEL];
    const createdAt = Date.parse(container.labels[CREATED_AT_LABEL] ?? '');
    const age = Number.isFinite(createdAt) ? Date.now() - createdAt : Number.POSITIVE_INFINITY;

    if (age < graceMs) {
      continue;
    }

    if (jobId) {
      let active: boolean;

      try {
        active = await isActive(jobId);
      } catch (error) {
        // Unable to decide — leaving it alone is the safe error, since the next
        // sweep will look again and a stuck container is cheaper than killing a
        // healthy run.
        result.failed.push({
          container: container.name,
          error: `could not check job ${jobId}: ${error instanceof Error ? error.message : error}`,
        });
        continue;
      }

      if (active) {
        continue;
      }
    }

    try {
      await docker.remove(container.id);
      result.removed.push(container.name);
    } catch (error) {
      result.failed.push({
        container: container.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.removed.length > 0) {
    log(`[reaper] removed ${result.removed.length} orphaned Android container(s): ${result.removed.join(', ')}`);
  }

  for (const failure of result.failed) {
    log(`[reaper] could not reap ${failure.container}: ${failure.error}`);
  }

  return result;
}

export interface ReaperHandle {
  stop(): void;
}

/** Runs the sweep on an interval; the returned handle is cleared on shutdown. */
export function startAndroidReaper(intervalMs: number, options: ReapOptions = {}): ReaperHandle {
  const timer = setInterval(() => {
    void reapAndroidContainers(options).catch((error) => {
      console.error('[reaper] sweep failed', error);
    });
  }, intervalMs);

  // Do not hold the process open just to run a cleanup sweep.
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
