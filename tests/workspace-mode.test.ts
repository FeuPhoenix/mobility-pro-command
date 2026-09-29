/**
 * The demo / production switch.
 *
 * What matters: it does not exist unless the server allows it; the two
 * workspaces are separate databases; the demonstration can never reach a real
 * mailbox or ERPNext; and going from production back to the anonymous
 * demonstration needs a signed-in manager once anyone has an account.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db, openMemoryDb, resetDb, useDb } from '@/freight/db';
import { insertUser, newId } from '@/freight/repo';
import { hashPassword } from '@/freight/auth/password';
import { authMode } from '@/freight/auth/config';
import { activeDbFile, setWorkspaceMode, workspaceMode } from '@/freight/workspaceMode';
import { resolveMailTransport } from '@/freight/adapters/mail';
import { resolveMailbox } from '@/freight/adapters/mailbox';
import { GET, POST } from '@/app/api/freight/workspace-mode/route';

const KEYS = ['FREIGHT_DATA_DIR', 'FREIGHT_DB_FILE', 'FREIGHT_MODE_SWITCH', 'AUTH_MODE', 'MAIL_ADAPTER', 'MAILBOX_ADAPTER'];
let saved: Record<string, string | undefined> = {};
let dir = '';

function post(body: unknown) {
  return POST(new Request('http://localhost/api/freight/workspace-mode', { method: 'POST', body: JSON.stringify(body) }));
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(path.join(tmpdir(), 'wm-'));
  process.env.FREIGHT_DATA_DIR = dir;
  delete process.env.FREIGHT_DB_FILE;
  delete process.env.AUTH_MODE;
  resetDb();
});

afterEach(() => {
  resetDb();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  useDb(openMemoryDb());
  rmSync(dir, { recursive: true, force: true });
});

describe('with the switch off (a deployment)', () => {
  it('is production, honours AUTH_MODE, and refuses to switch', async () => {
    delete process.env.FREIGHT_MODE_SWITCH;
    process.env.AUTH_MODE = 'entra';
    expect(workspaceMode()).toBe('production');
    expect(authMode()).toBe('entra');
    const res = await post({ mode: 'demo' });
    expect(res.status).toBe(403);
    expect(await (await GET()).json()).toMatchObject({ switchEnabled: false });
  });
});

describe('with the switch on', () => {
  beforeEach(() => {
    process.env.FREIGHT_MODE_SWITCH = 'on';
  });

  it('starts in the demonstration, on its own database', () => {
    expect(workspaceMode()).toBe('demo');
    expect(authMode()).toBe('demo');
    expect(activeDbFile()).toBe(path.join(dir, 'demo', 'freight.db'));
  });

  it('production is a real sign-in and uses the main database', () => {
    setWorkspaceMode('production');
    expect(authMode()).toBe('password');
    expect(activeDbFile()).toBe(path.join(dir, 'freight.db'));
    process.env.AUTH_MODE = 'entra';
    expect(authMode()).toBe('entra');
  });

  it('keeps the two workspaces apart, and neither sees the other', async () => {
    db().prepare("INSERT INTO settings (key, value) VALUES ('marker', '\"demo\"')").run();
    expect((await post({ mode: 'production' })).status).toBe(200);
    expect(db().prepare("SELECT count(*) AS n FROM settings WHERE key = 'marker'").get()).toEqual({ n: 0 });
    db().prepare("INSERT INTO settings (key, value) VALUES ('marker', '\"real\"')").run();
    // Nobody has an account, so going back is allowed.
    expect((await post({ mode: 'demo' })).status).toBe(200);
    expect(db().prepare("SELECT value FROM settings WHERE key = 'marker'").get()).toEqual({ value: '"demo"' });
  });

  it('forces email to stay simulated in the demonstration, whatever the environment says', () => {
    process.env.MAIL_ADAPTER = 'graph';
    process.env.MAILBOX_ADAPTER = 'graph';
    expect(resolveMailTransport().status().kind).toBe('simulated');
    expect(resolveMailbox().status().kind).toBe('simulated');
  });

  it('refuses to leave production for the anonymous demo once someone can sign in, unless a manager is signed in', async () => {
    await post({ mode: 'production' });
    insertUser({
      id: newId('usr'), name: 'Hala', title: 'Manager', email: 'hala@example.com',
      role: 'logistics_manager', companyIds: [],
    });
    const hash = await hashPassword('CorrectHorse9');
    db().prepare('UPDATE users SET password_hash = ?').run(hash);
    const res = await post({ mode: 'demo' });
    expect(res.status).toBe(401);
    expect(workspaceMode()).toBe('production');
  });

  it('rejects anything but demo or production', async () => {
    expect((await post({ mode: 'staging' })).status).toBe(400);
  });
});
