'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomId } from './randomId';
import { browserHost, resolveViewerUrl } from './viewerUrl';
import { publishCamera, type CameraPublication } from './whipPublisher';

export interface DeviceEndpoint {
  serial: string;
  adbHost?: string;
  adbPort?: number;
  viewerUrl?: string;
  /** Measured by the egress check, not guessed: where this phone comes out. */
  egressIp?: string;
  egressLocation?: string;
  egressKind?: 'hosting' | 'proxy' | 'mobile' | 'unflagged';
}

/** The fields of a serialized job this flow cares about. */
export interface OnboardingJob {
  id: string;
  type: string;
  accountId: string;
  status: string;
  deviceEndpoint: DeviceEndpoint | null;
  awaitingSince: string | null;
  expiresAt: string | null;
  humanConfirmedAt: string | null;
  errorMessage: string | null;
  externalPostId: string | null;
}

/**
 * Every screen this flow can be on. A discriminated union rather than a bag of
 * booleans, so `awaiting_human` cannot exist without an endpoint to render and
 * the component never has to ask "is it loading AND awaiting AND failed?".
 */
export type OnboardingState =
  | { phase: 'idle' }
  /** POST in flight; no job exists on the server yet. */
  | { phase: 'starting' }
  /** The job exists; the worker is booting a container. Minutes, on ReDroid. */
  | { phase: 'waiting_for_device'; jobId: string }
  | {
      phase: 'awaiting_human';
      jobId: string;
      endpoint: DeviceEndpoint;
      expiresAt: string | null;
      /** When the wait began, so the countdown can show a proportion, not just a number. */
      startedAt: string | null;
    }
  /** The confirm POST is in flight. */
  | { phase: 'confirming'; jobId: string }
  /** Confirmed; the worker is running verifyFlow. It can still say no. */
  | { phase: 'verifying'; jobId: string }
  | { phase: 'verified'; jobId: string; handle: string | null }
  /** `reason` is already translated for a non-technical reader. */
  | { phase: 'failed'; jobId: string; reason: string }
  | { phase: 'cancelled'; jobId: string }
  /** The browser could not talk to the API at all. */
  | { phase: 'error'; message: string };

/**
 * The optimistic overlay. These are the only two moments with no server state
 * to read — a request is in flight and the job row has not caught up. Every
 * other phase is *derived* from the job row, because two state machines that
 * both think they are authoritative will disagree, and the one in the browser
 * will be the wrong one.
 */
type Pending = 'starting' | 'confirming' | null;

function derive(pending: Pending, jobId: string | null, job: OnboardingJob | undefined): OnboardingState {
  if (pending === 'starting') {
    return { phase: 'starting' };
  }

  if (!jobId) {
    return { phase: 'idle' };
  }

  // The job was created but the stream has not delivered it yet.
  if (!job) {
    return { phase: 'waiting_for_device', jobId };
  }

  switch (job.status) {
    case 'QUEUED':
    case 'SCHEDULED':
    case 'PROCESSING':
      return { phase: 'waiting_for_device', jobId };

    case 'AWAITING_HUMAN': {
      if (pending === 'confirming') {
        return { phase: 'confirming', jobId };
      }

      if (!job.deviceEndpoint) {
        return { phase: 'waiting_for_device', jobId };
      }

      return {
        phase: 'awaiting_human',
        jobId,
        endpoint: job.deviceEndpoint,
        expiresAt: job.expiresAt,
        startedAt: job.awaitingSince,
      };
    }

    case 'VERIFYING':
      return { phase: 'verifying', jobId };

    case 'COMPLETED':
      return { phase: 'verified', jobId, handle: job.externalPostId };

    case 'CANCELLED':
      return { phase: 'cancelled', jobId };

    default:
      return { phase: 'failed', jobId, reason: explain(job.errorMessage) };
  }
}

/**
 * The partner running this is not an engineer. Worker error messages name
 * selectors and timeouts, which is right for the job log and useless in a
 * dialog, so the known ones are translated and anything unrecognised is shown
 * as a generic line with the raw text kept underneath for us.
 */
export function explain(errorMessage: string | null): string {
  const raw = errorMessage ?? '';

  if (/did not verify|not_verified/i.test(raw)) {
    return 'The app does not look logged in. It may not have finished, or the login did not go through — try again.';
  }

  if (/Nobody completed the login|timed out/i.test(raw)) {
    return 'The session timed out waiting for the login. The phone was shut down; start again when you are ready.';
  }

  if (/worker restarted/i.test(raw)) {
    return 'The system restarted during the process. Nothing was saved — please start again.';
  }

  if (/not installed/i.test(raw)) {
    return 'The app is missing from the phone image. This one is on us, not on you.';
  }

  if (/verifyFlow|no_verify_flow/i.test(raw)) {
    return 'This account has no verification steps configured yet, so the login cannot be confirmed.';
  }

  if (/device|container|ADB|boot/i.test(raw)) {
    return 'The phone could not be started. Please try again in a minute.';
  }

  return 'Something went wrong linking the account.';
}

