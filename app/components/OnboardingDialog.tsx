'use client';

import { useEffect } from 'react';
import { Countdown } from './Countdown';
import { useOnboarding, useViewerReachable, type OnboardingState } from './useOnboarding';

interface Props {
  accountId: string;
  accountName: string;
  /** Called when the operator dismisses the dialog, so the parent can unmount it. */
  onClose(): void;
}

/**
 * The "link account" flow. Every branch renders from a single `state.phase`, so
 * an unhandled combination is a TypeScript error rather than a blank screen.
 */
export function OnboardingDialog({ accountId, accountName, onClose }: Props) {
  const { state, live, start, confirm, cancel, reset } = useOnboarding(accountId);

  const holdingDevice = state.phase === 'awaiting_human' || state.phase === 'waiting_for_device';

  const dismiss = async () => {
    // Cancelling first kills the container now instead of at its deadline.
    if (holdingDevice) {
      await cancel();
    }

    reset();
    onClose();
  };

  // Escape closes, except while the worker is verifying: interrupting there
  // would abandon a session that is seconds from being confirmed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state.phase !== 'verifying' && state.phase !== 'confirming') {
        void dismiss();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const finished =
    state.phase === 'verified' ||
    state.phase === 'failed' ||
    state.phase === 'cancelled' ||
    state.phase === 'error';

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label={`Link ${accountName}`}>
      <div className="onboarding-panel">
        <header className="onboarding-header">
          <div>
            <p className="eyebrow">Link account</p>
            <h2>{accountName}</h2>
          </div>
          <div className="onboarding-header-right">
            <span className={live ? 'live live-on' : 'live live-off'}>
              {live ? 'live' : 'reconnecting…'}
            </span>
            <button type="button" className="ghost" onClick={() => void dismiss()}>
              {finished ? 'Done' : 'Cancel'}
            </button>
          </div>
        </header>

        <Body state={state} onStart={() => void start()} onConfirm={() => void confirm()} />
      </div>
    </div>
  );
}

function Body({
  state,
  onStart,
  onConfirm,
}: {
  state: OnboardingState;
  onStart(): void;
  onConfirm(): void;
}) {
  switch (state.phase) {
    case 'idle':
      return (
        <div className="onboarding-body onboarding-centred">
          <p className="onboarding-lead">
            A phone will start up on this screen. Log in to your account on it exactly as you would on
            your own device, then press the green button.
          </p>
          <p className="hint">Nothing you type here is stored by us — it stays on the phone.</p>
          <button type="button" className="primary big" onClick={onStart}>
            Start
          </button>
        </div>
      );

    case 'starting':
    case 'waiting_for_device':
      return (
        <div className="onboarding-body onboarding-centred">
          <Spinner />
          <p className="onboarding-lead">Starting a phone for you…</p>
          <p className="hint">This usually takes a minute or two. Please keep this tab open.</p>
        </div>
      );

    case 'awaiting_human':
      return (
        <div className="onboarding-body onboarding-live">
          {state.expiresAt ? <Countdown expiresAt={state.expiresAt} startedAt={state.startedAt} /> : null}

          <Screen viewerUrl={state.endpoint.viewerUrl} serial={state.endpoint.serial} />

          <footer className="onboarding-actions">
            <button type="button" className="primary big" onClick={onConfirm}>
              I finished logging in
            </button>
            <p className="hint">Only press this once you can see your own profile in the app.</p>
          </footer>
        </div>
      );

    case 'confirming':
    case 'verifying':
      return (
        <div className="onboarding-body onboarding-centred">
          <Spinner />
          <p className="onboarding-lead">Checking that the login worked…</p>
          <p className="hint">Do not close this tab.</p>
        </div>
      );

    case 'verified':
      return (
        <div className="onboarding-body onboarding-centred">
          <div className="onboarding-badge onboarding-badge-ok" aria-hidden="true">
            ✓
          </div>
          <p className="onboarding-lead">
            Account linked{state.handle ? ' as ' : '.'}
            {state.handle ? <strong>{state.handle}</strong> : null}
          </p>
          <p className="hint">The phone has been shut down. Your session was saved.</p>
        </div>
      );

    case 'failed':
      return (
        <div className="onboarding-body onboarding-centred">
          <div className="onboarding-badge onboarding-badge-bad" aria-hidden="true">
            !
          </div>
          <p className="onboarding-lead">Could not link the account.</p>
          <p className="hint">{state.reason}</p>
        </div>
      );

    case 'cancelled':
      return (
        <div className="onboarding-body onboarding-centred">
          <p className="onboarding-lead">Cancelled.</p>
          <p className="hint">The phone has been shut down and nothing was saved.</p>
        </div>
      );

    case 'error':
      return (
        <div className="onboarding-body onboarding-centred">
          <div className="onboarding-badge onboarding-badge-bad" aria-hidden="true">
            !
          </div>
          <p className="onboarding-lead">{state.message}</p>
        </div>
      );
  }
}

function Spinner() {
  return <div className="onboarding-spinner" aria-hidden="true" />;
}

/** The device screen, or an explanation of why there isn't one. */
function Screen({ viewerUrl, serial }: { viewerUrl?: string; serial: string }) {
  const reachable = useViewerReachable(viewerUrl);

  if (!viewerUrl) {
    return (
      <div className="onboarding-placeholder">
        <p className="onboarding-lead">No screen viewer is configured.</p>
        <p className="hint">
          The phone is running as <code>{serial}</code>. Set{' '}
          <code>DEVICE_VIEWER_URL_TEMPLATE</code> to embed its screen here.
        </p>
      </div>
    );
  }

  if (reachable === 'checking') {
    return (
      <div className="onboarding-placeholder">
        <Spinner />
        <p className="hint">Connecting to the phone screen…</p>
      </div>
    );
  }

  if (reachable === 'down') {
    return (
      <div className="onboarding-placeholder">
        <p className="error">The phone screen is not reachable.</p>
        <p className="hint">
          The phone itself is running as <code>{serial}</code> — it is the viewer that is not
          answering. Check that the <code>ws-scrcpy</code> service is up.
        </p>
      </div>
    );
  }

  return (
    <iframe
      className="onboarding-screen"
      src={viewerUrl}
      title="Android device screen"
      // Separate origin, and it only needs input. Nothing it does should be
      // able to reach back into the dashboard.
      sandbox="allow-scripts allow-same-origin"
      allow="clipboard-write"
    />
  );
}
