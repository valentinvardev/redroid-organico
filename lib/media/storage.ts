import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rm, stat, writeFile } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getEnv } from '@/lib/env';

export interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer): Promise<void>;
  /** Materialises the object on local disk; the worker needs a real file path. */
  download(key: string, destination: string): Promise<void>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function assertSafeKey(key: string): void {
  if (key.includes('..') || path.isAbsolute(key) || key.includes('\0')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

class LocalStorage implements StorageDriver {
  readonly name = 'local' as const;

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    const target = path.resolve(this.root, key);
    const root = path.resolve(this.root);

    // Defence in depth: even with assertSafeKey, never write outside the root.
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }

    return target;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async download(key: string, destination: string): Promise<void> {
    const source = this.resolve(key);
    await mkdir(path.dirname(destination), { recursive: true });

    // Both streams are created and handed to `pipeline` with no `await` in
    // between. Yielding to the event loop here would let a ReadStream on a
    // missing file emit 'error' before pipeline attaches its handler, which
    // surfaces as an unhandled 'error' event and kills the worker process
    // instead of failing this one job.
    await pipeline(createReadStream(source), createWriteStream(destination));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

class S3Storage implements StorageDriver {
  readonly name = 's3' as const;

  constructor(
    private readonly client: import('@aws-sdk/client-s3').S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer): Promise<void> {
    assertSafeKey(key);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
  }

  async download(key: string, destination: string): Promise<void> {
    assertSafeKey(key);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { createWriteStream } = await import('fs');

    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));

    if (!response.Body) {
      throw new Error(`S3 object ${key} has no body`);
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await pipeline(response.Body as Readable, createWriteStream(destination));
  }

  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');

    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}

let cached: StorageDriver | undefined;

/**
 * Async so the AWS SDK is imported only when STORAGE_DRIVER=s3 — a local-driver
 * deployment never pays for loading it, and there is no `require` mixed into an
 * ES module for the bundler to trip over.
 */
export async function getStorage(): Promise<StorageDriver> {
  if (cached) {
    return cached;
  }

  const env = getEnv();

  if (env.STORAGE_DRIVER === 'local') {
    cached = new LocalStorage(path.resolve(process.cwd(), env.STORAGE_LOCAL_DIR));
    return cached;
  }

  // Required fields are checked in lib/env.ts when STORAGE_DRIVER=s3.
  const { S3Client } = await import('@aws-sdk/client-s3');

  cached = new S3Storage(
    new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      // R2 and most S3-compatible endpoints require path-style addressing.
      forcePathStyle: Boolean(env.S3_ENDPOINT),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    }),
    env.S3_BUCKET!,
  );

  return cached;
}
