import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { authMode, entraConfig, LOGIN_COOKIE, SESSION_COOKIE, SESSION_HOURS } from '@/freight/auth/config';
import { finishLogin, SignInError } from '@/freight/auth/oidc';
import { signToken, verifyToken } from '@/freight/auth/token';
import { NotAllowed, personForSignIn } from '@/freight/auth/people';
import { audit } from '@/freight/repo';

export const dynamic = 'force-dynamic';

/** Where Microsoft sends the browser back to after sign-in. */
export async function GET(request: Request) {
  if (authMode() !== 'entra') return new NextResponse('Not found', { status: 404 });
  const { config } = entraConfig();
  if (!config) return failure('Sign-in is not fully configured on the server.', null);

  const url = new URL(request.url);
  const store = await cookies();
  const login = verifyToken<{ state: string; nonce: string; verifier: string }>(
    store.get(LOGIN_COOKIE)?.value,
    config.sessionSecret,
  );

  const error = url.searchParams.get('error');
  if (error) {
    return failure(
      error === 'access_denied' ? 'Sign-in was cancelled.' : `Microsoft reported a problem (${error}).`,
      config.baseUrl,
    );
  }
  const code = url.searchParams.get('code');
  if (!login || !code || url.searchParams.get('state') !== login.state) {
    return failure('This sign-in link has expired or was not started from this browser. Sign in again.', config.baseUrl);
  }

  try {
    const claims = await finishLogin(config, code, login.verifier, login.nonce);
    const person = personForSignIn(claims, config.bootstrapAdminEmail);
    audit({ user: person }, {
      companyId: null,
      action: 'person.signed_in',
      subject: `user:${person.id}`,
      summary: `${person.name} signed in with Microsoft.`,
    });

    const res = NextResponse.redirect(`${config.baseUrl}/freight`);
    res.cookies.set(SESSION_COOKIE, signToken({ uid: person.id }, config.sessionSecret, SESSION_HOURS * 3600), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      path: '/',
      maxAge: SESSION_HOURS * 3600,
    });
    res.cookies.delete({ name: LOGIN_COOKIE, path: '/api/freight/auth' });
    return res;
  } catch (err) {
    if (err instanceof SignInError || err instanceof NotAllowed) return failure(err.message, config.baseUrl);
    console.error('[freight/auth/callback]', err);
    return failure('Sign-in failed on the server. Try again.', config.baseUrl);
  }
}

/** A plain page, so a refused sign-in explains itself instead of looping. */
function failure(message: string, baseUrl: string | null) {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#1d2733}
a{color:#0b6e4f}</style></head><body><h1 style="font-size:20px">You are not signed in</h1>
<p>${escape(message)}</p><p><a href="${escape(baseUrl ?? '')}/api/freight/auth/login">Sign in with Microsoft</a></p></body></html>`;
  return new NextResponse(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
