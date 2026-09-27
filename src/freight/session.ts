/**
 * Who is acting, and what they may act on.
 *
 * Three modes (see auth/config.ts):
 *
 *   - demo:     the acting person is carried in a cookie so a demonstration can
 *               switch between a manager, a coordinator and a second company's
 *               lead. A demo control, not a security boundary, and labelled as
 *               one in the UI.
 *   - password: email and password held here, hashed with scrypt, with
 *               revocable sessions. For a deployment that cannot use Entra, or
 *               is not willing to wait for it.
 *   - entra:    Sign in with Microsoft. Only people on the People screen get in.
 *
 * Either way every request resolves to a real user row and every company-scoped
 * read and write goes through `Ctx`, so the authorisation checks elsewhere are
 * identical in all three. This is the one function that differs.
 */

import { cookies } from 'next/headers';
import { getUser, listUsers, FreightError, type Ctx } from './repo';
import { authMode, entraConfig, SESSION_COOKIE } from './auth/config';
import { verifyToken } from './auth/token';
import { personForSession } from './auth/people';
import { userForToken } from './auth/password';

export const USER_COOKIE = 'freight_user';
export { SESSION_COOKIE };

export class NotSignedIn extends FreightError {
  constructor() {
    super('Sign in to continue.', 401, 'not_signed_in');
  }
}

/** The signed-in person for an Entra session cookie value, or null. Pure, for tests. */
export function ctxFromSession(value: string | undefined, secret: string): Ctx | null {
  const payload = verifyToken<{ uid?: string }>(value, secret);
  if (!payload?.uid) return null;
  const user = personForSession(payload.uid);
  return user ? { user } : null;
}

/**
 * Resolves the acting user for this request.
 *
 * In demo mode it falls back to the first manager so a fresh visitor lands
 * somewhere sensible rather than on an error page. The other two never fall
 * back: without a valid session the request is refused.
 */
export async function resolveCtx(): Promise<Ctx> {
  const store = await cookies();
  const mode = authMode();

  if (mode === 'entra') {
    const { config, problems } = entraConfig();
    if (!config) {
      throw new FreightError(
        `Sign-in is switched on but not fully configured, so nothing is available: ${problems.join(' ')}`,
        503,
        'auth_misconfigured',
      );
    }
    const ctx = ctxFromSession(store.get(SESSION_COOKIE)?.value, config.sessionSecret);
    if (!ctx) throw new NotSignedIn();
    return ctx;
  }

  if (mode === 'password') {
    // The session is a row, so disabling someone or changing their password
    // takes effect on their next request rather than at expiry.
    const user = userForToken(store.get(SESSION_COOKIE)?.value);
    if (!user) throw new NotSignedIn();
    return { user };
  }

  const id = store.get(USER_COOKIE)?.value;
  if (id) {
    const user = getUser(id);
    // A system identity is never a person a request can act as.
    if (user && user.role !== 'system_mailbox_collector' && !user.disabled) return { user };
  }

  const all = listUsers().filter((u) => !u.disabled);
  if (all.length === 0) {
    throw new FreightError(
      'This workspace has no data yet. Load the demonstration dataset to get started.',
      409,
      'not_seeded',
    );
  }
  return { user: all.find((u) => u.role === 'logistics_manager') ?? all[0] };
}

/** Resolves a context without throwing when nobody is signed in. */
export async function tryResolveCtx(): Promise<Ctx | null> {
  try {
    return await resolveCtx();
  } catch {
    return null;
  }
}

/**
 * Cookie options for password mode.
 *
 * `secure` follows the protocol the request arrived on, not NODE_ENV. Keying it
 * off NODE_ENV looks right and is wrong: `next start` sets production, a browser
 * refuses to store a `Secure` cookie over plain HTTP, and sign-in then fails
 * silently on any internal HTTP deployment.
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
