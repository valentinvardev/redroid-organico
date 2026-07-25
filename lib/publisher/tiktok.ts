import { createReadStream, stat } from 'fs';
import { promisify } from 'util';
import type { Publisher, PublishRequest, PublishResult } from './types';
import { needsReauth, permanent, transient } from './errors';

const statAsync = promisify(stat);
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

interface TikTokCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string | number | Date;
  openId?: string;
}

function parseCredentials(credentials: unknown): TikTokCredentials {
  if (credentials && typeof credentials === 'object' && !Array.isArray(credentials)) {
    const candidate = credentials as Record<string, unknown>;

    const accessToken = typeof candidate.accessToken === 'string' ? candidate.accessToken.trim() : '';
    const refreshToken = typeof candidate.refreshToken === 'string' ? candidate.refreshToken.trim() : undefined;
    const openId = typeof candidate.openId === 'string' ? candidate.openId.trim() : undefined;
    const expiresAt =
      typeof candidate.expiresAt === 'string' || typeof candidate.expiresAt === 'number' || candidate.expiresAt instanceof Date
        ? candidate.expiresAt
        : undefined;

    if (!accessToken) {
      throw permanent('missing_credentials', 'TikTok access token is required');
    }

    return { accessToken, refreshToken, expiresAt, openId };
  }

  throw permanent('missing_credentials', 'TikTok credentials are required');
}

function credentialExpired(expiresAt: string | number | Date | undefined): boolean {
  if (!expiresAt) {
    return false;
  }

  const timestamp = typeof expiresAt === 'number' ? expiresAt : Date.parse(String(expiresAt));

  if (Number.isNaN(timestamp)) {
    return false;
  }

  return Date.now() > timestamp;
}

export class TikTokPublisher implements Publisher {
  readonly name = 'tiktok';

  async publish(request: PublishRequest): Promise<PublishResult> {
    const { caption, account, video, log, signal } = request;
    const credentials = parseCredentials(account.credentials);

    if (credentialExpired(credentials.expiresAt)) {
      throw needsReauth('TikTok access token has expired');
    }

    if (caption.trim().length === 0) {
      throw permanent('empty_caption', 'Caption must not be empty');
    }

    let sizeOnDisk: number;

    try {
      const metadata = await statAsync(video.localPath);
      sizeOnDisk = metadata.size;
    } catch (cause) {
      throw transient('media_unreadable', `Staged media is not readable at ${video.localPath}`, cause);
    }

    if (sizeOnDisk !== video.sizeBytes) {
      throw permanent(
        'media_size_mismatch',
        `Staged media is ${sizeOnDisk} bytes but the record says ${video.sizeBytes}`,
      );
    }

    const form = new FormData();
    form.append('video', createReadStream(video.localPath) as unknown as Blob, video.fileName);
    form.append('caption', caption);

    if (credentials.openId) {
      form.append('open_id', credentials.openId);
    }

    await log.info('Uploading media to TikTok', {
      accountId: account.id,
      accountName: account.name,
      fileName: video.fileName,
      sizeBytes: sizeOnDisk,
    });

    const response = await fetch(`${TIKTOK_API_BASE}/video/upload/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
      },
      body: form,
      signal,
    });

    let payload: unknown;

    try {
      payload = await response.json();
    } catch (cause) {
      throw transient('invalid_response', 'TikTok API returned invalid JSON', cause);
    }

    if (!response.ok) {
      const errorMessage = JSON.stringify(payload);
      if (response.status === 401 || response.status === 403) {
        throw needsReauth('TikTok credentials are invalid or expired');
      }

      if (response.status >= 500) {
        throw transient('tiktok_server_error', `TikTok returned ${response.status}: ${errorMessage}`);
      }

      throw permanent('tiktok_publish_failed', `TikTok API rejected the upload: ${errorMessage}`);
    }

    const body = payload as Record<string, unknown>;
    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data))
      ? (body.data as Record<string, unknown>)
      : {};

    const externalPostId = String(data.post_id ?? data.item_id ?? data.video_id ?? '');
    const url = typeof data.share_url === 'string' ? data.share_url : typeof data.video_url === 'string' ? data.video_url : undefined;

    if (!externalPostId) {
      throw transient('tiktok_response_missing_id', `TikTok response did not include a post identifier: ${JSON.stringify(body)}`);
    }

    await log.info('TikTok publish succeeded', { externalPostId, url });

    return { externalPostId, url };
  }
}
