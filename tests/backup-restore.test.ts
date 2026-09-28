/**
 * Backups include the attachments, and a backup can be checked and restored
 * (GO_LIVE items 26 and 27). The scripts run as a real process against a real
 * database file, which the "application" holds open throughout.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function run(script: string, args: string[], dataDir: string) {
  return execFileSync(process.execPath, ['--no-warnings', `scripts/${script}`, ...args], {
    env: { ...process.env, FREIGHT_DATA_DIR: dataDir, FREIGHT_DB_FILE: '' },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function store() {
  // Short paths: SQLite cannot open files beyond Windows' 260-character limit.
  const root = mkdtempSync(path.join(tmpdir(), 'fr-'));
  const data = path.join(root, 'data');
  mkdirSync(path.join(data, 'attachments'), { recursive: true });
  const live = new DatabaseSync(path.join(data, 'freight.db'));
  live.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE companies (id TEXT); INSERT INTO companies VALUES ('co1');
    CREATE TABLE quotes (id TEXT); INSERT INTO quotes VALUES ('q1'), ('q2');`);
  writeFileSync(path.join(data, 'attachments', 'quote.pdf'), '%PDF original');
  return { root, data, live };
}

describe('backup', () => {
  it('writes the database and the attachments beside it, while the app holds the database open', () => {
    const { root, data, live } = store();
    const out = path.join(root, 'backups');
    const log = run('backup.mjs', [`--out=${out}`], data);
    live.close();

    expect(log).toMatch(/Copied 1 attachment/);
    const files = readdirSync(out);
    const db = files.find((f) => f.endsWith('.db'))!;
    expect(files).toContain(db.replace(/\.db$/, '-attachments'));
    expect(readFileSync(path.join(out, db.replace(/\.db$/, '-attachments'), 'quote.pdf'), 'utf8')).toBe('%PDF original');
  });

  it('prunes each old backup together with its attachments', () => {
    const { root, data, live } = store();
    const out = path.join(root, 'backups');
    mkdirSync(path.join(out, 'freight-2020-01-01T00-00-00-000Z-attachments'), { recursive: true });
    writeFileSync(path.join(out, 'freight-2020-01-01T00-00-00-000Z.db'), '');
    run('backup.mjs', [`--out=${out}`, '--keep=1'], data);
    live.close();
    expect(readdirSync(out).some((f) => f.startsWith('freight-2020'))).toBe(false);
  });
});

describe('restore', () => {
  it('checks a backup in a throwaway copy and reports what it holds', () => {
    const { root, data, live } = store();
    const out = path.join(root, 'backups');
    run('backup.mjs', [`--out=${out}`], data);
    live.close();
    const db = path.join(out, readdirSync(out).find((f) => f.endsWith('.db'))!);

    const log = run('restore.mjs', [`--from=${db}`, '--check'], data);
    expect(log).toMatch(/integrity: ok/);
    expect(log).toMatch(/quotes: 2/);
    expect(log).toMatch(/attachments: 1/);
  });

  it('refuses a damaged backup', () => {
    const { root, data, live } = store();
    live.close();
    const bad = path.join(root, 'bad.db');
    writeFileSync(bad, 'this is not a database');
    expect(() => run('restore.mjs', [`--from=${bad}`, '--check'], data)).toThrow();
  });

  it('restores the database and attachments, keeping what it replaced', () => {
    const { root, data, live } = store();
    const out = path.join(root, 'backups');
    run('backup.mjs', [`--out=${out}`], data);
    // Things change after the backup...
    live.exec("DELETE FROM quotes; INSERT INTO companies VALUES ('co-later');");
    live.close();
    writeFileSync(path.join(data, 'attachments', 'quote.pdf'), '%PDF changed');
    const db = path.join(out, readdirSync(out).find((f) => f.endsWith('.db'))!);

    const log = run('restore.mjs', [`--from=${db}`, '--yes'], data);
    expect(log).toMatch(/Restored the database/);

    const restored = new DatabaseSync(path.join(data, 'freight.db'), { readOnly: true });
    expect((restored.prepare('SELECT count(*) AS n FROM quotes').get() as { n: number }).n).toBe(2);
    restored.close();
    expect(readFileSync(path.join(data, 'attachments', 'quote.pdf'), 'utf8')).toBe('%PDF original');

    // ...and nothing that was replaced is lost.
    const kept = readdirSync(data);
    expect(kept.some((f) => f.startsWith('freight.db.before-restore-'))).toBe(true);
    expect(kept.some((f) => f.startsWith('attachments.before-restore-'))).toBe(true);
  });

  it('needs an explicit --check or --yes', () => {
    const { data, live } = store();
    live.close();
    expect(() => run('restore.mjs', ['--from=whatever.db'], data)).toThrow();
    expect(existsSync(path.join(data, 'freight.db'))).toBe(true);
  });
});
