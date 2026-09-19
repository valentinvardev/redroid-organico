import { getEnv } from '@/lib/env';
import { getRedis } from '@/lib/queue/connection';

/**
 * Hands out one host `/dev/videoN` per job.
 *
 * The device is a real, singular piece of host hardware: two emulators opening
 * the same loopback get one frame each at random, which looks like a flaky
 * camera rather than a booking error. So the pool needs an allocator, and the
 * allocator needs to be correct across worker replicas.
 *
 * Two mechanisms, deliberately, because neither is sufficient alone:
 *
 *  - **Redis** settles the race. `SET NX` is the only step here that is atomic
 *    between two workers reaching for the last free index at the same moment.
 *  - **A Docker label** is the durable record. Redis leases expire and a
 *    SIGKILLed worker never releases; the label on the container is what
 *    `reconcileCameraSlots` reads back to decide which leases were real.
 *
 * The TTL bounds a leak to thirty minutes, and reconciliation at worker startup
 * shortens that to "until the next boot" — the same shape as the per-account
 * slot counter in lib/worker/rateLimiter.ts, for the same reason: the answer
 * must not depend on which process crashed.
 */

/**
 * Derived from the onboarding timeout rather than fixed, so raising that
 * timeout can never leave a live session holding a lease that has already
 * expired — at which point the next job would be handed the same device while
 * a person is still using it. The extra hour covers the publish wait, the
 * slowest permitted boot and verification. It only bounds a leak; startup
 * reconciliation is what actually returns a lost lease.
 */
function leaseTtlSeconds(): number {
  return Math.ceil(getEnv().ONBOARDING_TIMEOUT_MS / 1_000) + 60 * 60;
}

function leaseKey(index: number): string {
  return `camera:slot:${index}`;
}

/**
 * Deletes the lease only if `jobId` still holds it, in one step.
 *
 * A GET followed by a DEL is two round trips with a gap between them: if the
 * lease expires in that gap and another job takes it, the DEL frees the other
 * job's lease, and the next acquire hands the same device to a third. Redis
 * runs a script atomically, so the comparison and the delete cannot be split.
 */
const RELEASE_IF_HELD = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

async function releaseIfHeld(index: number, jobId: string): Promise<boolean> {
  const deleted = await getRedis().eval(RELEASE_IF_HELD, 1, leaseKey(index), jobId);
  return deleted === 1;
}

/** The host device an index names. */
export function hostDevicePath(index: number): string {
  return `/dev/video${index}`;
}

/**
 * What `--device` receives.
 *
 * Always mapped onto `/dev/video0` inside the container, whatever the host
 * index is. That is what keeps the pool from leaking into the emulator's
 * configuration: with exactly one video device in the namespace, it is always
 * the first one, so the AVD can be built once with `-camera-front webcam0` and
 * never has to know which slot it was given.
 */
export function deviceMapping(index: number): string {
  return `${hostDevicePath(index)}:/dev/video0`;
}

export class NoCameraAvailableError extends Error {
  constructor(readonly pool: number[]) {
    super(
      pool.length === 0
        ? 'No camera devices are configured. Set CAMERA_DEVICE_POOL to the v4l2loopback ' +
            'indices created on the host, e.g. "10,11,12,13".'
        : `Every camera device is in use (${pool.map(hostDevicePath).join(', ')}). ` +
            'Either a session is still live on each, or the pool is smaller than the ' +
            'number of onboarding jobs allowed to run at once.',
    );
    this.name = 'NoCameraAvailableError';
  }
}

export interface CameraSlot {
  index: number;
  hostDevice: string;
  /** Ready to drop into `RunContainerSpec.devices`. */
  mapping: string;
  /** Never throws. Safe to call twice. */
  release(): Promise<void>;
}

/** Parsed once per call rather than cached, so a config change needs no restart. */
export function cameraPool(): number[] {
  const raw = getEnv().CAMERA_DEVICE_POOL.trim();

  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((index) => Number.isInteger(index) && index >= 0);
}

/**
 * Takes the first free index, or throws.
 *
 * Deliberately not a queue: a job that cannot get a camera should fail now with
 * a message naming the reason, not wait for one and then hand a person a device
 * after they have given up on the tab.
 */
export async function acquireCameraSlot(jobId: string): Promise<CameraSlot> {
  const redis = getRedis();
  const pool = cameraPool();

  for (const index of pool) {
    const won = await redis.set(leaseKey(index), jobId, 'EX', leaseTtlSeconds(), 'NX');

    if (won !== 'OK') {
      continue;
    }

    let released = false;

    return {
      index,
      hostDevice: hostDevicePath(index),
      mapping: deviceMapping(index),
      release: async () => {
        if (released) {
          return;
        }

        released = true;

        // Only if it is still ours: a lease that expired and was taken by
        // another job must not be freed by this one's teardown.
        await releaseIfHeld(index, jobId).catch(() => undefined);
      },
    };
  }

  throw new NoCameraAvailableError(pool);
}

/**
 * Drops leases that no live container or job can account for.
 *
 * `held` is every camera index currently labelled on a running container, read
 * from Docker by the reaper. A lease outside that set is only genuinely stale
 * once its job is also gone — the gap between `acquireCameraSlot` and
 * `docker run` is a real window in which a lease is legitimately held by no
 * container at all, and clearing it there would hand the same device to two
 * jobs.
 *
 * Returns the indices it freed, for the reaper's log.
 */
export async function reconcileCameraSlots(
  held: Set<number>,
  isJobActive: (jobId: string) => Promise<boolean>,
): Promise<number[]> {
  const redis = getRedis();
  const freed: number[] = [];

  for (const index of cameraPool()) {
    if (held.has(index)) {
      continue;
    }

    const key = leaseKey(index);
    const jobId = await redis.get(key);

    if (!jobId) {
      continue;
    }

    // An error here keeps the lease. Freeing a camera on a failed lookup is
    // the one outcome worse than leaking it.
    const active = await isJobActive(jobId).catch(() => true);

    if (active) {
      continue;
    }

    // Conditional on the holder read above: the lease may have changed hands
    // while the database was being asked, and then it is not ours to free.
    if (await releaseIfHeld(index, jobId)) {
      freed.push(index);
    }
  }

  return freed;
}
