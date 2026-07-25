import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { SESSION_COOKIE, createSession, sessionCookieOptions } from '@/lib/auth/session';
import { clientIp } from '@/lib/auth/loginThrottle';
import { EmailTakenError, UserValidationError, createUserWithPassword } from '@/lib/auth/users';
import { getRedis } from '@/lib/queue/connection';

export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1_024),
  name: z.string().max(200).optional(),
});

const WINDOW_SECONDS = 60 * 60;
const MAX_PER_WINDOW = 5;

export async function POST(request: Request) {
  // Off by default. An internal tool should gain operators through
  // `npm run user:create`, not through an endpoint anyone can reach.
  if (!getEnv().ALLOW_REGISTRATION) {
    return NextResponse.json(
      { message: 'Registration is disabled. Ask an administrator for an account.' },
      { status: 403 },
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: 'Expected a JSON body' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ message: 'Email and password are required' }, { status: 400 });
  }

  const ip = clientIp(request);
  const key = `register:${ip}`;
  const count = await getRedis().incr(key);

  if (count === 1) {
    await getRedis().expire(key, WINDOW_SECONDS);
  }

  if (count > MAX_PER_WINDOW) {
    return NextResponse.json(
      { message: 'Too many accounts created from this address. Try again later.' },
      { status: 429 },
    );
  }

  try {
    const user = await createUserWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name,
    });

    const token = await createSession(user.id, request.headers.get('user-agent'));
    cookies().set(SESSION_COOKIE, token, sessionCookieOptions());

    return NextResponse.json(
      { user: { id: user.id, email: user.email, name: user.name } },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof EmailTakenError) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }

    if (error instanceof UserValidationError) {
      return NextResponse.json({ message: error.message }, { status: 422 });
    }

    throw error;
  }
}
