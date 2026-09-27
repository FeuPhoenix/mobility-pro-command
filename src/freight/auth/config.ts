/**
 * How people are identified.
 *
 *   AUTH_MODE=demo  (default) The "Acting as" picker. A demonstration control,
 *                   labelled as one. Anyone who can reach the server can act as
 *                   anyone. Never use it with real data on a reachable server.
 *   AUTH_MODE=password  Email and password held here, hashed with scrypt, with
 *                   revocable sessions. For a deployment that cannot use Entra,
 *                   or is not willing to wait for the tenant work.
 *   AUTH_MODE=entra Sign in with Microsoft (Entra ID, OpenID Connect with
 *                   PKCE). Only people added on the People screen get in.
 *
 * Entra mode fails closed: if its configuration is incomplete, every freight
 * request is refused with the reason, rather than quietly falling back to the
 * demo picker.
 */

export type AuthMode = 'demo' | 'password' | 'entra';

export function authMode(): AuthMode {
  if (process.env.AUTH_MODE === 'entra') return 'entra';
  if (process.env.AUTH_MODE === 'password') return 'password';
  return 'demo';
}

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The public address of this application, e.g. https://freight.example.com */
  baseUrl: string;
  /** Signs session cookies. At least 32 characters. */
  sessionSecret: string;
  /** Signs in as a manager with every company when nobody else can yet. */
  bootstrapAdminEmail: string | null;
}

export function entraConfig(): { config: EntraConfig | null; problems: string[] } {
  const env = {
    tenantId: process.env.AUTH_ENTRA_TENANT_ID,
    clientId: process.env.AUTH_ENTRA_CLIENT_ID,
    clientSecret: process.env.AUTH_ENTRA_CLIENT_SECRET,
    baseUrl: process.env.AUTH_BASE_URL,
    sessionSecret: process.env.AUTH_SESSION_SECRET,
  };
  const problems: string[] = [];
  if (!env.tenantId) problems.push('Set AUTH_ENTRA_TENANT_ID.');
  if (!env.clientId) problems.push('Set AUTH_ENTRA_CLIENT_ID.');
  if (!env.clientSecret) problems.push('Set AUTH_ENTRA_CLIENT_SECRET.');
  if (!env.baseUrl) problems.push('Set AUTH_BASE_URL to the address people open, e.g. https://freight.example.com.');
  else if (!/^https?:\/\//.test(env.baseUrl)) problems.push('AUTH_BASE_URL must start with https:// (or http:// for local testing).');
  if (!env.sessionSecret || env.sessionSecret.length < 32) {
    problems.push('Set AUTH_SESSION_SECRET to a random string of at least 32 characters.');
  }
  if (problems.length > 0) return { config: null, problems };
  return {
    config: {
      tenantId: env.tenantId!,
      clientId: env.clientId!,
      clientSecret: env.clientSecret!,
      baseUrl: env.baseUrl!.replace(/\/+$/, ''),
      sessionSecret: env.sessionSecret!,
      bootstrapAdminEmail: process.env.AUTH_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || null,
    },
    problems: [],
  };
}

export const SESSION_COOKIE = 'freight_session';
export const LOGIN_COOKIE = 'freight_login';
/** A working day plus margin. Signing in again is one click. */
export const SESSION_HOURS = 10;
