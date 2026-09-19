import { getEnv } from '@/lib/env';
import { cameraStreamName } from './cameraBridge';

/**
 * Where the operator's browser should publish its webcam for a given job.
 *
 * Built from the job id alone, on purpose. The device viewer's URL is derived
 * from a serial and therefore cannot exist until a device does — but this one
 * is needed *earlier* than that, because the worker refuses to start a device
 * until something is publishing. The job id is the first identifier in the
 * whole flow, so it is what names the stream.
 *
 * `{host}` is left in place for the browser to substitute, exactly as the
 * viewer template is: the server has no reliable idea of the address the
 * operator reached it on. See app/components/viewerUrl.ts.
 */
export function cameraIngestUrl(jobId: string): string | undefined {
  const template = getEnv().CAMERA_INGEST_URL_TEMPLATE;

  if (!template) {
    return undefined;
  }

  return template.split('{stream}').join(cameraStreamName(jobId)).split('{jobId}').join(jobId);
}
