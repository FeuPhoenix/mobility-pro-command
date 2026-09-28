/**
 * Authentication for the automation endpoints.
 *
 * A scheduler has no session, so it presents a bearer token. With no token
 * configured the endpoints are **switched off** rather than left open — the
 * safe default for a surface that can reach into every company's data.
 *
 * The token is separate from `MAILBOX_COLLECT_TOKEN` on purpose: collection
 * only files replies, whereas these endpoints can prepare drafts and retry
 * writes. Two tokens means one can be rotated or revoked without the other.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

export const AUTOMATION_TOKEN_ENV = 'FREIGHT_AUTOMATION_TOKEN';

export type AuthFailure = { response: NextResponse };

/**
 * Returns nothing when the caller is allowed, or the response to return when
 * it is not. Comparison is constant-time so the token cannot be guessed by
 * timing the reply.
 */
export function checkAutomationAuth(request: Request): AuthFailure | null {
  const expected = process.env[AUTOMATION_TOKEN_ENV];
  if (!expected) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: `Automation endpoints are switched off. Set ${AUTOMATION_TOKEN_ENV} to enable them.`,
        },
        { status: 404 },
      ),
    };
  }

  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { response: NextResponse.json({ ok: false, error: 'Not authorised.' }, { status: 401 }) };
  }
  return null;
}

/** Wraps a handler so every automation route authenticates identically. */
export function withAutomationAuth(
  handler: (request: Request) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const failure = checkAutomationAuth(request);
    if (failure) return failure.response;
    try {
      return await handler(request);
    } catch (err) {
      // Never leak an internal message to an external caller.
      console.error('[freight/automation]', err);
      return NextResponse.json(
        { ok: false, error: 'The request could not be completed.' },
        { status: 500 },
      );
    }
  };
}
