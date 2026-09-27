/**
 * Who is acting on this request.
 *
 * The acting person comes from a verified session cookie. There is no fallback:
 * an unauthenticated request has no `Ctx`, so it cannot reach a company-scoped
 * read or write at all.
 *
 * Everything downstream is unchanged. `assertCompanyAccess`, `assertCanApprove`
 * and `assertCanSend` were always enforced against `Ctx`; they simply now
 * receive a person who has proved who they are. That was the point of routing
 * every scoped call through `Ctx` from the start.
 *
 * The automation endpoints are the one exception, deliberately: a scheduler has
 * no session, so it presents a bearer token and runs as a system identity that
 * can neither approve nor send. See `automation-auth.ts`.
 */

import { cookies } from 'next/headers';
import { FreightError, type Ctx } from './repo';
import { SESSION_COOKIE, userForToken } from './auth';

export { SESSION_COOKIE };

export class NotSignedIn extends FreightError {
  constructor() {
    super('You are not signed in.', 401, 'not_signed_in');
  }
}

/**
 * Resolves the signed-in person, or throws 401.
 *
 * Route handlers let this propagate; the client sees the 401 and sends the
 * person to the sign-in page.
 */
export async function resolveCtx(): Promise<Ctx> {
  const ctx = await tryResolveCtx();
  if (!ctx) throw new NotSignedIn();
  return ctx;
}

/** Resolves the signed-in person, or null when there is no valid session. */
export async function tryResolveCtx(): Promise<Ctx | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const user = userForToken(token);
  return user ? { user } : null;
}

/**
 * Cookie options.
 *
 * `secure` is decided by the protocol the request actually arrived on, not by
 * NODE_ENV. Keying it off NODE_ENV looks right and is wrong: `next start` sets
 * production, a browser refuses to store a `Secure` cookie over plain HTTP, and
 * sign-in then fails silently on any local or internal HTTP deployment. So:
 * secure over TLS, and over a proxy that says it terminated TLS; not otherwise.
 *
 * `FREIGHT_FORCE_SECURE_COOKIES=true` pins it on for a deployment that knows it
 * is always behind TLS.
 */
export function sessionCookieOptions(request?: Request) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: isSecureRequest(request),
    maxAge: 7 * 24 * 60 * 60,
  };
}

function isSecureRequest(request?: Request): boolean {
  if (process.env.FREIGHT_FORCE_SECURE_COOKIES === 'true') return true;
  if (!request) return false;
  if (request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}
