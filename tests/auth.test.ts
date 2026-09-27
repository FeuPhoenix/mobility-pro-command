/**
 * Sign-in and people (W4).
 *
 * Microsoft is faked at the network boundary with a locally generated RSA key,
 * so the ID token checks run for real: signature, issuer, audience, tenant,
 * expiry, nonce. Nothing touches the network.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as rsaSign, type KeyObject } from 'node:crypto';
import { openMemoryDb, useDb } from '@/freight/db';
import { getUser, insertUser, listCompanies, newId, type Ctx } from '@/freight/repo';
import { createCompany } from '@/freight/service/providers';
import { signToken, verifyToken } from '@/freight/auth/token';
import { clearSigningKeys, finishLogin, startLogin, verifyIdToken, SignInError, type IdClaims } from '@/freight/auth/oidc';
import { addPerson, NotAllowed, personForSignIn, setPersonDisabled, updatePerson } from '@/freight/auth/people';
import { ctxFromSession } from '@/freight/session';
import type { EntraConfig } from '@/freight/auth/config';
import type { User } from '@/freight/types';

const SECRET = 'x'.repeat(40);
const TENANT = '11111111-2222-3333-4444-555555555555';
const CFG: EntraConfig = {
  tenantId: TENANT,
  clientId: 'client-abc',
  clientSecret: 'shh',
  baseUrl: 'https://freight.mp-real.com',
  sessionSecret: SECRET,
  bootstrapAdminEmail: 'admin@mp-real.com',
};

/* ------------------------------ Fake Microsoft ------------------------------- */

function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } };
}
const primary = keyPair('key-1');

function idToken(claims: Record<string, unknown>, key: { kid: string; privateKey: KeyObject } = primary) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      aud: CFG.clientId,
      tid: TENANT,
      oid: 'oid-ann',
      preferred_username: 'Ann@MP-Real.com',
      name: 'Ann Manager',
      nonce: 'nonce-1',
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...claims,
    }),
  ).toString('base64url');
  const sig = rsaSign('RSA-SHA256', Buffer.from(`${header}.${body}`), key.privateKey).toString('base64url');
  return `${header}.${body}.${sig}`;
}

function fakeMicrosoft(opts: { keys?: object[]; token?: string; tokenStatus?: number } = {}) {
  const calls: string[] = [];
  const http = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: opts.keys ?? [primary.jwk] });
    if (url.endsWith('/oauth2/v2.0/token')) {
      return opts.tokenStatus
        ? Response.json({ error: 'invalid_grant' }, { status: opts.tokenStatus })
        : Response.json({ id_token: opts.token ?? idToken({}) });
    }
    return new Response('no route', { status: 404 });
  }) as typeof fetch;
  return { http, calls };
}

/* --------------------------------- Harness ---------------------------------- */

let companyA: string;
let companyB: string;
let manager: Ctx;

function person(name: string, role: User['role'], companyIds: string[], extra: Partial<User> = {}): Ctx {
  const u: User = { id: newId('usr'), name, title: role, email: `${name.split(' ')[0].toLowerCase()}@mp-real.com`, role, companyIds, ...extra };
  insertUser(u);
  return { user: u };
}

beforeEach(() => {
  useDb(openMemoryDb());
  clearSigningKeys();
  const boot: Ctx = { user: { id: 'boot', name: 'Boot', title: 'b', email: 'boot@x.test', role: 'logistics_manager', companyIds: [] } };
  companyA = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['1'] }).id;
  companyB = createCompany(boot, { code: 'BBB', name: 'Company B', country: 'Egypt', addressLines: ['1'] }).id;
  manager = person('Ann Manager', 'logistics_manager', [companyA]);
});

/* ---------------------------------- Tokens ----------------------------------- */

describe('signed cookies', () => {
  it('round-trips, and rejects tampering, the wrong secret and expiry', () => {
    const t = signToken({ uid: 'u1' }, SECRET, 60);
    expect(verifyToken(t, SECRET)?.uid).toBe('u1');

    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'someone-else', exp: 9_999_999_999 })).toString('base64url');
    expect(verifyToken(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(verifyToken(`${body}.${sig}x`, SECRET)).toBeNull();
    expect(verifyToken(t, 'y'.repeat(40))).toBeNull();
    expect(verifyToken(signToken({ uid: 'u1' }, SECRET, -1), SECRET)).toBeNull();
    expect(verifyToken(undefined, SECRET)).toBeNull();
  });
});

