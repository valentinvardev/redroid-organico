import 'dotenv/config';
import { prisma } from '@/lib/db';
import { createFlowJob, createOnboardingJob } from '@/lib/jobs/service';

/**
 * Enqueues a batch of jobs for load and latency testing, with every knob an
 * explicit flag: which flow to run, how many, which regions to spread across,
 * and how far apart to space them.
 *
 * It does not set the concurrency of *execution* — that is the worker's
 * WORKER_CONCURRENCY and the accounts' maxConcurrent, which is where it
 * belongs. This only controls how fast jobs enter the queue. A burst
 * (--stagger 0) plus a high worker concurrency is a throughput test; --stagger
 * spreads arrivals to measure steady-state latency.
 *
 *   npx tsx scripts/bulkEnqueue.ts --user <id> --account <id> \
 *     --flow upload --video <id> --count 30 --regions br,de,us --stagger 500
 *
 *   npx tsx scripts/bulkEnqueue.ts --user <id> --account <id> \
 *     --flow login --count 20 --regions br,de --stagger 250
 *
 * --flow names the flow the account runs: "upload" (the default, needs
 * --video), or any media-less flow the account declares in its credentials
 * ("login", "scroll", …). --regions names proxy labels: the run goes out
 * through that proxy for that job — a per-job egress override on one account —
 * and is tagged with the label so the report can group by region. Without
 * --regions the jobs use the account's own egress and are untagged.
 */

const UPLOAD_FLOW = 'upload';
const ONBOARDING_FLOW = 'onboarding';

interface Args {
  userId: string;
  accountId: string;
  flowType: string;
  /** Report grouping label (runProfile); defaults to the flow name. */
  profile: string;
  count: number;
  staggerMs: number;
  regions: string[];
  videoId?: string;
  caption: string;
  dryRun: boolean;
}

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

function parseArgs(argv: string[]): Args {
  const count = Number(arg('--count', argv) ?? '1');
  const staggerMs = Number(arg('--stagger', argv) ?? '0');

  if (!Number.isInteger(count) || count < 1) {
    throw new Error('--count must be a positive integer');
  }
  if (!Number.isFinite(staggerMs) || staggerMs < 0) {
    throw new Error('--stagger must be a non-negative number of milliseconds');
  }

  const userId = arg('--user', argv);
  if (!userId) {
    throw new Error('--user <userId> is required');
  }

  const accountId = arg('--account', argv);
  if (!accountId) {
    throw new Error('--account <accountId> is required');
  }

  // --flow is the flow the account runs; --profile is just the report label,
  // which defaults to the flow so a plain run still groups sensibly.
  const flowType = arg('--flow', argv) ?? arg('--profile', argv) ?? UPLOAD_FLOW;

  return {
    userId,
    accountId,
    flowType,
    profile: arg('--profile', argv) ?? flowType,
    count,
    staggerMs,
    regions: (arg('--regions', argv) ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    videoId: arg('--video', argv),
    caption: arg('--caption', argv) ?? 'load-test {{n}}',
    dryRun: argv.includes('--dry-run'),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves each region label to a proxy owned by the user, so a job can be
 * pointed at that egress regardless of which proxy the account uses by default.
 * With no regions given, every job runs on the account's own egress, untagged.
 */
async function resolveEgressTargets(
  args: Args,
): Promise<Array<{ proxyId: string | null; regionLabel: string | null }>> {
  if (args.regions.length === 0) {
    return [{ proxyId: null, regionLabel: null }];
  }

  const targets: Array<{ proxyId: string | null; regionLabel: string | null }> = [];

  for (const label of args.regions) {
    const proxy = await prisma.proxy.findFirst({
      where: { userId: args.userId, label },
      select: { id: true },
    });

    if (!proxy) {
      throw new Error(`No proxy labelled "${label}". Add it in the dashboard first, then assign the region.`);
    }

    targets.push({ proxyId: proxy.id, regionLabel: label });
  }

  return targets;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  const isUpload = args.flowType === UPLOAD_FLOW;
  const isOnboarding = args.flowType === ONBOARDING_FLOW;

  if (isUpload && !args.videoId) {
    throw new Error('--flow upload needs --video <id>');
  }

  const targets = isOnboarding
    ? [{ proxyId: null, regionLabel: null }]
    : await resolveEgressTargets(args);

  if (isOnboarding && args.regions.length > 0) {
    console.log('note: --regions is ignored for --flow onboarding; it uses the account\'s own egress.\n');
  }

  console.log(
    `Plan: ${args.count} × ${args.flowType}, stagger ${args.staggerMs}ms, ` +
      `across ${targets.map((t) => t.regionLabel ?? '(account egress)').join(', ')}` +
      (args.dryRun ? '  [dry run]' : ''),
  );

  const batchId = `bulk-${Date.now()}`;
  let enqueued = 0;
  const failures: string[] = [];

  for (let n = 0; n < args.count; n += 1) {
    // Round-robin, so a batch spread over 3 regions puts an equal share on each.
    const target = targets[n % targets.length];
    const idempotencyKey = `${batchId}-${n}`;

    if (args.dryRun) {
      console.log(`  would enqueue ${idempotencyKey} → ${target.regionLabel ?? '(account egress)'}`);
    } else {
      try {
        if (isOnboarding) {
          await createOnboardingJob({ userId: args.userId, accountId: args.accountId, idempotencyKey });
        } else {
          await createFlowJob({
            userId: args.userId,
            accountId: args.accountId,
            flowType: args.flowType,
            // Only the upload flow carries media and a caption; a login or
            // scroll run leaves both null.
            videoId: isUpload ? args.videoId : undefined,
            caption: isUpload ? args.caption.replace('{{n}}', String(n)) : undefined,
            idempotencyKey,
            runProfile: args.profile,
            regionLabel: target.regionLabel,
            proxyId: target.proxyId,
            // The whole point of a load test: the same flow, many times.
            allowConcurrentDuplicate: true,
          });
        }

        enqueued += 1;
      } catch (error) {
        failures.push(`${idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (args.staggerMs > 0 && n < args.count - 1) {
      await sleep(args.staggerMs);
    }
  }

  console.log(`\nBatch ${batchId}: ${enqueued} enqueued, ${failures.length} failed`);
  for (const failure of failures.slice(0, 10)) {
    console.log(`  ${failure}`);
  }

  if (!args.dryRun) {
    console.log(`\nWatch results:  npx tsx scripts/runReport.ts ${batchId}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
