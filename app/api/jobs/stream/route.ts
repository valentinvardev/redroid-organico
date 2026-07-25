import { prisma } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth/currentUser';
import { guarded } from '@/lib/auth/apiGuard';
import { serializeJob } from '@/lib/serialize';

export const dynamic = 'force-dynamic';

const POLL_MS = 1_500;
const HEARTBEAT_MS = 20_000;

/**
 * Server-sent events over a database poll. BullMQ's QueueEvents would give
 * lower latency, but it reports queue transitions rather than the job rows the
 * dashboard renders — and a 1.5s poll on an indexed query is not the
 * bottleneck at this scale. Swap the source, keep the wire format.
 */
export const GET = guarded(async (request: Request) => {
  const userId = await getCurrentUserId();
  const encoder = new TextEncoder();

  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      let previous = '';
      let closed = false;

      const send = (event: string, payload: unknown) => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const tick = async () => {
        if (closed) {
          return;
        }

        try {
          const jobs = await prisma.job.findMany({
            where: { userId },
            include: { account: true, video: true },
            orderBy: { createdAt: 'desc' },
            take: 50,
          });

          const payload = jobs.map((job) => serializeJob(job));
          const snapshot = JSON.stringify(payload);

          // Only push when something actually changed, so an idle dashboard
          // costs one query per tick and zero bytes on the wire.
          if (snapshot !== previous) {
            previous = snapshot;
            send('jobs', payload);
          }
        } catch (error) {
          console.error('[api/jobs/stream] poll failed', error);
        }
      };

      const cleanup = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (timer) clearInterval(timer);
        if (heartbeat) clearInterval(heartbeat);

        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener('abort', cleanup, { once: true });

      await tick();
      timer = setInterval(() => void tick(), POLL_MS);
      // Proxies drop idle connections; a comment frame keeps it warm without
      // being delivered to any client listener.
      heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } catch {
            cleanup();
          }
        }
      }, HEARTBEAT_MS);
    },

    cancel() {
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
