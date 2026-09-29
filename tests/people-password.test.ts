/**
 * Giving a colleague a password.
 *
 * Without this, password mode was a one-person product: `addPerson` leaves the
 * hash null, only first-run setup ever set one, and the People screen happily
 * added accounts that could never sign in - while telling the manager they
 * could.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb } from '@/freight/db';
import { insertUser, listAudit, newId, type Ctx } from '@/freight/repo';
import { createCompany } from '@/freight/service/providers';
import { addPerson, setPersonPassword } from '@/freight/auth/people';
import { createSession, signIn, userForToken } from '@/freight/auth/password';
import type { User } from '@/freight/types';

let manager: Ctx;
let companyId: string;

beforeEach(() => {
  useDb(openMemoryDb());
  const boot: Ctx = {
    user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@test.test', role: 'logistics_manager', companyIds: [] },
  };
  companyId = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['L1'] }).id;

  const u: User = {
    id: newId('usr'), name: 'Hala Mansour', title: 'Logistics Operations Manager',
    email: 'hala@test.test', role: 'logistics_manager', companyIds: [companyId],
  };
  insertUser(u);
  manager = { user: u };
});

const addCoordinator = () =>
  addPerson(manager, {
    name: 'Omar Said',
    email: 'omar@test.test',
    title: 'Logistics Coordinator',
    role: 'logistics_coordinator',
    companyIds: [companyId],
  });

describe('a person added by a manager', () => {
  it('cannot sign in until they are given a password', async () => {
    const person = addCoordinator();
    expect((await signIn('omar@test.test', 'anything at all')).ok).toBe(false);
    expect(person.canSignIn).not.toBe(true);
  });

  it('can sign in once the manager sets one', async () => {
    const person = addCoordinator();
    await setPersonPassword(manager, person.id, 'CoordPass2026');

    const signedIn = await signIn('omar@test.test', 'CoordPass2026');
    expect(signedIn.ok, JSON.stringify(signedIn)).toBe(true);
    expect(signedIn.ok && signedIn.user.id).toBe(person.id);
  });

  it('still cannot sign in with the wrong password', async () => {
    const person = addCoordinator();
    await setPersonPassword(manager, person.id, 'CoordPass2026');

    expect((await signIn('omar@test.test', 'CoordPass2027')).ok).toBe(false);
  });
});

describe('what setting a password must not do', () => {
  it('refuses a password too weak to be worth setting', async () => {
    const person = addCoordinator();
    await expect(setPersonPassword(manager, person.id, 'short')).rejects.toThrow();
    expect((await signIn('omar@test.test', 'short')).ok).toBe(false);
  });

  it('ends the sessions that person already had', async () => {
    const person = addCoordinator();
    await setPersonPassword(manager, person.id, 'CoordPass2026');
    const token = createSession(person.id);
    expect(userForToken(token)?.id).toBe(person.id);

    await setPersonPassword(manager, person.id, 'DifferentPass2026');

    // A password change that leaves the old session working is not one.
    expect(userForToken(token)).toBeNull();
  });

  it('is refused to anyone who is not a manager', async () => {
    const person = addCoordinator();
    const coordinator: Ctx = { user: { ...person, role: 'logistics_coordinator' } as User };

    await expect(setPersonPassword(coordinator, person.id, 'CoordPass2026')).rejects.toThrow();
  });

  it('records that it happened, without recording the password', async () => {
    const person = addCoordinator();
    await setPersonPassword(manager, person.id, 'CoordPass2026');

    const entry = listAudit(manager, { subject: `user:${person.id}` }).find(
      (e) => e.action === 'person.password_set',
    );
    expect(entry?.summary).toContain('Hala Mansour');
    expect(entry?.summary).toContain('Omar Said');
    expect(JSON.stringify(entry)).not.toContain('CoordPass2026');
  });
});
