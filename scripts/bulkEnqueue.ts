import 'dotenv/config';
import { prisma } from '@/lib/db';
import { createOnboardingJob, createPublishJob } from '@/lib/jobs/service';

/**
 * Enqueues a batch of jobs for load and latency testing, with every knob an
 * explicit flag: how many, which flow profile, which regions to spread across,
 * and how far apart to space them.
 *
 * It does not set the concurrency of *execution* — that is the worker's
 * WORKER_CONCURRENCY and the accounts' maxConcurrent, which is where it
 * belongs. This only controls how fast jobs enter the queue. A burst
 * (--stagger 0) plus a high worker concurrency is a throughput test; --stagger
 * spreads arrivals to measure steady-state latency.
 *
 *   npx tsx scripts/bulkEnqueue.ts --user <id> --video <id> \
 *     --profile upload --count 30 --regions br,de,us --stagger 500
 *
 * `--regions` names accounts by their proxy label: the job runs on an account
 * whose assigned egress carries that label, and is tagged with it so the report
 * can group by region. Region is therefore a property of which account runs the
 * job — see the note at the bottom on making it a per-job override instead.
 */

interface Args {
  userId: string;
  profile: string;
  count: number;
  staggerMs: number;
  regions: string[];
  videoId?: string;
  accountId?: string;
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

  return {
    userId,
    profile: arg('--profile', argv) ?? 'upload',
    count,
    staggerMs,
    regions: (arg('--regions', argv) ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    videoId: arg('--video', argv),
    accountId: arg('--account', argv),
    caption: arg('--caption', argv) ?? 'load-test {{n}}',
    dryRun: argv.includes('--dry-run'),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves each region label to an account whose assigned proxy carries it.
 * With no regions given, every job runs on --account and is untagged.
 */
async function resolveTargets(args: Args): Promise<Array<{ accountId: string; regionLabel: string | null }>> {
  if (args.regions.length === 0) {
    if (!args.accountId) {
      throw new Error('Pass either --account <id> or --regions <labels>');
    }
    return [{ accountId: args.accountId, regionLabel: null }];
  }

  const targets: Array<{ accountId: string; regionLabel: string | null }> = [];

  for (const label of args.regions) {
    const account = await prisma.account.findFirst({
      where: { userId: args.userId, proxy: { label } },
      select: { id: true, name: true },
    });

    if (!account) {
      throw new Error(
        `No account for region "${label}". Assign a proxy labelled "${label}" to an account in the dashboard first.`,
      );
    }

    targets.push({ accountId: account.id, regionLabel: label });
  }

  return targets;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.profile === 'onboarding' && args.regions.length === 0 && !args.accountId) {
    throw new Error('--profile onboarding needs --account or --regions');
  }

  const targets = await resolveTargets(args);

  console.log(
    `Plan: ${args.count} × ${args.profile}, stagger ${args.staggerMs}ms, ` +
      `across ${targets.map((t) => t.regionLabel ?? t.accountId).join(', ')}` +
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
      console.log(`  would enqueue ${idempotencyKey} → ${target.regionLabel ?? target.accountId}`);
    } else {
      try {
        if (args.profile === 'onboarding') {
          await createOnboardingJob({ userId: args.userId, accountId: target.accountId, idempotencyKey });
        } else {
          if (!args.videoId) {
            throw new Error(`--profile ${args.profile} needs --video <id>`);
          }

          await createPublishJob({
            userId: args.userId,
            accountId: target.accountId,
            videoId: args.videoId,
            caption: args.caption.replace('{{n}}', String(n)),
            idempotencyKey,
            runProfile: args.profile,
            regionLabel: target.regionLabel,
            // The whole point of a load test: the same video, many times.
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
