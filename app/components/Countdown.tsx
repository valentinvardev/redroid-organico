'use client';

import { useEffect, useState } from 'react';

/** Below this the bar turns red and the copy gets blunt. */
const URGENT_MS = 3 * 60_000;

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Time left before the worker gives up and destroys the phone. The partner
 * needs to see this: the deadline exists whether or not anyone tells them, and
 * discovering it by having the screen vanish mid-login is the worst version.
 */
export function Countdown({ expiresAt, startedAt }: { expiresAt: string; startedAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const deadline = Date.parse(expiresAt);

  if (!Number.isFinite(deadline)) {
    return null;
  }

  const remaining = deadline - now;
  const began = startedAt ? Date.parse(startedAt) : NaN;
  const total = Number.isFinite(began) ? deadline - began : 0;
  const fraction = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
  const urgent = remaining <= URGENT_MS;

  return (
    <div className={urgent ? 'countdown countdown-urgent' : 'countdown'}>
      <div className="countdown-track" aria-hidden="true">
        <div className="countdown-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      <p className="countdown-label" role="timer" aria-live={urgent ? 'polite' : 'off'}>
        {remaining <= 0 ? (
          'Time is up — shutting the phone down.'
        ) : (
          <>
            <strong>{format(remaining)}</strong> left to finish logging in
          </>
        )}
      </p>
    </div>
  );
}
