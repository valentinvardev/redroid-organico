import { execFile } from 'child_process';
import { promisify } from 'util';
import { getEnv } from '@/lib/env';

const execFileAsync = promisify(execFile);

export interface MediaMetadata {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string };
}

/**
 * `execFile` rather than `exec`: arguments are passed as an array and never go
 * through a shell, so a filename cannot inject a command.
 */
export async function probe(localPath: string): Promise<MediaMetadata> {
  const { stdout } = await execFileAsync(
    getEnv().FFPROBE_PATH,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', localPath],
    { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];

  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const duration = Number(parsed.format?.duration ?? video?.duration);
  const bitrate = Number(parsed.format?.bit_rate);

  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    bitrate: Number.isFinite(bitrate) ? bitrate : null,
  };
}

export async function extractThumbnail(localPath: string, destination: string): Promise<void> {
  await execFileAsync(
    getEnv().FFMPEG_PATH,
    [
      '-y',
      '-ss', '00:00:01',
      '-i', localPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      destination,
    ],
    { timeout: 60_000 },
  );
}

export async function isFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync(getEnv().FFPROBE_PATH, ['-version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
