import { NextResponse } from 'next/server';
import { authMode, entraConfig, LOGIN_COOKIE } from '@/freight/auth/config';
import { startLogin } from '@/freight/auth/oidc';
import { signToken } from '@/freight/auth/token';

export const dynamic = 'force-dynamic';

/**
 * Starts "Sign in with Microsoft".
 *
 * The state, nonce and PKCE verifier travel in a short-lived signed cookie, so
 * the callback can prove the response belongs to a sign-in this browser began.
 */
export async function GET() {
  if (authMode() !== 'entra') {
    return NextResponse.json({ ok: false, error: 'Sign-in is not switched on (AUTH_MODE=entra).' }, { status: 404 });
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
