import type { LogLevel, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

const REDACTED = '[redacted]';

/**
 * Keys whose values never belong in a job log. Credentials pass through the
 * worker on every job, so redaction is applied here rather than trusted to
 * every future call site.
 */
const SENSITIVE_KEYS = new Set([
  'credentials',
  'credential',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'apikey',
  'api_key',
  'cookie',
  'session',
  // A proxy config carries a password, and `PROXY=socks5://user:pass@host` is
  // the whole credential in one string. The deliberate, already-redacted form
  // is logged under `egress`, so this key is safe to blank unconditionally.
  'proxy',
  'proxyurl',
  'proxy_url',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || value === undefined) {
    return value ?? null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, depth + 1);
    }

    return output;
  }

  return value;
}

export class JobLogger {
  constructor(private readonly jobId: string) {}

  async debug(message: string, data?: Record<string, unknown>) {
    await this.write('DEBUG', message, data);
  }

  async info(message: string, data?: Record<string, unknown>) {
    await this.write('INFO', message, data);
  }

  async warn(message: string, data?: Record<string, unknown>) {
    await this.write('WARN', message, data);
  }

  async error(message: string, data?: Record<string, unknown>) {
    await this.write('ERROR', message, data);
  }

  private async write(level: LogLevel, message: string, data?: Record<string, unknown>) {
    try {
      await prisma.jobLog.create({
        data: {
          jobId: this.jobId,
          level,
          message: message.slice(0, 10_000),
          data: data ? (redact(data) as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (cause) {
      // A logging failure must never take down the job it is describing.
      console.error(`[jobLogger] failed to persist log for job ${this.jobId}`, cause);
    }
  }
}

export function jobLogger(jobId: string): JobLogger {
  return new JobLogger(jobId);
}
