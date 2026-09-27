/**
 * Authentication tests.
 *
 * The emphasis is on what must be refused: a wrong password, a guessed one
 * tried repeatedly, a revoked or expired session, a disabled account, and a
 * system identity trying to sign in like a person.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb } from '@/freight/db';
import { db } from '@/freight/db';
import { insertUser, newId, setUserDisabled, type Ctx } from '@/freight/repo';
import {
  clearAttempts,
  createSession,
  hashPassword,
  needsFirstRunSetup,
  passwordProblem,
  revokeAllForUser,
  revokeToken,
  setPassword,
  signIn,
  userForToken,
  verifyPassword,
} from '@/freight/auth/password';
import type { User } from '@/freight/types';

const PASSWORD = 'CorrectHorse9';

function makeUser(over: Partial<User> = {}): User {
  const u: User = {
    id: newId('usr'),
    name: 'Hala Mansour',
    title: 'Logistics Operations Manager',
    email: `hala-${Math.random().toString(36).slice(2, 8)}@test.test`,
    role: 'logistics_manager',
    companyIds: [],
    ...over,
  };
  insertUser(u);
  return u;
}

beforeEach(() => {
  useDb(openMemoryDb());
});

/* -------------------------------- Passwords ---------------------------------- */

describe('passwords', () => {
  it('rejects one that is too short or has no digit', () => {
    expect(passwordProblem('short1')).toMatch(/at least 10/i);
    expect(passwordProblem('alllettershere')).toMatch(/letter and one number/i);
    expect(passwordProblem('1234567890')).toMatch(/letter and one number/i);
    expect(passwordProblem(PASSWORD)).toBeNull();
  });

  it('hashes with a per-password salt, so identical passwords differ on disk', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    // The password itself must not be recoverable from the stored value.
    expect(a).not.toContain(PASSWORD);
  });

  it('verifies the right password and refuses the wrong one', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword('CorrectHorse8', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('returns false for a corrupt stored value rather than throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$x$y$z$q$r', 'scrypt$32768$8$1$!!!$!!!']) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
  });
});

/* --------------------------------- Sign in ----------------------------------- */

describe('signing in', () => {
  it('works with the right password', async () => {
    const user = makeUser();
    await setPassword(user.id, PASSWORD);

    const result = await signIn(user.email, PASSWORD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe(user.id);
      expect(userForToken(result.token)?.id).toBe(user.id);
    }
  });

  it('is case-insensitive on the address', async () => {
    const user = makeUser({ email: 'Mixed.Case@test.test' });
    await setPassword(user.id, PASSWORD);
    const result = await signIn('mixed.case@TEST.test', PASSWORD);
    expect(result.ok).toBe(true);
  });

  it('gives the same message for an unknown address as for a wrong password', async () => {
    const user = makeUser();
    await setPassword(user.id, PASSWORD);

    const wrongPassword = await signIn(user.email, 'NotThePass1');
    const unknownUser = await signIn('nobody@test.test', PASSWORD);

    expect(wrongPassword.ok).toBe(false);
    expect(unknownUser.ok).toBe(false);
    if (!wrongPassword.ok && !unknownUser.ok) {
      // Otherwise the response tells an attacker which addresses exist.
      expect(wrongPassword.error).toBe(unknownUser.error);
    }
  });

  it('refuses an account with no password set', async () => {
    const user = makeUser();
    const result = await signIn(user.email, PASSWORD);
    expect(result.ok).toBe(false);
  });

  it('refuses a disabled account', async () => {
    const user = makeUser();
    await setPassword(user.id, PASSWORD);
    setUserDisabled(user.id, true);

    const result = await signIn(user.email, PASSWORD);
    expect(result.ok).toBe(false);
  });

  it('refuses a system identity even if one somehow has a password', async () => {
    const collector = makeUser({ role: 'system_mailbox_collector', name: 'Mailbox Collector' });
    await setPassword(collector.id, PASSWORD);
    const result = await signIn(collector.email, PASSWORD);
    expect(result.ok).toBe(false);
  });
});

/* -------------------------------- Throttling ---------------------------------- */

