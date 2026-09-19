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

export interface CameraPublication {
  /** For the local preview. Already live when this resolves. */
  stream: MediaStream;
  /** Idempotent. Stops the tracks and tells the server to drop the session. */
  stop(): Promise<void>;
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

export async function publishCamera(ingestUrl: string): Promise<CameraPublication> {
  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Matched to the bridge's default output so nothing has to be rescaled
      // twice on the way to a device.
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      // The phone's camera is what is being stood in for, and no verification
      // flow this is used for asks for sound. Not sending it means never having
      // to explain where the operator's microphone audio went.
      audio: false,
    });
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

    return { stream, stop };
  } catch (error) {
    // Never leave the camera light on because negotiation failed.
    await stop();
    throw error;
  }
}
