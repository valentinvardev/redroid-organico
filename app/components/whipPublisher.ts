/**
 * Publishes the operator's webcam to the media server with WHIP.
 *
 * WHIP is WebRTC reduced to one HTTP request: POST an SDP offer, get an SDP
 * answer back, done. No signalling socket, no library — which matters here
 * because this runs inside a dashboard that otherwise ships no WebRTC at all.
 *
 * The camera is granted per job, never held between them. A tab left open on a
 * finished onboarding should not still have the light on.
 */

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraPublication {
  /** For the local preview. Already live when this resolves. */
  stream: MediaStream;
  /** Which camera is currently being sent. */
  deviceId: string | null;
  /**
   * Swaps the camera without dropping the session.
   *
   * `replaceTrack` on the existing sender rather than a new offer: the codec
   * and the transport stay as negotiated, so the phone sees one continuous
   * stream instead of a stall while a second WHIP session is set up. Returns
   * the new stream for the preview.
   */
  switchTo(deviceId: string): Promise<MediaStream>;
  /** Idempotent. Stops the tracks and tells the server to drop the session. */
  stop(): Promise<void>;
}

/**
 * Browsers withhold camera labels until the page has been granted a camera
 * once — before that, `label` is an empty string on every device. A numbered
 * fallback keeps the list usable in that state instead of rendering a select
 * full of blank options.
 */
export function cameraLabel(label: string, index: number): string {
  return label.trim() || `Camera ${index + 1}`;
}

export async function listCameras(): Promise<CameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);

  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: cameraLabel(device.label, index),
    }));
}

function constraints(deviceId?: string | null): MediaStreamConstraints {
  return {
    // Matched to the bridge's default output so nothing has to be rescaled
    // twice on the way to a device.
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      // `exact`, so asking for a camera that has been unplugged fails loudly
      // instead of silently handing over a different one.
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    },
    // The phone's camera is what is being stood in for, and no verification
    // flow this is used for asks for sound. Not sending it means never having
    // to explain where the operator's microphone audio went.
    audio: false,
  };
}

export class CameraDeniedError extends Error {
  constructor(cause: unknown) {
    super(
      'The browser did not give us a camera. Check the permission prompt, that no other app ' +
        'is holding the camera, and that this page is served over HTTPS — getUserMedia is ' +
        'refused outright on a plain-HTTP origin.',
      { cause },
    );
    this.name = 'CameraDeniedError';
  }
}

/**
 * Waits for ICE gathering to finish instead of trickling candidates.
 *
 * WHIP has no channel to trickle over: the offer is posted once and the answer
 * comes back once. Posting before gathering completes produces a session that
 * negotiates and then never sends a frame, which is the same symptom as a
 * broken camera and much harder to tell apart.
 */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    // A relay-only network can leave gathering pending for a long time. The
    // candidates found by then are usually enough, and a late one is worth
    // less than a camera that never starts.
    const timer = setTimeout(finish, 3_000);

    function finish() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }

    function onChange() {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    }

    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

export async function publishCamera(
  ingestUrl: string,
  deviceId?: string | null,
): Promise<CameraPublication> {
  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    throw new CameraDeniedError(error);
  }

  const pc = new RTCPeerConnection();
  let resourceUrl: string | null = null;
  let stopped = false;

  const stop = async () => {
    if (stopped) {
      return;
    }

    stopped = true;

    for (const track of stream.getTracks()) {
      track.stop();
    }

    pc.close();

    if (resourceUrl) {
      // Best effort: the server times the session out on its own, and a failed
      // DELETE must not be something the operator has to think about.
      await fetch(resourceUrl, { method: 'DELETE' }).catch(() => undefined);
    }
  };

  try {
    for (const track of stream.getTracks()) {
      pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    }

    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);

    const response = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription?.sdp ?? '',
    });

    if (!response.ok) {
      throw new Error(
        `The media server refused the camera (${response.status}). ` +
          'Check that the mediamtx service is up and reachable from this browser.',
      );
    }

    const location = response.headers.get('Location');

    if (location) {
      resourceUrl = new URL(location, ingestUrl).toString();
    }

    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });

    const publication: CameraPublication = {
      stream,
      deviceId: stream.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId ?? null,

      switchTo: async (next: string) => {
        const sender = pc.getSenders().find((candidate) => candidate.track?.kind === 'video');

        if (!sender) {
          throw new Error('this session has no video sender to swap');
        }

        let replacement: MediaStream;

        try {
          replacement = await navigator.mediaDevices.getUserMedia(constraints(next));
        } catch (error) {
          throw new CameraDeniedError(error);
        }

        const track = replacement.getVideoTracks()[0];

        if (!track) {
          throw new Error('the selected camera produced no video track');
        }

        await sender.replaceTrack(track);

        // Only after the swap succeeded: stopping first would blank the phone
        // for as long as the new camera takes to open, and leave it blank for
        // good if opening it failed.
        for (const old of publication.stream.getTracks()) {
          old.stop();
        }

        publication.stream = replacement;
        publication.deviceId = track.getSettings().deviceId ?? next;

        return replacement;
      },

      stop: async () => {
        // Re-read through the object: `stream` above is the one this session
        // started with, and a switch has since replaced it.
        for (const track of publication.stream.getTracks()) {
          track.stop();
        }

        await stop();
      },
    };

    return publication;
  } catch (error) {
    // Never leave the camera light on because negotiation failed.
    await stop();
    throw error;
  }
}
