import { NextResponse } from 'next/server';
import { UnauthorizedError } from './currentUser';

/**
 * Wraps a route handler so an UnauthorizedError becomes a 401 instead of a 500.
 * Without this every route would need its own try/catch around the auth call,
 * and the one that forgot would leak a stack trace as a server error.
 */
export function guarded<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        return NextResponse.json({ message: error.message }, { status: 401 });
      }

      throw error;
    }
  };
}
