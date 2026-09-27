import { NextResponse } from 'next/server';
import { signIn } from '@/freight/auth';
import { sessionCookieOptions, SESSION_COOKIE } from '@/freight/session';
import { audit } from '@/freight/repo';

export const dynamic = 'force-dynamic';

/**
 * Signs a person in.
 *
 * The failure message never says whether the address exists, and a failed
 * attempt is recorded so repeated guessing locks the account.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return NextResponse.json({ ok: false, error: 'Enter your email address and password.' }, { status: 400 });
  }

  const result = await signIn(email, password, { userAgent: request.headers.get('user-agent') });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 });
  }

  audit(
    { user: result.user },
    {
      companyId: null,
      action: 'auth.signed_in',
      subject: `user:${result.user.id}`,
      summary: `${result.user.name} signed in.`,
    },
  );

  const res = NextResponse.json({
    ok: true,
    message: `Signed in as ${result.user.name}.`,
    data: { user: result.user },
  });
  res.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(request));
  return res;
}
