'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface Job {
  id: string;
  /** Null on interactive onboarding jobs, which carry no text. */
  caption: string | null;
  status: string;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  externalPostId: string | null;
  scheduledAt: string | null;
  createdAt: string;
  completedAt: string | null;
  account?: { name: string; platform: string };
  video?: { fileName: string };
}

// AWAITING_HUMAN belongs here: the job is holding a live device, it just is not
// the worker doing the work. Leaving it out filed onboarding runs under history
// while they were still going.
const ACTIVE = new Set(['QUEUED', 'SCHEDULED', 'PROCESSING', 'AWAITING_HUMAN']);

export function JobQueue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource('/api/jobs/stream');

    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('jobs', (event) => {
      setConnected(true);
      setJobs(JSON.parse((event as MessageEvent).data) as Job[]);
    });
    source.addEventListener('error', () => setConnected(false));

    return () => source.close();
  }, []);

  const active = jobs.filter((job) => ACTIVE.has(job.status));
  const history = jobs.filter((job) => !ACTIVE.has(job.status));

  return (
    <section className="card queue">
      <header className="queue-header">
        <h2>Queue</h2>
        <span className={connected ? 'live live-on' : 'live live-off'}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </header>

      {jobs.length === 0 ? (
        <p className="hint">Nothing queued yet.</p>
      ) : (
        <>
          <h3>
            In flight <em>{active.length}</em>
          </h3>
          {active.length === 0 ? (
            <p className="hint">No jobs running.</p>
          ) : (
            <ul className="job-list">
              {active.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          )}

          <h3>
            History <em>{history.length}</em>
          </h3>
          {history.length === 0 ? (
            <p className="hint">No finished jobs.</p>
          ) : (
            <ul className="job-list">
              {history.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function JobRow({ job }: { job: Job }) {
  return (
    <li className="job-row">
      <Link href={`/jobs/${job.id}`} className="job-main">
        <span className={`pill pill-${job.status.toLowerCase()}`}>{job.status}</span>
        <span className="job-caption">{job.caption || '(no caption)'}</span>
        <span className="job-meta">
          {job.account?.name ?? 'unknown account'}
          {job.video?.fileName ? ` · ${job.video.fileName}` : ''}
          {job.attempts > 1 ? ` · attempt ${job.attempts}/${job.maxAttempts}` : ''}
          {job.scheduledAt && job.status === 'SCHEDULED'
            ? ` · for ${new Date(job.scheduledAt).toLocaleString()}`
            : ''}
        </span>
        {job.errorMessage ? <span className="job-error">{job.errorMessage}</span> : null}
      </Link>
    </li>
  );
}
