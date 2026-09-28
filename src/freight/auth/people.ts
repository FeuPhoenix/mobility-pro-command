/**
 * Who may sign in, and managing that list.
 *
 * A Microsoft account gets in only if its email matches a person on the People
 * screen who is not disabled. At first sign-in the account's immutable id is
 * bound to the person; after that it must match, so renaming a different
 * account to the same address gets nowhere.
 *
 * Only a Logistics Operations Manager manages people, and only within the
 * companies they can reach themselves. Nobody can disable, demote or remove
 * company access from themselves, so a workspace cannot lock out its last
 * manager by accident.
 */

import type { Id, User, UserRole } from '../types';
import { isSystemRole } from '../types';
import {
  assertCompanyAccess,
  audit,
  findUserByEmail,
  forbidden,
  getUser,
  insertUser,
  listAllCompanyIds,
  listUsers,
  newId,
  updateUser,
  FreightError,
  type Ctx,
} from '../repo';
import type { IdClaims } from './oidc';

export const ASSIGNABLE_ROLES: UserRole[] = ['logistics_manager', 'logistics_coordinator', 'viewer'];

export const ROLE_LABEL: Record<UserRole, string> = {
  logistics_manager: 'Logistics Operations Manager',
  logistics_coordinator: 'Logistics Coordinator',
  viewer: 'Viewer (read-only)',
  system_mailbox_collector: 'System',
  system_deadline: 'System',
};

/* --------------------------------- Sign-in ----------------------------------- */

export class NotAllowed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAllowed';
  }
}

/**
 * The person a verified Microsoft sign-in belongs to.
 *
 * `bootstrapAdminEmail` lets the very first administrator in: if that address
 * signs in and no manager exists yet, they are added as a manager with every
 * company. Once any manager exists it does nothing.
 */
export function personForSignIn(claims: IdClaims, bootstrapAdminEmail: string | null): User {
  const person = findUserByEmail(claims.email);

  if (!person) {
    const hasManager = listUsers().some((u) => u.role === 'logistics_manager' && !u.disabled);
    if (bootstrapAdminEmail && claims.email === bootstrapAdminEmail && !hasManager) {
      const admin: User = {
        id: newId('usr'),
        name: claims.name ?? claims.email,
        title: ROLE_LABEL.logistics_manager,
        email: claims.email,
        role: 'logistics_manager',
        companyIds: listAllCompanyIds(),
        externalId: claims.oid,
      };
      insertUser(admin);
      audit({ user: admin }, {
        companyId: null,
        action: 'person.bootstrapped',
        subject: `user:${admin.id}`,
        summary: `${admin.email} signed in as the first administrator (AUTH_BOOTSTRAP_ADMIN_EMAIL).`,
      });
      return admin;
    }
    throw new NotAllowed(
      `${claims.email} has not been added to this workspace. Ask a Logistics Operations Manager to add you on the People screen.`,
    );
  }

  if (person.disabled) {
    throw new NotAllowed(`Access for ${claims.email} has been switched off. Ask a Logistics Operations Manager.`);
  }
  if (person.externalId && person.externalId !== claims.oid) {
    throw new NotAllowed(
      `${claims.email} is linked to a different Microsoft account. Ask a Logistics Operations Manager to check the People screen.`,
    );
  }
  if (!person.externalId) {
    const bound = { ...person, externalId: claims.oid };
    updateUser(bound);
    return bound;
  }
  return person;
}

/** The person behind a session, if they may still act. */
export function personForSession(userId: string): User | null {
  const person = getUser(userId);
  if (!person || person.disabled || isSystemRole(person.role)) return null;
  return person;
}

/* ------------------------------- Management ---------------------------------- */

function assertManager(ctx: Ctx): void {
  if (ctx.user.role !== 'logistics_manager') {
    throw forbidden('Only a Logistics Operations Manager can manage people.');
  }
}

export interface PersonInput {
  name: string;
  email: string;
  title?: string;
  role: UserRole;
  companyIds: Id[];
}