/**
 * Whether the screen bridge answers at all.
 *
 * Nothing inside a cross-origin iframe can be styled or inspected, so a
 * ws-scrcpy that is down renders the browser's own error page — a full-height
 * white rectangle in a dark dialog, with no explanation. Probing first lets us
 * show a real message instead of mounting the frame and hoping.
 *
 * `no-cors` makes the response opaque, which is fine: the only question is
 * whether the request reached anything, and a network failure rejects.
 */
export function useViewerReachable(viewerUrl: string | undefined): 'checking' | 'up' | 'down' {
  const [status, setStatus] = useState<'checking' | 'up' | 'down'>('checking');

  useEffect(() => {
    if (!viewerUrl) {
      setStatus('down');
      return;
    }

    let cancelled = false;
    setStatus('checking');

    // The fragment is client-side routing for the viewer; probe the document.
    const probe = viewerUrl.split('#')[0];

    fetch(probe, { mode: 'no-cors', cache: 'no-store' })
      .then(() => !cancelled && setStatus('up'))
      .catch(() => !cancelled && setStatus('down'));

    return () => {
      cancelled = true;
    };
  }, [viewerUrl]);

  return status;
}

/**
 * The operator's webcam, for accounts whose device is lent one.
 *
 * Browser-local by nature — a permission grant and a live MediaStream are not
 * things a job row can hold — so this sits beside the derived phase rather than
 * inside it, the same way the `pending` overlay does. The worker's side of the
 * handshake is visible anyway: it will not leave `waiting_for_device` until the
 * media server reports this stream as published.
 */
export type CameraState =
  | { needed: false }
  | {
      needed: true;
      status: 'waiting' | 'requesting' | 'live' | 'failed';
      /** For the local preview; null until granted. */
      stream: MediaStream | null;
      error: string | null;
    };

export interface UseOnboarding {
  state: OnboardingState;
  /** False while the event stream is disconnected, so the UI can say so. */
  live: boolean;
  camera: CameraState;
  start(): Promise<void>;
  /** Asks for the webcam and starts publishing it. Must follow a user gesture. */
  grantCamera(): Promise<void>;
  confirm(): Promise<void>;
  cancel(): Promise<void>;
  reset(): void;
}

