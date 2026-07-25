import { getRedis } from '@/lib/queue/connection';

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 8;

/**
 * Counts failed logins per email and per source address in Redis. Without this
 * the login endpoint is an unbounded password oracle, and scrypt's cost turns
 * that into a CPU exhaustion vector as well.
 */
function key(scope: string, value: string): string {
  return `login:fail:${scope}:${value.toLowerCase()}`;
}

export interface ThrottleState {
  blocked: boolean;
  retryAfterSeconds: number;
}

export async function checkLoginThrottle(email: string, ip: string): Promise<ThrottleState> {
  const redis = getRedis();

  const [emailCount, ipCount] = await redis.mget(key('email', email), key('ip', ip));
  const worst = Math.max(Number(emailCount ?? 0), Number(ipCount ?? 0));

  if (worst < MAX_ATTEMPTS) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  const ttl = await redis.ttl(key('email', email));

  return { blocked: true, retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS };
}

export async function recordLoginFailure(email: string, ip: string): Promise<void> {
  const redis = getRedis();

  await Promise.all(
    [key('email', email), key('ip', ip)].map(async (k) => {
      const count = await redis.incr(k);

      // Only set the TTL on first failure so the window is fixed rather than
      // sliding — otherwise a steady trickle of attempts never expires.
      if (count === 1) {
        await redis.expire(k, WINDOW_SECONDS);
      }
    }),
  );
}

export async function clearLoginFailures(email: string, ip: string): Promise<void> {
  await getRedis().del(key('email', email), key('ip', ip));
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');

  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  return request.headers.get('x-real-ip') ?? 'unknown';
}
