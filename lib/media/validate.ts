import type { MediaMetadata } from './probe';

export interface MediaSpec {
  maxSizeBytes: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
  minWidth: number;
  minHeight: number;
  /** width / height, inclusive range. 9:16 ≈ 0.5625, 16:9 ≈ 1.7778. */
  minAspectRatio: number;
  maxAspectRatio: number;
  allowedMimeTypes: string[];
  allowedVideoCodecs: string[];
}

/**
 * Conservative defaults that sit inside what the major platforms accept, so a
 * video that passes here is unlikely to be rejected downstream. Tighten per
 * platform when a real adapter lands.
 */
export const DEFAULT_SPEC: MediaSpec = {
  maxSizeBytes: 500 * 1024 * 1024,
  minDurationSeconds: 1,
  maxDurationSeconds: 600,
  minWidth: 360,
  minHeight: 360,
  minAspectRatio: 0.5,
  maxAspectRatio: 1.8,
  allowedMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
  allowedVideoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
};

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validateMedia(
  input: { mimeType: string; sizeBytes: number; metadata: MediaMetadata },
  spec: MediaSpec = DEFAULT_SPEC,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { mimeType, sizeBytes, metadata } = input;

  if (!spec.allowedMimeTypes.includes(mimeType)) {
    issues.push({
      field: 'mimeType',
      message: `${mimeType} is not supported. Allowed: ${spec.allowedMimeTypes.join(', ')}`,
    });
  }

  if (sizeBytes > spec.maxSizeBytes) {
    issues.push({
      field: 'sizeBytes',
      message: `File is ${formatBytes(sizeBytes)}, limit is ${formatBytes(spec.maxSizeBytes)}`,
    });
  }

  if (metadata.width === null || metadata.height === null) {
    issues.push({ field: 'dimensions', message: 'No video stream found in the file' });
  } else {
    if (metadata.width < spec.minWidth || metadata.height < spec.minHeight) {
      issues.push({
        field: 'dimensions',
        message: `Resolution is ${metadata.width}x${metadata.height}, minimum is ${spec.minWidth}x${spec.minHeight}`,
      });
    }

    const aspect = metadata.width / metadata.height;

    if (aspect < spec.minAspectRatio || aspect > spec.maxAspectRatio) {
      issues.push({
        field: 'aspectRatio',
        message: `Aspect ratio ${aspect.toFixed(3)} is outside the accepted range ${spec.minAspectRatio}–${spec.maxAspectRatio}`,
      });
    }
  }

  if (metadata.durationSeconds === null) {
    issues.push({ field: 'duration', message: 'Could not determine duration' });
  } else if (metadata.durationSeconds < spec.minDurationSeconds) {
    issues.push({
      field: 'duration',
      message: `Video is ${metadata.durationSeconds.toFixed(2)}s, minimum is ${spec.minDurationSeconds}s`,
    });
  } else if (metadata.durationSeconds > spec.maxDurationSeconds) {
    issues.push({
      field: 'duration',
      message: `Video is ${metadata.durationSeconds.toFixed(0)}s, maximum is ${spec.maxDurationSeconds}s`,
    });
  }

  if (metadata.videoCodec && !spec.allowedVideoCodecs.includes(metadata.videoCodec)) {
    issues.push({
      field: 'videoCodec',
      message: `Codec ${metadata.videoCodec} is not supported. Allowed: ${spec.allowedVideoCodecs.join(', ')}`,
    });
  }

  return issues;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}
