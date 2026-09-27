/**
 * Small signed tokens for cookies: base64url(JSON) + "." + HMAC-SHA256.
 *
 * Used for the session cookie and for the short-lived login cookie that
 * carries the OpenID Connect state, nonce and PKCE verifier across the
 * redirect to Microsoft. The contents are signed, not encrypted, so nothing
 * secret about the person goes in them - only ids and expiry.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }),
  ).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

/** The payload, or null if the token is malformed, tampered with or expired. */
export function verifyToken<T extends Record<string, unknown>>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
