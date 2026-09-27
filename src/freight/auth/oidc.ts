/**
 * Sign in with Microsoft: OpenID Connect authorisation code flow with PKCE,
 * against a single Entra tenant.
 *
 * The ID token is verified here, in full, rather than trusted because it came
 * back from the token endpoint: RS256 signature against Microsoft's published
 * keys, issuer, audience, tenant, expiry and the nonce this server issued.
 */

import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import type { EntraConfig } from './config';

const LOGIN = 'https://login.microsoftonline.com';

export interface LoginStart {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

export interface IdClaims {
  /** Immutable object id of the person in the tenant. */
  oid: string;
  tid: string;
  email: string;
  name: string | null;
}

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

export function redirectUri(cfg: EntraConfig): string {
  return `${cfg.baseUrl}/api/freight/auth/callback`;
}

export function startLogin(cfg: EntraConfig): LoginStart {
  const state = randomBytes(16).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(cfg),
    response_mode: 'query',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `${LOGIN}/${cfg.tenantId}/oauth2/v2.0/authorize?${params}`, state, nonce, verifier };
}

/** Exchanges the code for tokens and returns the verified ID token claims. */
export async function finishLogin(
  cfg: EntraConfig,
  code: string,
  verifier: string,
  nonce: string,
  http: typeof fetch = fetch,
): Promise<IdClaims> {
  const res = await http(`${LOGIN}/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(cfg),
      code_verifier: verifier,
      scope: 'openid profile email',
    }),
  });
  if (!res.ok) {
    // Only the error code: the description can echo request details.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new SignInError(`Microsoft did not complete the sign-in (${res.status}${body.error ? ` ${body.error}` : ''}). Try again.`);
  }
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new SignInError('Microsoft returned no ID token. Try again.');
  return verifyIdToken(cfg, tokens.id_token, nonce, http);
}

/* ------------------------------ Token checks -------------------------------- */

let jwksCache: { tenant: string; keys: (JsonWebKey & { kid?: string })[]; at: number } | null = null;

async function signingKeys(tenantId: string, http: typeof fetch, refresh = false) {
  if (!refresh && jwksCache && jwksCache.tenant === tenantId && Date.now() - jwksCache.at < 3_600_000) {
    return jwksCache.keys;
  }
  const res = await http(`${LOGIN}/${tenantId}/discovery/v2.0/keys`);
  if (!res.ok) throw new SignInError(`Could not read Microsoft's signing keys (${res.status}). Try again.`);
  const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  jwksCache = { tenant: tenantId, keys, at: Date.now() };
  return keys;
}

/** Tests only: forget cached signing keys. */
export function clearSigningKeys(): void {
  jwksCache = null;
}

export async function verifyIdToken(
  cfg: EntraConfig,
  idToken: string,
  nonce: string,
  http: typeof fetch = fetch,
): Promise<IdClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new SignInError('The sign-in token was malformed.');
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    throw new SignInError('The sign-in token was malformed.');
  }
  if (header.alg !== 'RS256' || !header.kid) throw new SignInError('The sign-in token is not signed the way Microsoft signs them.');

  // Keys rotate; one refresh covers a key published since the cache was filled.
  let jwk = (await signingKeys(cfg.tenantId, http)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(cfg.tenantId, http, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new SignInError('The sign-in token was signed with a key Microsoft does not publish.');

  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const valid = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!valid) throw new SignInError('The sign-in token signature is not valid.');

  const now = Math.floor(Date.now() / 1000);
  const skew = 300;
  if (claims.iss !== `${LOGIN}/${cfg.tenantId}/v2.0`) throw new SignInError('The sign-in token was issued for a different directory.');
  if (claims.aud !== cfg.clientId) throw new SignInError('The sign-in token was issued for a different application.');
  if (claims.tid !== cfg.tenantId) throw new SignInError('The sign-in token belongs to a different organisation.');
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw new SignInError('The sign-in token has expired. Sign in again.');
  if (typeof claims.nbf === 'number' && claims.nbf - skew > now) throw new SignInError('The sign-in token is not valid yet. Check the server clock.');
  if (claims.nonce !== nonce) throw new SignInError('The sign-in could not be matched to this browser. Sign in again.');

  const email = String(claims.email ?? claims.preferred_username ?? '').trim().toLowerCase();
  if (typeof claims.oid !== 'string' || !claims.oid) throw new SignInError('The sign-in token carries no account id.');
  if (!email.includes('@')) throw new SignInError('Your Microsoft account has no email address this workspace can use.');

  return { oid: claims.oid, tid: claims.tid as string, email, name: typeof claims.name === 'string' ? claims.name : null };
}
