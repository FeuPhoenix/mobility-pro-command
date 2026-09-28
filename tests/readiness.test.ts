/**
 * Go-live readiness and the operations-demo switch (GO_LIVE items 20, 24,
 * 26, 29 and 30-33): the parts of the checklist the application can check on
 * its own.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, openMemoryDb, setSetting, useDb } from '@/freight/db';
import { insertUser, newId, type Ctx } from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import { checkReadiness } from '@/freight/readiness';
import { OPERATIONS_PATHS, operationsDemoEnabled, routeWhenDemoOff } from '@/operationsDemo';
import type { User } from '@/freight/types';

const KEYS = [
  'AUTH_MODE', 'AUTH_ENTRA_TENANT_ID', 'AUTH_ENTRA_CLIENT_ID', 'AUTH_ENTRA_CLIENT_SECRET', 'AUTH_BASE_URL',
  'AUTH_SESSION_SECRET', 'AUTH_BOOTSTRAP_ADMIN_EMAIL', 'FREIGHT_FORCE_SECURE_COOKIES', 'FREIGHT_DATA_DIR',
  'OPERATIONS_DEMO', 'MAIL_ADAPTER', 'MAILBOX_ADAPTER', 'ERPNEXT_ADAPTER', 'MAILBOX_POLL_SECONDS',
  'MAILBOX_COLLECT_TOKEN', 'FREIGHT_AUTOMATION_TOKEN',
];
const saved: Record<string, string | undefined> = {};
const BACKUPS = path.join(DATA_DIR, 'backups');

let company: string;

function person(name: string, role: User['role'], email: string) {
  const u: User = { id: newId('usr'), name, title: role, email, role, companyIds: [company] };
  insertUser(u);
  return { user: u } as Ctx;
}

const byId = (id: string) => checkReadiness().checks.find((c) => c.id === id)!;

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  useDb(openMemoryDb());
  const boot: Ctx = { user: { id: 'boot', name: 'Boot', title: 'b', email: 'boot@mp-real.com', role: 'logistics_manager', companyIds: [] } };
  company = createCompany(boot, { code: 'MPD', name: 'Distribution', country: 'Egypt', addressLines: ['1'] }).id;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(path.join(BACKUPS, 'freight-readiness-test.db'), { force: true });
});

describe('go-live readiness', () => {
  it('is not ready out of the box, and says why in plain language', () => {
    const r = checkReadiness();
    expect(r.ready).toBe(false);
    expect(byId('auth.mode')).toMatchObject({ status: 'fail', title: expect.stringMatching(/demonstration mode/) });
    expect(byId('email.send').status).toBe('fail');
    expect(byId('erp.write').status).toBe('fail');
    expect(byId('ops.demo').status).toBe('warn');
    expect(r.checks.every((c) => c.detail.length > 10)).toBe(true);
  });

  it('flags demonstration data and reserved-domain addresses', () => {
    setSetting('demo.mode', true);
    person('Ann', 'logistics_manager', 'ann@mp.test');
    const demo = byId('data.demo');
    expect(demo.status).toBe('fail');
    expect(demo.detail).toMatch(/demonstration dataset was loaded/);
    expect(demo.detail).toMatch(/1 address use a reserved domain/);
  });

  it('passes the data checks for a clean, real workspace', () => {
    person('Ann', 'logistics_manager', 'ann@mp-real.com');
    person('Bea', 'logistics_manager', 'bea@mp-real.com');
    upsertProvider({ user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@mp-real.com', role: 'logistics_manager', companyIds: [company] } }, company, {
      name: 'Real Line', kind: 'Carrier', country: 'Egypt', website: null, generalEmail: 'ops@realline.com', notes: null,
      status: 'active', restrictionReason: null, accountRef: null, lanes: [],
      contacts: [{ name: 'Rita', email: 'rita@realline.com', role: null, isPrimary: true }],
    });
    expect(byId('data.demo').status).toBe('ok');
    expect(byId('data.companies').status).toBe('ok');
    expect(byId('data.people')).toMatchObject({ status: 'ok', title: '2 people, 2 managers' });
  });

  it('warns about a single approver, and fails with none', () => {
    expect(byId('data.people').status).toBe('fail');
    person('Ann', 'logistics_manager', 'ann@mp-real.com');
    expect(byId('data.people').status).toBe('warn');
  });

  it('recognises a complete Microsoft sign-in, and a bootstrap setting left behind', () => {
    Object.assign(process.env, {
      AUTH_MODE: 'entra', AUTH_ENTRA_TENANT_ID: 't', AUTH_ENTRA_CLIENT_ID: 'c', AUTH_ENTRA_CLIENT_SECRET: 's',
      AUTH_BASE_URL: 'https://freight.mp-real.com', AUTH_SESSION_SECRET: 'x'.repeat(40),
      AUTH_BOOTSTRAP_ADMIN_EMAIL: 'ann@mp-real.com',
    });
    person('Ann', 'logistics_manager', 'ann@mp-real.com');
    expect(byId('auth.mode').status).toBe('ok');
    expect(byId('auth.bootstrap')).toMatchObject({ status: 'warn', title: 'Remove AUTH_BOOTSTRAP_ADMIN_EMAIL' });
    expect(byId('auth.https').status).toBe('ok');
  });

  it('fails an incomplete Microsoft sign-in and names what is missing', () => {
    process.env.AUTH_MODE = 'entra';
    process.env.AUTH_ENTRA_TENANT_ID = 't';
    const check = byId('auth.mode');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/AUTH_ENTRA_CLIENT_ID/);
  });

  it('checks the backup is recent', () => {
    mkdirSync(BACKUPS, { recursive: true });
    const file = path.join(BACKUPS, 'freight-readiness-test.db');
    writeFileSync(file, '');
    expect(byId('data.backup').status).toBe('ok');
    const old = new Date(Date.now() - 72 * 3_600_000);
    utimesSync(file, old, old);
    expect(byId('data.backup')).toMatchObject({ status: 'warn', title: expect.stringMatching(/7[12] hours old/) });
  });

  it('knows when collection is scheduled and the operations demo is off', () => {
    process.env.MAILBOX_POLL_SECONDS = '120';
    process.env.OPERATIONS_DEMO = 'off';
    expect(byId('email.schedule').status).toBe('ok');
    expect(byId('ops.demo').status).toBe('ok');
  });
});

describe('switching off the operations demo', () => {
  it('is on unless OPERATIONS_DEMO=off', () => {
    expect(operationsDemoEnabled({})).toBe(true);
    expect(operationsDemoEnabled({ OPERATIONS_DEMO: 'off' })).toBe(false);
  });

  it('sends "/" to the freight workspace and 404s every demo route, but leaves freight alone', () => {
    expect(routeWhenDemoOff('/')).toEqual({ kind: 'redirect', to: '/freight' });
    for (const p of OPERATIONS_PATHS) {
      expect(routeWhenDemoOff(p).kind).toBe('not_found');
      expect(routeWhenDemoOff(`${p}/x`).kind).toBe('not_found');
    }
    for (const p of ['/freight', '/freight/settings', '/api/freight/state', '/api/freight/health', '/api/stateful']) {
      expect(routeWhenDemoOff(p).kind).toBe('pass');
    }
  });
});
