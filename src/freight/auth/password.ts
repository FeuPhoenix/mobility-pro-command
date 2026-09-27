/**
 * Authentication: passwords and sessions.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Until now the acting person came from an unsigned cookie holding a user id,
 * which was a demonstration control and was labelled as one. This replaces it
 * with a real sign-in. Every authorisation check already in the codebase -
 * company scoping, who may approve, who may send - is unchanged; they were
 * always enforced against `Ctx`, and `Ctx` now comes from a verified session.
 *
 * CHOICES, AND WHY
 * ----------------
 * - **scrypt**, from Node's own crypto. It is memory-hard, it is in the
 *   standard library, and it avoids adding a native dependency to a project
 *   that has deliberately avoided them.
 * - **Sessions in the database**, not a stateless token. A signed JWT cannot be
 *   revoked; a row can. Disabling someone must take effect immediately, and for
 *   an application that approves outbound email that matters more than saving a
 *   database read.
 * - **Only the hash of the session token is stored.** A leaked database backup
 *   then does not hand over live sessions.
 * - **Failed attempts are throttled** per account. Without it, a password is
 *   only as good as the attacker's patience.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { db, str } from '../db';
import { getUser, newId, now, type Ctx } from '../repo';
import type { Id, User } from '../types';

// `promisify` drops the options overload, so the shape is restated here.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/* -------------------------------- Passwords ---------------------------------- */

const SCRYPT_KEYLEN = 64;
/** Cost parameters. N must be a power of two; 2^15 is a reasonable 2020s floor. */
const SCRYPT_PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'That password is unreasonably long.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'A password needs at least one letter and one number.';
  }
  return null;
}

/** `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Constant-time verification.
 *
 * Returns false for a malformed stored value rather than throwing, so a corrupt
 * row cannot turn into a 500 on the login page.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }

  // `Buffer.from(x, 'base64')` does not throw on rubbish - it silently drops
  // the invalid characters and can return an empty buffer. Left unchecked, a
  // corrupt row would derive a zero-length key, and `timingSafeEqual` of two
  // empty buffers is true, which would accept *any* password. So a stored
  // value that is not the right shape is refused outright.
  if (salt.length < 8 || expected.length < 32) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* --------------------------------- Sessions ---------------------------------- */

export const SESSION_COOKIE = 'freight_session';

/** How long a session lasts from sign-in, regardless of activity. */
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a session may sit unused before it stops working. */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionRecord {
  id: Id;
  userId: Id;
  expiresAt: string;
  lastSeenAt: string;
}

/** Creates a session and returns the raw token. Only the hash is stored. */
export function createSession(userId: Id, meta: { userAgent?: string | null } = {}): string {
  const token = randomBytes(32).toString('base64url');
  const at = now();
  db()
    .prepare(
      'INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      newId('sess'),
      userId,
      tokenDigest(token),
      at,
      at,
      new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
      meta.userAgent ?? null,
    );
  return token;
}

/**
 * Resolves a session token to its user, or null.
 *
 * Also enforces idle expiry and refreshes `last_seen_at`, so a session that has
 * been sitting in a closed laptop for a day stops working.
 */
export function userForToken(token: string | undefined): User | null {
  if (!token) return null;
  const row = db()
    .prepare('SELECT * FROM sessions WHERE token_hash = ?')
    .get(tokenDigest(token)) as Record<string, unknown> | undefined;
  if (!row) return null;

  const nowMs = Date.now();
  const expiresAt = Date.parse(row.expires_at as string);
  const lastSeen = Date.parse(row.last_seen_at as string);

  if (!Number.isFinite(expiresAt) || nowMs > expiresAt || nowMs - lastSeen > SESSION_IDLE_MS) {
    db().prepare('DELETE FROM sessions WHERE id = ?').run(row.id as string);
    return null;
  }

  const user = getUser(row.user_id as string);
  if (!user || isSystemRole(user.role) || user.disabled) {
    db().prepare('DELETE FROM sessions WHERE id = ?').run(row.id as string);
    return null;
  }

  // Cheap enough to do per request, and it is what makes idle expiry work.
  db().prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now(), row.id as string);
  return user;
}

export function revokeToken(token: string | undefined): void {
  if (!token) return;
  db().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenDigest(token));
}

