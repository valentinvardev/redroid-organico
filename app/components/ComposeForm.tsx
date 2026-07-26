'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { randomId } from './randomId';

interface AccountOption {
  id: string;
  name: string;
  platform: string;
  status: string;
  /** False for the seeded development account, which cannot run a job. */
  hasCredentials: boolean;
}

interface UploadedVideo {
  id: string;
  fileName: string;
  status: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number;
}

interface ValidationIssue {
  field: string;
  message: string;
}

type Feedback = { kind: 'ok' | 'error' | 'info'; text: string } | null;

const CAPTION_LIMIT = 2_200;

export function ComposeForm() {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [accountId, setAccountId] = useState('');
  const [caption, setCaption] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [video, setVideo] = useState<UploadedVideo | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  // Regenerated only after a successful submit, so a double-click or a retry of
  // a failed request resolves to the same job instead of a second publication.
  const idempotencyKey = useRef(randomId());

  useEffect(() => {
    fetch('/api/accounts')
      .then((response) => response.json())
      .then((data: AccountOption[]) => {
        setAccounts(data);
        // Default to one that can actually run. The seeded development account
        // sorts first and has no credentials, so the obvious default was the
        // one guaranteed to fail — several minutes later, inside the worker.
        setAccountId((current) => current || data.find((a) => a.hasCredentials)?.id || '');
      })
      .catch(() => setFeedback({ kind: 'error', text: 'Could not load accounts' }));
  }, []);

  async function handleUpload(file: File) {
    setUploading(true);
    setFeedback(null);
    setIssues([]);
    setVideo(null);

    const body = new FormData();
    body.append('file', file);

    try {
      const response = await fetch('/api/videos', { method: 'POST', body });
      const data = await response.json();

      if (!response.ok) {
        setFeedback({ kind: 'error', text: data.message ?? 'Upload failed' });
        return;
      }

      setVideo(data.video);
      setIssues(data.issues ?? []);

      if (data.video.status === 'INVALID') {
        setFeedback({ kind: 'error', text: 'Video did not pass validation' });
      } else if (data.deduplicated) {
        setFeedback({ kind: 'info', text: 'This file was already uploaded — reusing it' });
      } else {
        setFeedback({ kind: 'ok', text: 'Video ready' });
      }
    } catch {
      setFeedback({ kind: 'error', text: 'Upload failed' });
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!video || video.status !== 'READY') {
      setFeedback({ kind: 'error', text: 'Upload a valid video first' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);

    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey.current,
        },
        body: JSON.stringify({
          accountId,
          videoId: video.id,
          caption,
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setFeedback({ kind: 'error', text: data.message ?? 'Could not queue the job' });
        return;
      }

      setFeedback({ kind: 'ok', text: data.message });
      idempotencyKey.current = randomId();
      setCaption('');
      setScheduledAt('');
      setVideo(null);
      setIssues([]);

      if (fileInput.current) {
        fileInput.current.value = '';
      }
    } catch {
      setFeedback({ kind: 'error', text: 'Could not queue the job' });
    } finally {
      setSubmitting(false);
    }
  }

  const ready = video?.status === 'READY' && caption.trim().length > 0 && accountId.length > 0;

  return (
    <form className="card compose" onSubmit={handleSubmit}>
      <h2>New publication</h2>

      <label className="field">
        <span>Video</span>
        <input
          ref={fileInput}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleUpload(file);
          }}
        />
      </label>

      {uploading ? <p className="hint">Uploading and validating…</p> : null}

      {video ? (
        <div className="media-summary">
          <strong>{video.fileName}</strong>
          <span>
            {video.width && video.height ? `${video.width}×${video.height}` : 'unknown size'}
            {video.durationSeconds ? ` · ${video.durationSeconds.toFixed(1)}s` : ''}
            {` · ${(video.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
          </span>
          <span className={`pill pill-${video.status.toLowerCase()}`}>{video.status}</span>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <ul className="issues">
          {issues.map((issue) => (
            <li key={`${issue.field}-${issue.message}`}>
              <code>{issue.field}</code> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <label className="field">
        <span>Account</span>
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {accounts.length === 0 ? <option value="">No accounts configured</option> : null}
          {accounts.map((account) => (
            <option key={account.id} value={account.id} disabled={!account.hasCredentials}>
              {account.name} · {account.platform}
              {account.hasCredentials ? '' : ' — not configured'}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>
          Caption
          <em className={caption.length > CAPTION_LIMIT ? 'over' : undefined}>
            {caption.length}/{CAPTION_LIMIT}
          </em>
        </span>
        <textarea
          value={caption}
          maxLength={CAPTION_LIMIT}
          rows={4}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Write the caption for this post"
        />
      </label>

      <label className="field">
        <span>
          Schedule <em>optional</em>
        </span>
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(event) => setScheduledAt(event.target.value)}
        />
      </label>

      <button type="submit" disabled={!ready || submitting || uploading}>
        {submitting ? 'Queueing…' : scheduledAt ? 'Schedule publication' : 'Publish now'}
      </button>

      {feedback ? <div className={`feedback feedback-${feedback.kind}`}>{feedback.text}</div> : null}
    </form>
  );
}