function validate(ctx: Ctx, input: PersonInput): { name: string; email: string; title: string } {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw new FreightError('A name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new FreightError('That is not a valid email address.');
  if (!ASSIGNABLE_ROLES.includes(input.role)) throw new FreightError('That role cannot be assigned.');
  if (input.companyIds.length === 0) throw new FreightError('Give the person at least one company.');
  // You can only hand out access you hold yourself.
  for (const id of input.companyIds) assertCompanyAccess(ctx, id);
  return { name, email, title: input.title?.trim() || ROLE_LABEL[input.role] };
}

/** People who share at least one company with the manager. */
export function listPeople(ctx: Ctx): User[] {
  assertManager(ctx);
  return listUsers().filter(
    (u) => u.id === ctx.user.id || u.companyIds.some((c) => ctx.user.companyIds.includes(c)),
  );
}

export function addPerson(ctx: Ctx, input: PersonInput): User {
  assertManager(ctx);
  const v = validate(ctx, input);
  if (findUserByEmail(v.email)) throw new FreightError(`${v.email} is already in this workspace.`, 409, 'duplicate');
  const person: User = {
    id: newId('usr'),
    name: v.name,
    title: v.title,
    email: v.email,
    role: input.role,
    companyIds: [...new Set(input.companyIds)],
  };
  insertUser(person);
  audit(ctx, {
    companyId: null,
    action: 'person.added',
    subject: `user:${person.id}`,
    summary: `${ctx.user.name} added ${person.name} (${person.email}) as ${ROLE_LABEL[person.role]}.`,
  });
  return person;
}

export function updatePerson(ctx: Ctx, userId: Id, input: PersonInput): User {
  assertManager(ctx);
  const existing = getUser(userId);
  if (!existing || !listPeople(ctx).some((u) => u.id === userId)) {
    throw new FreightError('That person was not found.', 404, 'not_found');
  }
  const v = validate(ctx, input);
  const clash = findUserByEmail(v.email);
  if (clash && clash.id !== userId) throw new FreightError(`${v.email} already belongs to someone else.`, 409, 'duplicate');

  // Companies this manager cannot see are kept as they were: a manager edits
  // only the part of someone's access they are responsible for.
  const outside = existing.companyIds.filter((c) => !ctx.user.companyIds.includes(c));
  const companyIds = [...new Set([...outside, ...input.companyIds])];

  if (userId === ctx.user.id) {
    if (input.role !== existing.role) throw new FreightError('You cannot change your own role. Ask another manager.');
    if (existing.companyIds.some((c) => !companyIds.includes(c))) {
      throw new FreightError('You cannot remove your own access to a company. Ask another manager.');
    }
  }

  const emailChanged = v.email !== existing.email.toLowerCase();
  const updated: User = {
    ...existing,
    name: v.name,
    title: v.title,
    email: v.email,
    role: input.role,
    companyIds,
    // A new address may be a new account: bind afresh at its first sign-in.
    externalId: emailChanged ? null : existing.externalId ?? null,
  };
  updateUser(updated);
  audit(ctx, {
    companyId: null,
    action: 'person.updated',
    subject: `user:${userId}`,
    summary: `${ctx.user.name} updated ${updated.name}: ${ROLE_LABEL[updated.role]}, ${companyIds.length} compan${companyIds.length === 1 ? 'y' : 'ies'}.`,
  });
  return updated;
}

export function setPersonDisabled(ctx: Ctx, userId: Id, disabled: boolean): User {
  assertManager(ctx);
  if (userId === ctx.user.id) throw new FreightError('You cannot switch off your own access.');
  const existing = getUser(userId);
  if (!existing || !listPeople(ctx).some((u) => u.id === userId)) {
    throw new FreightError('That person was not found.', 404, 'not_found');
  }
  const updated = { ...existing, disabled };
  updateUser(updated);
  audit(ctx, {
    companyId: null,
    action: disabled ? 'person.disabled' : 'person.enabled',
    subject: `user:${userId}`,
    summary: `${ctx.user.name} ${disabled ? 'switched off' : 'restored'} access for ${existing.name}.`,
  });
  return updated;
}
