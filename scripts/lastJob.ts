import 'dotenv/config';
import { prisma } from '@/lib/db';

/**
 * The most recent job with its full timeline, for when reading the dashboard is
 * slower than reading a terminal — or when the dashboard is the thing that is
 * broken.
 *
 *   npx tsx scripts/lastJob.ts            # latest job
 *   npx tsx scripts/lastJob.ts <jobId>    # a specific one
 */
async function main() {
  const jobId = process.argv[2];

  const job = jobId
    ? await prisma.job.findUnique({
        where: { id: jobId },
        include: { account: true, logs: { orderBy: { createdAt: 'asc' } } },
      })
    : await prisma.job.findFirst({
        orderBy: { createdAt: 'desc' },
        include: { account: true, logs: { orderBy: { createdAt: 'asc' } } },
      });

  if (!job) {
    console.log('No jobs yet. Nothing has been queued.');
    return;
  }

  console.log(`job        ${job.id}`);
  console.log(`type       ${job.type}`);
  console.log(`status     ${job.status}`);
  console.log(`account    ${job.account.name} (${job.accountId})`);
  console.log(`attempts   ${job.attempts}/${job.maxAttempts}`);
  console.log(`created    ${job.createdAt.toISOString()}`);
  console.log(`started    ${job.startedAt?.toISOString() ?? '-'}`);
  console.log(`completed  ${job.completedAt?.toISOString() ?? '-'}`);

  if (job.deviceEndpoint) {
    console.log(`device     ${JSON.stringify(job.deviceEndpoint)}`);
  }

  if (job.errorMessage) {
    console.log(`\nerror:\n${job.errorMessage}`);
  }

  console.log(`\n--- ${job.logs.length} log entries ---`);

  for (const entry of job.logs) {
    const time = entry.createdAt.toISOString().slice(11, 23);
    console.log(`${time}  ${entry.level.padEnd(5)}  ${entry.message}`);

    if (entry.data) {
      console.log(`${' '.repeat(21)}${JSON.stringify(entry.data)}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
