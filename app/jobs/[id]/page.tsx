import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getOptionalUser } from '@/lib/auth/currentUser';
import { serializeJob } from '@/lib/serialize';
import { JobActions } from '@/app/components/JobActions';

export const dynamic = 'force-dynamic';

export default async function JobDetailPage({ params }: { params: { id: string } }) {
  const user = await getOptionalUser();

  const record = await prisma.job.findFirst({
    where: { id: params.id, userId: user?.id ?? undefined },
    include: {
      account: true,
      video: true,
      logs: { orderBy: { createdAt: 'asc' }, take: 500 },
    },
  });

  if (!record) {
    notFound();
  }

  const job = serializeJob(record);
  const retryable = job.status === 'FAILED' || job.status === 'DEAD';
  const cancellable = ['QUEUED', 'SCHEDULED', 'PROCESSING'].includes(job.status);

  return (
    <main className="shell">
      <header className="masthead">
        <Link href="/" className="back">
          ← Dashboard
        </Link>
        <h1>Job {job.id.slice(0, 12)}</h1>
        <span className={`pill pill-${job.status.toLowerCase()}`}>{job.status}</span>
      </header>

      <div className="grid">
        <section className="card">
          <h2>Details</h2>
          <dl className="details">
            <dt>Account</dt>
            <dd>{job.account?.name ?? '—'}</dd>

            <dt>Video</dt>
            <dd>{job.video?.fileName ?? '—'}</dd>

            <dt>Caption</dt>
            <dd className="caption-block">{job.caption}</dd>

            <dt>Attempts</dt>
            <dd>
              {job.attempts} / {job.maxAttempts}
            </dd>

            {job.scheduledAt ? (
              <>
                <dt>Scheduled</dt>
                <dd>{new Date(job.scheduledAt).toLocaleString()}</dd>
              </>
            ) : null}

            <dt>Created</dt>
            <dd>{new Date(job.createdAt).toLocaleString()}</dd>

            {job.startedAt ? (
              <>
                <dt>Started</dt>
                <dd>{new Date(job.startedAt).toLocaleString()}</dd>
              </>
            ) : null}

            {job.completedAt ? (
              <>
                <dt>Finished</dt>
                <dd>{new Date(job.completedAt).toLocaleString()}</dd>
              </>
            ) : null}

            {job.externalPostId ? (
              <>
                <dt>Post id</dt>
                <dd>
                  <code>{job.externalPostId}</code>
                </dd>
              </>
            ) : null}
          </dl>

          {job.errorMessage ? <div className="feedback feedback-error">{job.errorMessage}</div> : null}

          <JobActions jobId={job.id} retryable={retryable} cancellable={cancellable} />
        </section>

        <section className="card">
          <h2>Timeline</h2>
          {job.logs && job.logs.length > 0 ? (
            <ol className="timeline">
              {job.logs.map((log) => (
                <li key={log.id} className={`timeline-item level-${log.level.toLowerCase()}`}>
                  <time>{new Date(log.createdAt).toLocaleTimeString()}</time>
                  <span className="level">{log.level}</span>
                  <span className="message">{log.message}</span>
                  {log.data ? <pre>{JSON.stringify(log.data, null, 2)}</pre> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="hint">No log entries yet.</p>
          )}
        </section>
      </div>
    </main>
  );
}
