import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { revokeToken } from '@/freight/auth';
import { sessionCookieOptions, SESSION_COOKIE, tryResolveCtx } from '@/freight/session';
import { audit } from '@/freight/repo';

export const dynamic = 'force-dynamic';

/** Signs out, deleting the session row so the token is dead everywhere. */
export async function POST(request: Request) {
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
  res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(request), maxAge: 0 });
  return res;
}