export function useOnboarding(accountId: string): UseOnboarding {
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [jobs, setJobs] = useState<OnboardingJob[]>([]);
  const [live, setLive] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);

  const [cameraIngestUrl, setCameraIngestUrl] = useState<string | null>(null);
  const [cameraStatus, setCameraStatus] = useState<'waiting' | 'requesting' | 'live' | 'failed'>('waiting');
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // A ref, because every path that has to stop the camera — unmount, unload,
  // the job ending — runs somewhere React state is either stale or gone.
  const publicationRef = useRef<CameraPublication | null>(null);

  // Read inside unload handlers, where React state would be stale.
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = jobId;

  useEffect(() => {
    const source = new EventSource('/api/jobs/stream');

    source.addEventListener('open', () => setLive(true));
    source.addEventListener('jobs', (event) => {
      setLive(true);
      setJobs(JSON.parse((event as MessageEvent).data) as OnboardingJob[]);
    });
    // EventSource reconnects on its own; this only drives the indicator.
    source.addEventListener('error', () => setLive(false));

    return () => source.close();
  }, []);

  const job = useMemo(() => jobs.find((candidate) => candidate.id === jobId), [jobs, jobId]);

  /**
   * Reattach to a linking session that is already running for this account.
   *
   * Without this, an operator who reloads the tab mid-login lands on the start
   * screen, presses the button, and gets a 409 from the conflict check — while
   * their phone is still sitting there waiting for them. The job outlives the
   * page, so the page has to be able to find it again.
   */
  useEffect(() => {
    if (jobId || pending) {
      return;
    }

    const live = jobs.find(
      (candidate) =>
        candidate.accountId === accountId &&
        candidate.type === 'INTERACTIVE_ONBOARDING' &&
        ['QUEUED', 'SCHEDULED', 'PROCESSING', 'AWAITING_HUMAN', 'VERIFYING'].includes(candidate.status),
    );

    if (live) {
      setJobId(live.id);
    }
  }, [jobs, jobId, pending, accountId]);

  // Clear the optimistic overlay as soon as the server confirms the transition.
  useEffect(() => {
    if (pending === 'starting' && jobId) {
      setPending(null);
    }

    if (pending === 'confirming' && job && job.status !== 'AWAITING_HUMAN') {
      setPending(null);
    }
  }, [pending, jobId, job]);

  const start = useCallback(async () => {
    setTransportError(null);
    setPending('starting');

    try {
      const response = await fetch(`/api/accounts/${accountId}/onboarding`, {
        method: 'POST',
        headers: { 'Idempotency-Key': randomId() },
      });

      const body = await response.json();

      if (!response.ok) {
        setPending(null);
        setTransportError(body.message ?? `Could not start onboarding (${response.status})`);
        return;
      }

      setJobId(body.job.id as string);

      // Absent for every account that is not lent a camera, which is most of
      // them: the dialog then behaves exactly as it did before this existed.
      setCameraIngestUrl(typeof body.cameraIngestUrl === 'string' ? body.cameraIngestUrl : null);
      setCameraStatus('waiting');
      setCameraError(null);
    } catch (error) {
      setPending(null);
      setTransportError(error instanceof Error ? error.message : 'Network error');
    }
  }, [accountId]);

  const stopCamera = useCallback(async () => {
    const publication = publicationRef.current;
    publicationRef.current = null;
    setCameraStream(null);

    if (publication) {
      await publication.stop();
    }
  }, []);

  const grantCamera = useCallback(async () => {
    if (!cameraIngestUrl || publicationRef.current) {
      return;
    }

    setCameraStatus('requesting');
    setCameraError(null);

    try {
      // Resolved here for the same reason the viewer's is: the server built
      // this URL without knowing which address the operator used to reach it.
      const url = resolveViewerUrl(cameraIngestUrl, browserHost()) ?? cameraIngestUrl;
      const publication = await publishCamera(url);

      publicationRef.current = publication;
      setCameraStream(publication.stream);
      setCameraStatus('live');
    } catch (error) {
      setCameraStatus('failed');
      setCameraError(error instanceof Error ? error.message : 'Could not start the camera');
    }
  }, [cameraIngestUrl]);

  const confirm = useCallback(async () => {
    if (!jobId) {
      return;
    }

    setTransportError(null);
    setPending('confirming');

    try {
      const response = await fetch(`/api/jobs/${jobId}/onboarding/confirm`, { method: 'POST' });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setPending(null);
        setTransportError(body.message ?? `Could not confirm (${response.status})`);
      }

      // Deliberately not optimistic about the outcome: the worker still has to
      // run the verification flow, and it is allowed to disagree. The stream
      // decides whether this ends in `verified` or `failed`.
    } catch (error) {
      setPending(null);
      setTransportError(error instanceof Error ? error.message : 'Network error');
    }
  }, [jobId]);

  const cancel = useCallback(async () => {
    const id = jobIdRef.current;

    if (!id) {
      return;
    }

    try {
      // `keepalive` so the request survives the page being closed. Without it,
      // walking away leaves an Android container running until its deadline —
      // which the backend enforces, but twenty minutes later.
      await fetch(`/api/jobs/${id}`, { method: 'DELETE', keepalive: true });
    } catch {
      // The job's own expiry is the backstop; nothing useful to show here.
    }
  }, []);

  // Closing the tab mid-login is the common case, not the exception.
  useEffect(() => {
    const onUnload = () => {
      const current = jobs.find((candidate) => candidate.id === jobIdRef.current);

      if (current?.status === 'AWAITING_HUMAN' && !current.humanConfirmedAt) {
        void cancel();
      }
    };

    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, [jobs, cancel]);

  const reset = useCallback(() => {
    void stopCamera();
    setJobId(null);
    setPending(null);
    setTransportError(null);
    setCameraIngestUrl(null);
    setCameraStatus('waiting');
    setCameraError(null);
  }, [stopCamera]);

  const state = useMemo<OnboardingState>(() => {
    if (transportError) {
      return { phase: 'error', message: transportError };
    }

    return derive(pending, jobId, job);
  }, [transportError, pending, jobId, job]);

  // The camera is lent for the login and not a moment longer. Once the job has
  // left the phases where a person is using the device — verified, failed,
  // cancelled — the light goes off, whether or not the dialog is still open.
  useEffect(() => {
    const inUse = ['waiting_for_device', 'awaiting_human', 'confirming', 'verifying'];

    if (publicationRef.current && !inUse.includes(state.phase)) {
      void stopCamera();
    }
  }, [state.phase, stopCamera]);

  // And on unmount, which is how closing the dialog mid-session arrives here.
  useEffect(() => () => void stopCamera(), [stopCamera]);

  const camera = useMemo<CameraState>(
    () =>
      cameraIngestUrl
        ? { needed: true, status: cameraStatus, stream: cameraStream, error: cameraError }
        : { needed: false },
    [cameraIngestUrl, cameraStatus, cameraStream, cameraError],
  );

  return { state, live, camera, start, grantCamera, confirm, cancel, reset };
}
