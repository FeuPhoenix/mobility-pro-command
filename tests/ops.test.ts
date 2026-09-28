/**
 * Running on a server (W6): the health check, and the backup script restoring
 * to a working database.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryDb, useDb } from '@/freight/db';
import { health } from '@/freight/ops';

describe('the health check', () => {
  it('reports a working store without revealing configuration', () => {
    useDb(openMemoryDb());
    const h = health();
    expect(h.database).toBe('ok');
    expect(Object.keys(h).sort()).toEqual(['database', 'detail', 'node', 'ok', 'writable']);
  });
});

describe('the backup script', () => {
  it('copies the database and attachments consistently, and prunes only its own old backups', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'freight-backup-'));
    const data = path.join(root, 'data');
    mkdirSync(path.join(data, 'attachments'), { recursive: true });
    const live = new DatabaseSync(path.join(data, 'freight.db'));
    live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
    writeFileSync(path.join(data, 'attachments', 'quote.pdf'), '%PDF');

    const target = path.join(root, 'backups');
    mkdirSync(path.join(target, 'freight-20200101-0000'), { recursive: true });
    utimesSync(path.join(target, 'freight-20200101-0000'), new Date('2020-01-01'), new Date('2020-01-01'));
    mkdirSync(path.join(target, 'someone-elses-folder'));
    utimesSync(path.join(target, 'someone-elses-folder'), new Date('2020-01-01'), new Date('2020-01-01'));

    // The app still holds the database open, as it would in production.
    const out = execFileSync(process.execPath, ['--no-warnings', 'scripts/backup.mjs', target, '14'], {
      env: { ...process.env, FREIGHT_DATA_DIR: data },
      encoding: 'utf8',
    });
    live.close();
    expect(out).toMatch(/1 attachment\. Removed 1 backup/);

    const made = readdirSync(target).filter((n) => /^freight-\d{8}-\d{4}$/.test(n));
    expect(made).toHaveLength(1);
    expect(existsSync(path.join(target, 'someone-elses-folder'))).toBe(true);

    const restored = new DatabaseSync(path.join(target, made[0], 'freight.db'));
    expect(restored.prepare('SELECT v FROM t').get()).toEqual({ v: 'kept' });
    restored.close();
    expect(existsSync(path.join(target, made[0], 'attachments', 'quote.pdf'))).toBe(true);
  });

  it('refuses to run against a folder with no database', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'freight-none-'));
    expect(() =>
      execFileSync(process.execPath, ['--no-warnings', 'scripts/backup.mjs', empty], {
        env: { ...process.env, FREIGHT_DATA_DIR: empty },
        stdio: 'pipe',
      }),
    ).toThrow(/No freight database/);
  });
});
