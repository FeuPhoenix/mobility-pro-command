/**
 * Who is acting, and what they may act on.
 *
 * Two modes (see auth/config.ts):
 *
 *   - demo: the acting person is carried in a cookie so a demonstration can
 *     switch between a manager, a coordinator and a second company's lead. A
 *     demo control, not a security boundary, and labelled as one in the UI.
 *   - entra: the acting person is the one who signed in with Microsoft, from a
 *     signed session cookie. No session, no access.
 *
 * Either way every request is resolved to a real user row and every
 * company-scoped read and write goes through `Ctx`, so the authorisation
 * checks elsewhere are the same in both modes. This is the one function that
 * differs.
 */

import { cookies } from 'next/headers';
import { getUser, listUsers, FreightError, type Ctx } from './repo';
import { isSystemRole } from './types';
import { authMode, entraConfig, SESSION_COOKIE } from './auth/config';
import { verifyToken } from './auth/token';
import { personForSession } from './auth/people';

export const USER_COOKIE = 'freight_user';

/** The signed-in person for a session cookie value, or null. Pure, for tests. */
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
 * somewhere sensible rather than on an error page. Entra mode never falls
 * back: without a valid session the request is refused.
 */
export async function resolveCtx(): Promise<Ctx> {
  const store = await cookies();

  if (authMode() === 'entra') {
    const { config, problems } = entraConfig();
    if (!config) {
      throw new FreightError(
        `Sign-in is switched on but not fully configured, so nothing is available: ${problems.join(' ')}`,
        503,
        'auth_misconfigured',
      );
    }
    const ctx = ctxFromSession(store.get(SESSION_COOKIE)?.value, config.sessionSecret);
    if (!ctx) throw new FreightError('Sign in to continue.', 401, 'not_signed_in');
    return ctx;
  }

  const id = store.get(USER_COOKIE)?.value;
  if (id) {
    const user = getUser(id);
    // A system identity is never a person a request can act as.
    if (user && !isSystemRole(user.role) && !user.disabled) return { user };
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

/** Resolves a context without throwing when the store is empty or nobody is signed in. */
export async function tryResolveCtx(): Promise<Ctx | null> {
  try {
    return await resolveCtx();
  } catch {
    return null;
  }
}
