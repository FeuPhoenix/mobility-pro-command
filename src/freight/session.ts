/**
 * Who is acting, and what they may act on.
 *
 * HONEST LIMIT
 * ------------
 * There is no authentication in this phase, and the brief does not ask for one.
 * The acting user is carried in a cookie so the demonstration can switch between
 * a manager, a coordinator and a second company's lead. That is a *demo* control,
 * not a security boundary, and it is labelled as one in the UI.
 *
 * What this module does provide, and what the rest of the code relies on, is
 * that every request is resolved to a real user row and every company-scoped
 * read and write goes through `Ctx`. So when authentication is added, it
 * replaces exactly one function - `resolveCtx` - and the authorisation checks
 * already in place keep working unchanged.
 */

import { cookies } from 'next/headers';
import { getUser, listUsers, FreightError, type Ctx } from './repo';

export const USER_COOKIE = 'freight_user';

/**
 * Resolves the acting user for this request.
 *
 * Falls back to the first manager so a fresh visitor lands somewhere sensible
 * rather than on an error page.
 */
export async function resolveCtx(): Promise<Ctx> {
  const store = await cookies();
  const id = store.get(USER_COOKIE)?.value;

  if (id) {
    const user = getUser(id);
    // A system identity is never a person a request can act as.
    if (user && user.role !== 'system_mailbox_collector') return { user };
  }

  const all = listUsers();
  if (all.length === 0) {
    throw new FreightError(
      'This workspace has no data yet. Load the demonstration dataset to get started.',
      409,
      'not_seeded',
    );
  }
  return { user: all.find((u) => u.role === 'logistics_manager') ?? all[0] };
}

/** Resolves a context without throwing when the store is empty. */
export async function tryResolveCtx(): Promise<Ctx | null> {
  try {
    return await resolveCtx();
  } catch {
    return null;
  }
}
