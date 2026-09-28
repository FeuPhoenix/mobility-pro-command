import { NextResponse } from 'next/server';
import { authMode, entraConfig, LOGIN_COOKIE, SESSION_COOKIE } from '@/freight/auth/config';
import { startLogin } from '@/freight/auth/oidc';
import { signToken } from '@/freight/auth/token';
import { signIn } from '@/freight/auth/password';
import { sessionCookieOptions } from '@/freight/session';
import { audit } from '@/freight/repo';

export const dynamic = 'force-dynamic';

/**
 * Starts "Sign in with Microsoft".
 *
 * The state, nonce and PKCE verifier travel in a short-lived signed cookie, so
 * the callback can prove the response belongs to a sign-in this browser began.
 */
export async function GET() {
  if (authMode() !== 'entra') {
    return NextResponse.json(
      { ok: false, error: 'Sign in with Microsoft is not switched on (AUTH_MODE=entra).' },
      { status: 404 },
    );
  }
  const { config, problems } = entraConfig();
  if (!config) {
    return NextResponse.json({ ok: false, error: `Sign-in is not fully configured: ${problems.join(' ')}` }, { status: 503 });
  }

  const login = startLogin(config);
  const res = NextResponse.redirect(login.url);
  res.cookies.set(
    LOGIN_COOKIE,
    signToken({ state: login.state, nonce: login.nonce, verifier: login.verifier }, config.sessionSecret, 600),
    {
      httpOnly: true,
      sameSite: 'lax', // must survive the top-level redirect back from Microsoft
      secure: config.baseUrl.startsWith('https://'),
      path: '/api/freight/auth',
      maxAge: 600,
    },
  );
  return res;
}

/**
 * Signs in with an email and password, for AUTH_MODE=password.
 *
 * The failure message never says whether the address exists, and a failed
 * attempt is recorded so repeated guessing locks the account.
 */
export async function POST(request: Request) {
  if (authMode() !== 'password') {
    return NextResponse.json(
      { ok: false, error: 'Password sign-in is not switched on (AUTH_MODE=password).' },
      { status: 404 },
    );
  }

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