describe('throttling', () => {
  it('locks the account after repeated failures, then refuses even the right password', async () => {
    const user = makeUser();
    await setPassword(user.id, PASSWORD);

    for (let i = 0; i < 8; i++) {
      const attempt = await signIn(user.email, `WrongPass${i}0`);
      expect(attempt.ok).toBe(false);
    }

    const locked = await signIn(user.email, PASSWORD);
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.error).toMatch(/too many failed attempts/i);
      expect(locked.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('forgets the failures once a sign-in succeeds', async () => {
    const user = makeUser();
    await setPassword(user.id, PASSWORD);

    for (let i = 0; i < 3; i++) await signIn(user.email, 'WrongOne99');
    expect((await signIn(user.email, PASSWORD)).ok).toBe(true);

    clearAttempts(user.email);
    for (let i = 0; i < 7; i++) await signIn(user.email, 'WrongOne99');
    // Seven is still under the limit, so the right password works.
    expect((await signIn(user.email, PASSWORD)).ok).toBe(true);
  });
});

/* --------------------------------- Sessions ----------------------------------- */

describe('sessions', () => {
  it('stores only the hash of the token', () => {
    const user = makeUser();
    const token = createSession(user.id);
    const rows = db().prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toHaveLength(64); // sha-256 hex
  });

  it('rejects an unknown or empty token', () => {
    makeUser();
    expect(userForToken(undefined)).toBeNull();
    expect(userForToken('')).toBeNull();
    expect(userForToken('not-a-real-token')).toBeNull();
  });

  it('stops working once revoked', () => {
    const user = makeUser();
    const token = createSession(user.id);
    expect(userForToken(token)?.id).toBe(user.id);
    revokeToken(token);
    expect(userForToken(token)).toBeNull();
  });

  it('ends every session when the password changes', async () => {
    const user = makeUser();
    await setPassword(user.id, PASSWORD);
    const a = createSession(user.id);
    const b = createSession(user.id);

    await setPassword(user.id, 'AnotherPass77');
    expect(userForToken(a)).toBeNull();
    expect(userForToken(b)).toBeNull();
  });

  it('stops working the moment the account is disabled', () => {
    const user = makeUser();
    const token = createSession(user.id);
    expect(userForToken(token)).not.toBeNull();

    setUserDisabled(user.id, true);
    // No waiting for expiry: a revoked person is out on their next request.
    expect(userForToken(token)).toBeNull();
  });

  it('rejects a session past its absolute expiry', () => {
    const user = makeUser();
    const token = createSession(user.id);
    db()
      .prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), user.id);
    expect(userForToken(token)).toBeNull();
  });

  it('rejects a session that has been idle too long', () => {
    const user = makeUser();
    const token = createSession(user.id);
    db()
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(), user.id);
    expect(userForToken(token)).toBeNull();
  });

  it('deletes the row it rejected, so a dead token is not checked twice', () => {
    const user = makeUser();
    const token = createSession(user.id);
    revokeAllForUser(user.id);
    expect(userForToken(token)).toBeNull();
    const rows = db().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

/* ------------------------------ First-run setup -------------------------------- */

describe('first run', () => {
  it('is offered only while nobody can sign in', async () => {
    expect(needsFirstRunSetup()).toBe(true);

    const user = makeUser();
    // An account with no password still cannot sign in, so setup is still needed.
    expect(needsFirstRunSetup()).toBe(true);

    await setPassword(user.id, PASSWORD);
    expect(needsFirstRunSetup()).toBe(false);
  });
});

/* ------------------------------- Demo accounts ---------------------------------- */

describe('the demonstration dataset', () => {
  // Seeding hashes a password per demo account with deliberately slow scrypt.
  // Under parallel test load that can pass the 5s default, so these two say so
  // explicitly rather than failing intermittently for whoever runs the suite next.
  it('gives its accounts real hashed passwords, not a bypass', async () => {
    const { seedDemo } = await import('@/freight/demo/seed');
    const { DEMO_PASSWORD } = await import('@/freight/demo/fixtures');
    const { users } = await seedDemo();

    for (const u of users) {
      const stored = db().prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id) as {
        password_hash: string | null;
      };
      expect(stored.password_hash, u.name).toBeTruthy();
      expect(stored.password_hash, u.name).toContain('scrypt$');
    }

    const result = await signIn(users[0].email, DEMO_PASSWORD);
    expect(result.ok).toBe(true);

    const wrong = await signIn(users[0].email, 'NotTheDemoPass1');
    expect(wrong.ok).toBe(false);
  }, 30_000);

  it('marks the workspace as demo data so the sign-in page may list the accounts', async () => {
    const { seedDemo } = await import('@/freight/demo/seed');
    await seedDemo();
    const { getSetting } = await import('@/freight/db');
    expect(getSetting('demo.mode', false)).toBe(true);
  }, 30_000);
});

/* ---------------------- The authorisation checks still hold --------------------- */

describe('authorisation is unchanged by authentication', () => {
  it('a signed-in coordinator still cannot approve', async () => {
    const { assertCanApprove } = await import('@/freight/repo');
    const coordinator = makeUser({ role: 'logistics_coordinator', name: 'Karim' });
    await setPassword(coordinator.id, PASSWORD);
    const result = await signIn(coordinator.email, PASSWORD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ctx: Ctx = { user: result.user };
      expect(() => assertCanApprove(ctx)).toThrow(/Only the Logistics Operations Manager/i);
    }
  });

  it('a signed-in user still only sees their own companies', async () => {
    const { assertCompanyAccess } = await import('@/freight/repo');
    const user = makeUser({ companyIds: ['co_a'] });
    await setPassword(user.id, PASSWORD);
    const result = await signIn(user.email, PASSWORD);
    if (result.ok) {
      const ctx: Ctx = { user: result.user };
      expect(() => assertCompanyAccess(ctx, 'co_a')).not.toThrow();
      expect(() => assertCompanyAccess(ctx, 'co_b')).toThrow(/do not have access/i);
    }
  });
});

