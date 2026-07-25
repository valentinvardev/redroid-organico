import { getStorage } from '@/lib/media/storage';
import { getPageSource, takeScreenshot, type AppiumSessionInfo } from './appium';

export interface CapturedEvidence {
  screenshotKey?: string;
  pageSourceKey?: string;
  /** Why a piece of evidence is missing, when it is. */
  failures: string[];
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'step';
}

/**
 * Grabs a screenshot and the UI hierarchy and parks them in storage (the local
 * dir, or S3/R2 in a real deployment) so a failed run can be diagnosed after
 * the container is gone.
 *
 * Never throws. This runs on the failure path, and an error here would replace
 * the real cause with a confusing one — the diagnostic must not become the
 * incident.
 */
export async function captureEvidence(
  session: AppiumSessionInfo,
  jobId: string,
  label: string,
  signal?: AbortSignal,
): Promise<CapturedEvidence> {
  const evidence: CapturedEvidence = { failures: [] };
  const prefix = `artifacts/${jobId}/${Date.now()}-${slug(label)}`;

  let storage: Awaited<ReturnType<typeof getStorage>>;

  try {
    storage = await getStorage();
  } catch (cause) {
    evidence.failures.push(`storage unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    return evidence;
  }

  try {
    const base64 = await takeScreenshot(session, signal);

    if (base64) {
      const key = `${prefix}.png`;
      await storage.put(key, Buffer.from(base64, 'base64'));
      evidence.screenshotKey = key;
    }
  } catch (cause) {
    evidence.failures.push(`screenshot: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  try {
    const xml = await getPageSource(session, signal);

    if (xml) {
      const key = `${prefix}.xml`;
      await storage.put(key, Buffer.from(xml, 'utf8'));
      evidence.pageSourceKey = key;
    }
  } catch (cause) {
    evidence.failures.push(`page source: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  return evidence;
}
