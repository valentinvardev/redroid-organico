'use client';

import { useEffect, useRef } from 'react';
import { Countdown } from './Countdown';
import {
  useOnboarding,
  useViewerReachable,
  type CameraState,
  type OnboardingState,
} from './useOnboarding';
import { browserHost, resolveViewerUrl } from './viewerUrl';

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
  const { state, live, camera, start, grantCamera, selectCamera, confirm, cancel, reset } =
    useOnboarding(accountId);

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

        <Body
          state={state}
          camera={camera}
          onStart={() => void start()}
          onGrantCamera={() => void grantCamera()}
          onSelectCamera={(deviceId) => void selectCamera(deviceId)}
          onConfirm={() => void confirm()}
        />
      </div>
    </div>
  );
}

function Body({
  state,
  camera,
  onStart,
  onGrantCamera,
  onSelectCamera,
  onConfirm,
}: {
  state: OnboardingState;
  camera: CameraState;
  onStart(): void;
  onGrantCamera(): void;
  onSelectCamera(deviceId: string): void;
  onConfirm(): void;
}) {
  // Ahead of the spinner, not beside it: the worker will not start a device
  // until this stream is published, so "starting a phone for you" would be a
  // lie told while it waits on the operator.
  if (state.phase === 'waiting_for_device' && camera.needed && camera.status !== 'live') {
    return <CameraPrompt camera={camera} onGrant={onGrantCamera} onSelect={onSelectCamera} />;
  }

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

          <Egress
            ip={state.endpoint.egressIp}
            location={state.endpoint.egressLocation}
            kind={state.endpoint.egressKind}
          />

          <Screen viewerUrl={state.endpoint.viewerUrl} serial={state.endpoint.serial} />

          {camera.needed && camera.stream ? (
            <CameraPreview camera={camera} onSelect={onSelectCamera} />
          ) : null}

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

/**
 * Where this phone appears from, while it is being used.
 *
 * The number is measured, not configured: it is what the device itself answered
 * when the egress check asked, so it also doubles as the visible proof that the
 * proxy is in effect. Absent means the account has no proxy — worth saying out
 * loud rather than leaving blank, because "leaves through this server" is a
 * fact somebody about to log in should have.
 */
type EgressKind = 'hosting' | 'proxy' | 'mobile' | 'unflagged';

/**
 * What the address is, not who blocked it. `unflagged` is not called
 * "residential" on purpose: the absence of a datacentre marking is evidence,
 * not proof, and a badge that overstates it is worse than no badge.
 */
const KIND_COPY: Record<EgressKind, { label: string; tone: string; hint: string }> = {
  hosting: {
    label: 'datacenter',
    tone: 'warn',
    hint: 'Rango de hosting. Las plataformas lo discuten: esperá desafíos de login.',
  },
  proxy: {
    label: 'proxy conocido',
    tone: 'bad',
    hint: 'Publicada en listas de proxies. Es la peor señal posible para una cuenta.',
  },
  mobile: { label: 'móvil', tone: 'ok', hint: 'Rango de operador móvil, el menos cuestionado.' },
  unflagged: {
    label: 'sin marcas',
    tone: 'ok',
    hint: 'Sin marcas de datacenter ni de proxy. Compatible con residencial.',
  },
};

function Egress({ ip, location, kind }: { ip?: string; location?: string; kind?: EgressKind }) {
  if (!ip) {
    return (
      <p className="egress-badge egress-badge-bare">
        Sin proxy: esta sesión sale por la dirección del servidor.
      </p>
    );
  }

  const classified = kind ? KIND_COPY[kind] : null;

  return (
    <p className="egress-badge">
      <code>{ip}</code>
      {classified ? (
        <span className={`pill pill-${classified.tone}`} title={classified.hint}>
          {classified.label}
        </span>
      ) : null}
      {location ? <span className="hint">{location}</span> : null}
    </p>
  );
}

/** The device screen, or an explanation of why there isn't one. */
function Screen({ viewerUrl: template, serial }: { viewerUrl?: string; serial: string }) {
  // Resolved against the address this page was loaded from, so one template
  // works through an SSH tunnel, a public IP or a domain — and survives the box
  // getting a new address. See app/components/viewerUrl.ts.
  const viewerUrl = resolveViewerUrl(template, browserHost());
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

/**
 * Asks for the operator's webcam before the phone exists.
 *
 * The permission has to follow a click — browsers refuse getUserMedia that is
 * not tied to a user gesture — so this is a button, not something that fires on
 * mount. And it has to come first: the worker holds the device back until the
 * media server reports this stream, so the order a person experiences matches
 * the order things actually happen.
 */
function CameraPrompt({
  camera,
  onGrant,
  onSelect,
}: {
  camera: Extract<CameraState, { needed: true }>;
  onGrant(): void;
  onSelect(deviceId: string): void;
}) {
  const requesting = camera.status === 'requesting';

  return (
    <div className="onboarding-body onboarding-centred">
      <p className="onboarding-lead">This phone needs a camera.</p>
      <p className="hint">
        The app will ask you to take a photo or a short video to confirm it is you. Your webcam
        stands in for the phone&apos;s front camera, only for this login, and turns off as soon
        as it ends.
      </p>

      {camera.status === 'failed' && camera.error ? (
        <p className="onboarding-error" role="alert">
          {camera.error}
        </p>
      ) : null}

      {/* Only after a failed or repeated grant is there a list to show: the
          browser hands out no device labels until it has said yes once. */}
      <CameraPicker camera={camera} onSelect={onSelect} />

      <button type="button" className="primary big" onClick={onGrant} disabled={requesting}>
        {requesting
          ? 'Waiting for your browser…'
          : camera.status === 'failed'
            ? 'Try again'
            : 'Use my camera'}
      </button>
    </div>
  );
}

/**
 * What the phone's camera is seeing, from the operator's side.
 *
 * Worth the screen space: the viewer shows the app, but a person pointing their
 * face at a laptop has no other way to tell whether they are in frame before
 * the app takes the shot.
 */
function CameraPreview({
  camera,
  onSelect,
}: {
  camera: Extract<CameraState, { needed: true }>;
  onSelect(deviceId: string): void;
}) {
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (video.current) {
      video.current.srcObject = camera.stream;
    }
  }, [camera.stream]);

  return (
    <figure className="onboarding-camera">
      {/* Muted and inline, or mobile Safari refuses to autoplay it. Mirrored,
          because that is what a person expects a selfie preview to look like. */}
      <video ref={video} autoPlay muted playsInline style={{ transform: 'scaleX(-1)' }} />

      {/* Switchable mid-session: the phone keeps receiving one continuous
          stream, so picking the wrong camera is not worth restarting for. */}
      <CameraPicker camera={camera} onSelect={onSelect} />

      {camera.error ? (
        <figcaption className="onboarding-error" role="alert">
          {camera.error}
        </figcaption>
      ) : (
        <figcaption className="hint">Your camera, as the phone sees it</figcaption>
      )}
    </figure>
  );
}

/** The list is empty before the first grant, and pointless with one camera. */
function CameraPicker({
  camera,
  onSelect,
}: {
  camera: Extract<CameraState, { needed: true }>;
  onSelect(deviceId: string): void;
}) {
  if (camera.devices.length < 2) {
    return null;
  }

  return (
    <label className="onboarding-camera-picker">
      <span className="hint">Camera</span>
      <select
        value={camera.deviceId ?? ''}
        onChange={(event) => onSelect(event.target.value)}
        disabled={camera.status === 'requesting'}
      >
        {camera.devices.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
      </select>
    </label>
  );
}