/* --------------------------------- Sign-in ----------------------------------- */

describe('Sign in with Microsoft', () => {
  it('starts with PKCE, a state and a nonce, and returns to this application', () => {
    const start = startLogin(CFG);
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).not.toBe(start.verifier);
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(url.searchParams.get('nonce')).toBe(start.nonce);
    expect(url.searchParams.get('redirect_uri')).toBe('https://freight.mp-real.com/api/freight/auth/callback');
  });

  it('accepts a genuine ID token and reads the person from it', async () => {
    const claims = await verifyIdToken(CFG, idToken({}), 'nonce-1', fakeMicrosoft().http);
    expect(claims).toEqual({ oid: 'oid-ann', tid: TENANT, email: 'ann@mp-real.com', name: 'Ann Manager' });
  });

  it.each([
    ['another directory', { iss: 'https://login.microsoftonline.com/other/v2.0' }, /different directory/],
    ['another application', { aud: 'someone-else' }, /different application/],
    ['another organisation', { tid: 'other-tenant' }, /different organisation/],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 3600 }, /expired/],
    ['a replayed nonce', { nonce: 'old-nonce' }, /could not be matched/],
    ['no account id', { oid: undefined }, /no account id/],
  ])('refuses %s', async (_label, claims, message) => {
    await expect(verifyIdToken(CFG, idToken(claims), 'nonce-1', fakeMicrosoft().http)).rejects.toThrow(message);
  });

  it('refuses a token signed with a key Microsoft does not publish', async () => {
    const stranger = keyPair('key-1'); // same kid, different key
    await expect(verifyIdToken(CFG, idToken({}, stranger), 'nonce-1', fakeMicrosoft().http)).rejects.toThrow(/signature is not valid/);
    const unknown = keyPair('key-9');
    await expect(verifyIdToken(CFG, idToken({}, unknown), 'nonce-1', fakeMicrosoft().http)).rejects.toThrow(/does not publish/);
  });

  it('picks up a newly rotated signing key without a restart', async () => {
    const rotated = keyPair('key-2');
    await verifyIdToken(CFG, idToken({}), 'nonce-1', fakeMicrosoft().http); // caches key-1 only
    const claims = await verifyIdToken(CFG, idToken({}, rotated), 'nonce-1', fakeMicrosoft({ keys: [primary.jwk, rotated.jwk] }).http);
    expect(claims.oid).toBe('oid-ann');
  });

  it('exchanges the code with the verifier and verifies what comes back', async () => {
    const { http, calls } = fakeMicrosoft();
    const claims = await finishLogin(CFG, 'the-code', 'the-verifier', 'nonce-1', http);
    expect(claims.email).toBe('ann@mp-real.com');
    expect(calls[0]).toMatch(/oauth2\/v2\.0\/token$/);

    await expect(finishLogin(CFG, 'bad', 'v', 'nonce-1', fakeMicrosoft({ tokenStatus: 400 }).http)).rejects.toBeInstanceOf(SignInError);
  });
});

/* ------------------------------ Who gets in ---------------------------------- */

const claims = (over: Partial<IdClaims> = {}): IdClaims => ({ oid: 'oid-ann', tid: TENANT, email: 'ann@mp-real.com', name: 'Ann', ...over });

describe('who may sign in', () => {
  it('lets in a listed person and binds their Microsoft account on first sign-in', () => {
    expect(personForSignIn(claims(), null).id).toBe(manager.user.id);
    expect(getUser(manager.user.id)?.externalId).toBe('oid-ann');
  });

  it('refuses a different account that has taken the same email address', () => {
    personForSignIn(claims(), null);
    expect(() => personForSignIn(claims({ oid: 'oid-impostor' }), null)).toThrow(/different Microsoft account/);
  });

  it('refuses someone not on the People list', () => {
    expect(() => personForSignIn(claims({ email: 'stranger@mp-real.com', oid: 'x' }), null)).toThrow(NotAllowed);
  });

  it('refuses a person whose access has been switched off', () => {
    const off = person('Carl Coord', 'logistics_coordinator', [companyA], { disabled: true });
    expect(() => personForSignIn(claims({ email: off.user.email, oid: 'oid-carl' }), null)).toThrow(/switched off/);
  });

  it('lets the bootstrap administrator in only while no manager exists', () => {
    const admin = claims({ email: 'admin@mp-real.com', oid: 'oid-admin', name: 'First Admin' });
    // A manager exists (Ann), so the bootstrap address gets nothing.
    expect(() => personForSignIn(admin, 'admin@mp-real.com')).toThrow(NotAllowed);

    setPersonDisabled(manager, person('Other Manager', 'logistics_manager', [companyA]).user.id, true);
    useDb(openMemoryDb()); // a fresh, empty workspace
    const created = personForSignIn(admin, 'admin@mp-real.com');
    expect(created).toMatchObject({ role: 'logistics_manager', email: 'admin@mp-real.com', externalId: 'oid-admin' });
  });
});

