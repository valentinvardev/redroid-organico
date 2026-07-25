import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getRedis } from '@/lib/queue/connection';
import { getPublishQueue } from '@/lib/queue/publishQueue';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (error) {
    checks.database = { ok: false, detail: error instanceof Error ? error.message : 'unknown' };
  }

  try {
    await getRedis().ping();
    checks.redis = { ok: true };
  } catch (error) {
    checks.redis = { ok: false, detail: error instanceof Error ? error.message : 'unknown' };
  }

  let queue: Record<string, number> | undefined;

  try {
    const counts = await getPublishQueue().getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
    );
    queue = counts as unknown as Record<string, number>;
  } catch {
    // Queue depth is diagnostic, not a liveness signal; its absence is fine.
  }

  const healthy = Object.values(checks).every((check) => check.ok);

  return NextResponse.json({ status: healthy ? 'ok' : 'degraded', checks, queue }, {
    status: healthy ? 200 : 503,
  });
}
