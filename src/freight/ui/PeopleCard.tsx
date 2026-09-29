'use client';

/**
 * People: who may sign in, with which role, for which companies.
 *
 * Managers only. Everything here is enforced again on the server; the form
 * only offers the companies the manager can reach, because those are the only
 * ones they may hand out.
 */

import React from 'react';
import { Card, CardHead, Field, Pill } from '@/components/ui';
import { useFreight } from './FreightProvider';
import type { User, UserRole } from '../types';

const ROLES: { value: UserRole; label: string }[] = [
  { value: 'logistics_manager', label: 'Logistics Operations Manager (approves email)' },
  { value: 'logistics_coordinator', label: 'Logistics Coordinator (prepares, cannot approve)' },
  { value: 'viewer', label: 'Viewer (read-only)' },
];

const roleLabel = (r: UserRole) => ROLES.find((x) => x.value === r)?.label.replace(/ \(.*\)$/, '') ?? r;

export function PeopleCard() {
  const { state } = useFreight();
  const [editing, setEditing] = React.useState<User | 'new' | null>(null);
  if (!state?.user || state.user.role !== 'logistics_manager') return null;

  const signIn = state.auth?.mode === 'entra';
  const companyName = (id: string) => state.companies.find((c) => c.id === id)?.name ?? 'another company';

  return (
    <Card>
      <CardHead
        title="People"
        hint={
          signIn
            ? 'Who can sign in with Microsoft, and what they may do. A person gets in only if their work email is listed here.'
            : 'Sign-in is off (demonstration mode), so this list feeds the "Acting as" picker. With AUTH_MODE=entra it decides who can sign in.'
        }
      />
      <div className="card-body stack">
        {state.users.map((u) => (
          <div key={u.id} className="row" style={{ gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <strong style={{ fontSize: 13.5 }}>{u.name}</strong>
                {u.disabled ? <Pill tone="neutral">Access off</Pill> : null}
                {u.id === state.user!.id ? <Pill tone="neutral">You</Pill> : null}
              </div>
              <div className="small muted">
                {u.email} · {roleLabel(u.role)} · {u.companyIds.map(companyName).join(', ')}
              </div>
            </div>
            <button className="btn sm" onClick={() => setEditing(u)}>
              Edit
            </button>
          </div>
        ))}
        {editing ? (
          <PersonForm person={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        ) : (
          <div>
            <button className="btn" onClick={() => setEditing('new')}>
              Add a person
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function PersonForm({ person, onDone }: { person: User | null; onDone: () => void }) {
  const { state, run, busy } = useFreight();
  const me = state!.user!;
  const [name, setName] = React.useState(person?.name ?? '');
  const [email, setEmail] = React.useState(person?.email ?? '');
  const [role, setRole] = React.useState<UserRole>(person?.role ?? 'logistics_coordinator');
  const [password, setPassword] = React.useState('');
  const [companyIds, setCompanyIds] = React.useState<string[]>(
    person ? person.companyIds.filter((c) => me.companyIds.includes(c)) : me.companyIds.slice(0, 1),
  );
  const self = person?.id === me.id;

  const toggle = (id: string) =>
    setCompanyIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const save = async () => {
    const payload = { name, email, role, companyIds };
    const done = person
      ? await run({ type: 'people.update', userId: person.id, ...payload })
      : await run({ type: 'people.add', ...payload });
    if (!done) return;

    // The password is a separate act with its own audit entry, so it is set
    // after the details are saved and only when one was typed.
    if (person && password.trim()) {
      const set = await run({ type: 'people.setPassword', userId: person.id, password });
      if (!set) return;
    }
    onDone();
  };

  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line, #e3e7ec)', paddingTop: 12 }}>
      <strong style={{ fontSize: 13.5 }}>{person ? `Edit ${person.name}` : 'Add a person'}</strong>
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Work email" help="The address they sign in to Microsoft with.">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Role" help={self ? 'You cannot change your own role.' : undefined}>
        <select className="input" value={role} disabled={self} onChange={(e) => setRole(e.target.value as UserRole)}>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
          Companies
        </legend>
        {state!.companies.map((c) => (
          <label key={c.id} className="row small" style={{ gap: 7 }}>
            <input
              type="checkbox"
              checked={companyIds.includes(c.id)}
              disabled={self && companyIds.includes(c.id)}
              onChange={() => toggle(c.id)}
            />
            {c.name}
          </label>
        ))}
      </fieldset>
      {person && state?.auth?.mode === 'password' ? (
        <Field
          label="Set a password"
          help={
            person.canSignIn === false
              ? 'This person has no password yet, so they cannot sign in. Set one and tell them privately.'
              : 'Leave blank to keep their current password. Setting a new one ends their open sessions.'
          }
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 10 characters, with a letter and a number"
          />
        </Field>
      ) : null}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {person ? 'Save' : 'Add'}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        {person && !self ? (
          <button
            className="btn ghost"
            disabled={busy}
            onClick={async () => {
              if (await run({ type: 'people.setDisabled', userId: person.id, disabled: !person.disabled })) onDone();
            }}
          >
            {person.disabled ? 'Restore access' : 'Switch off access'}
          </button>
        ) : null}
      </div>
    </div>
  );
}
