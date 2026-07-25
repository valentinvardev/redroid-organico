'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function JobActions({
  jobId,
  retryable,
  cancellable,
}: {
  jobId: string;
  retryable: boolean;
  cancellable: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, method: string) {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(path, { method });
      const data = await response.json();

      if (!response.ok) {
        setError(data.message ?? 'Request failed');
        return;
      }

      router.refresh();
    } catch {
      setError('Request failed');
    } finally {
      setBusy(false);
    }
  }

  if (!retryable && !cancellable) {
    return null;
  }

  return (
    <div className="actions">
      {retryable ? (
        <button type="button" disabled={busy} onClick={() => void call(`/api/jobs/${jobId}/retry`, 'POST')}>
          Retry
        </button>
      ) : null}

      {cancellable ? (
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => void call(`/api/jobs/${jobId}`, 'DELETE')}
        >
          Cancel
        </button>
      ) : null}

      {error ? <span className="feedback feedback-error">{error}</span> : null}
    </div>
  );
}