describe('sessions', () => {
  it('resolve to the person, and stop working when their access is switched off', () => {
    const coord = person('Carl Coord', 'logistics_coordinator', [companyA]);
    const cookie = signToken({ uid: coord.user.id }, SECRET, 3600);
    expect(ctxFromSession(cookie, SECRET)?.user.id).toBe(coord.user.id);

    setPersonDisabled(manager, coord.user.id, true);
    expect(ctxFromSession(cookie, SECRET)).toBeNull();
  });

  it('never resolve to the Mailbox Collector or an unknown id', () => {
    expect(ctxFromSession(signToken({ uid: 'system_mailbox_collector' }, SECRET, 3600), SECRET)).toBeNull();
    expect(ctxFromSession(signToken({ uid: 'usr_nobody' }, SECRET, 3600), SECRET)).toBeNull();
  });
});

/* ------------------------------ Managing people ------------------------------ */

describe('the People screen rules', () => {
  it('lets a manager add someone to a company they manage', () => {
    const p = addPerson(manager, { name: 'Carl Coord', email: 'Carl@MP-Real.com', role: 'logistics_coordinator', companyIds: [companyA] });
    expect(p).toMatchObject({ email: 'carl@mp-real.com', role: 'logistics_coordinator', companyIds: [companyA] });
  });

  it('only lets a manager hand out access they hold themselves', () => {
    expect(() => addPerson(manager, { name: 'X', email: 'x@mp-real.com', role: 'viewer', companyIds: [companyB] })).toThrow(/do not have access/);
  });

  it('refuses a coordinator, a duplicate address and an unassignable role', () => {
    const coord = person('Carl Coord', 'logistics_coordinator', [companyA]);
    expect(() => addPerson(coord, { name: 'X', email: 'x@mp-real.com', role: 'viewer', companyIds: [companyA] })).toThrow(/Only a Logistics Operations Manager/);
    expect(() => addPerson(manager, { name: 'Dup', email: 'ANN@mp-real.com', role: 'viewer', companyIds: [companyA] })).toThrow(/already in this workspace/);
    expect(() =>
      addPerson(manager, { name: 'Bot', email: 'bot@mp-real.com', role: 'system_mailbox_collector', companyIds: [companyA] }),
    ).toThrow(/cannot be assigned/);
  });

  it('keeps access to companies the editing manager cannot see', () => {
    const both = person('Bea Both', 'logistics_coordinator', [companyA, companyB]);
    const updated = updatePerson(manager, both.user.id, { name: 'Bea Both', email: both.user.email, role: 'viewer', companyIds: [companyA] });
    expect(updated.companyIds.sort()).toEqual([companyA, companyB].sort());
    expect(updated.role).toBe('viewer');
  });

  it('stops a manager locking themselves out', () => {
    expect(() => updatePerson(manager, manager.user.id, { name: 'Ann', email: manager.user.email, role: 'viewer', companyIds: [companyA] })).toThrow(/own role/);
    expect(() => setPersonDisabled(manager, manager.user.id, true)).toThrow(/your own access/);
  });

  it('unbinds the Microsoft account when the email address changes', () => {
    personForSignIn(claims(), null);
    const coord = person('Carl Coord', 'logistics_coordinator', [companyA], { externalId: 'oid-carl' });
    const moved = updatePerson(manager, coord.user.id, { name: 'Carl', email: 'carl.new@mp-real.com', role: 'logistics_coordinator', companyIds: [companyA] });
    expect(moved.externalId).toBeNull();
  });
});

describe('creating a company', () => {
  it('gives the creator lasting access, not just for this request', () => {
    const c = createCompany(manager, { code: 'CCC', name: 'Company C', country: 'Egypt', addressLines: ['1'] });
    const reloaded: Ctx = { user: getUser(manager.user.id)! };
    expect(listCompanies(reloaded).map((x) => x.id)).toContain(c.id);
  });
});
