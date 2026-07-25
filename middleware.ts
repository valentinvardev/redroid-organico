import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/cookie';

/**
 * This is a UX gate, not the security boundary.
 *
 * Middleware runs on the Edge runtime and cannot reach Postgres, so it only
 * checks whether a session cookie is present — it cannot tell a valid token from
 * a forged one. Authorisation is enforced in the route handlers and pages, which
 * resolve the session against the database on every request.
 *
 * Its job is to send a signed-out visitor to /login instead of letting them load
 * a dashboard that would then fail its own data fetches.
 */
export function middleware(request: NextRequest) {
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const { pathname, search } = request.nextUrl;

  if (hasCookie) {
    return NextResponse.next();
  }

  // An API client must get a JSON 401, never a 307 to an HTML login page.
  // Redirecting these made every unauthenticated API call look like a routing
  // quirk instead of an auth failure.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ message: 'Authentication required' }, { status: 401 });
  }

  const login = new URL('/login', request.url);
  login.searchParams.set('next', pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  /**
   * Everything except the login page, the auth endpoints, the health check and
   * static assets. Listing exclusions rather than inclusions means a new page is
   * protected by default instead of accidentally public.
   */
  matcher: ['/((?!login|api/auth|api/health|_next/static|_next/image|favicon.ico).*)'],
};
