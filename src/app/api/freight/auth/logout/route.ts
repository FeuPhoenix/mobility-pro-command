import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/freight/auth/config';
import { revokeToken } from '@/freight/auth/password';
import { tryResolveCtx } from '@/freight/session';
import { audit } from '@/freight/repo';

export const dynamic = 'force-dynamic';

/**
 * Signs out of this application. It does not sign the person out of Microsoft.
 *
 * In password mode the session is a row, so it is deleted rather than merely
 * forgotten by the browser — clearing the cookie alone would leave a token that
 * still worked if it had been copied.
 */
export async function POST() {
  const ctx = await tryResolveCtx();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (ctx) {
    audit(ctx, {
      companyId: null,
      action: 'auth.signed_out',
      subject: `user:${ctx.user.id}`,
      summary: `${ctx.user.name} signed out.`,
    });
  }
  revokeToken(token);

  const res = NextResponse.json({ ok: true, message: 'Signed out.' });
  res.cookies.delete({ name: SESSION_COOKIE, path: '/' });
  return res;
}