/** Ends every session for a person. Used when a password changes. */
export function revokeAllForUser(userId: Id): void {
  db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions(): void {
  db().prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

/** A system identity is never something a request can sign in as. */
export function isSystemRole(role: string): boolean {
  return role === 'system_mailbox_collector' || role === 'system_automation';
}

/* -------------------------------- Throttling ---------------------------------- */

const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface ThrottleState {
  locked: boolean;
  retryAfterSeconds: number;
}

function attemptKey(email: string): string {
  return email.trim().toLowerCase();
}

export function throttleState(email: string): ThrottleState {
  const row = db()
    .prepare('SELECT * FROM login_attempts WHERE key = ?')
    .get(attemptKey(email)) as Record<string, unknown> | undefined;
  if (!row) return { locked: false, retryAfterSeconds: 0 };

  const lockedUntil = str(row.locked_until);
  if (!lockedUntil) return { locked: false, retryAfterSeconds: 0 };

  const remaining = Date.parse(lockedUntil) - Date.now();
  if (remaining <= 0) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: Math.ceil(remaining / 1000) };
}

/** Records a failure and locks the account once the window fills up. */
export function recordFailedAttempt(email: string): ThrottleState {
  const key = attemptKey(email);
  const nowMs = Date.now();
  const row = db().prepare('SELECT * FROM login_attempts WHERE key = ?').get(key) as
    | Record<string, unknown>
    | undefined;

  const windowStart = row ? Date.parse(row.window_start as string) : 0;
  const withinWindow = row && Number.isFinite(windowStart) && nowMs - windowStart < ATTEMPT_WINDOW_MS;
  const count = withinWindow ? Number(row!.count ?? 0) + 1 : 1;
  const lockedUntil =
    count >= MAX_ATTEMPTS ? new Date(nowMs + LOCKOUT_MS).toISOString() : null;

  db()
    .prepare(
      'INSERT INTO login_attempts (key, count, window_start, locked_until) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start, locked_until = excluded.locked_until',
    )
    .run(key, count, withinWindow ? (row!.window_start as string) : new Date(nowMs).toISOString(), lockedUntil);

  return lockedUntil
    ? { locked: true, retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000) }
    : { locked: false, retryAfterSeconds: 0 };
}

export function clearAttempts(email: string): void {
  db().prepare('DELETE FROM login_attempts WHERE key = ?').run(attemptKey(email));
}

/* ---------------------------------- Sign in ----------------------------------- */

export type SignInResult =
  | { ok: true; token: string; user: User }
  | { ok: false; error: string; retryAfterSeconds?: number };

/**
 * Verifies an email and password.
 *
 * The failure message is deliberately the same whether the address is unknown
 * or the password is wrong, so the response cannot be used to discover who has
 * an account. The work of hashing is done either way, so the timing cannot
 * either.
 */
export async function signIn(
  email: string,
  password: string,
  meta: { userAgent?: string | null } = {},
): Promise<SignInResult> {
  const throttle = throttleState(email);
  if (throttle.locked) {
    return {
      ok: false,
      error: `Too many failed attempts. Try again in ${Math.ceil(throttle.retryAfterSeconds / 60)} minutes.`,
      retryAfterSeconds: throttle.retryAfterSeconds,
    };
  }

  const row = db()
    .prepare('SELECT * FROM users WHERE lower(email) = lower(?)')
    .get(email.trim()) as Record<string, unknown> | undefined;

  const storedHash = row ? str(row.password_hash) : null;
  // Always hash, even with no such user, so the reply takes the same time.
  const matched = await verifyPassword(password, storedHash ?? DUMMY_HASH);

  if (!row || !storedHash || !matched || Number(row.disabled ?? 0) === 1 || isSystemRole(row.role as string)) {
    const state = recordFailedAttempt(email);
    return {
      ok: false,
      error: 'That email address and password do not match an account.',
      retryAfterSeconds: state.locked ? state.retryAfterSeconds : undefined,
    };
  }

  clearAttempts(email);
  const user = getUser(row.id as string)!;
  return { ok: true, token: createSession(user.id, meta), user };
}

/**
 * A valid-shaped hash nobody knows the password to.
 *
 * Used so that signing in with an unknown address still performs a full scrypt
 * comparison; otherwise the fast "no such user" path is a timing oracle.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
  Buffer.alloc(64, 7).toString('base64');

/* ------------------------------ Account handling ------------------------------ */

export async function setPassword(userId: Id, password: string): Promise<void> {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  db()
    .prepare('UPDATE users SET password_hash = ?, password_set_at = ? WHERE id = ?')
    .run(hash, now(), userId);
  // A password change ends every existing session for that person.
  revokeAllForUser(userId);
}

/** True when nobody can sign in yet, so the first-run setup should be offered. */
export function needsFirstRunSetup(): boolean {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL AND password_hash <> ''")
    .get() as { n: number };
  return Number(row?.n ?? 0) === 0;
}

export type { Ctx };
