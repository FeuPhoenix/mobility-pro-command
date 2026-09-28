/**
 * Checks a backup, or restores one.
 *
 *   node scripts/restore.mjs --from=backups/freight-<stamp>.db --check
 *   node scripts/restore.mjs --from=backups/freight-<stamp>.db --yes
 *
 * --check  Opens a throwaway copy of the backup, runs SQLite's integrity check,
 *          and reports what it holds. Touches nothing live. This is the
 *          "restore-test it once" step, and it is safe to run at any time.
 *
 * --yes    Restores into FREIGHT_DATA_DIR. STOP THE APPLICATION FIRST. The
 *          current database and attachments are moved aside, never deleted,
 *          as freight.db.before-restore-<stamp> and
 *          attachments.before-restore-<stamp>, so a wrong restore can be undone.
 *
 * The attachments folder written by scripts/backup.mjs next to the .db file
 * (freight-<stamp>-attachments/) is restored with it when present.
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const from = arg('from');
const check = process.argv.includes('--check');
const yes = process.argv.includes('--yes');

if (!from || (!check && !yes)) {
  console.error('Usage: node scripts/restore.mjs --from=<backup.db> (--check | --yes)');
  process.exit(2);
}
const source = path.resolve(from);
if (!existsSync(source)) {
  console.error(`No backup at ${source}.`);
  process.exit(2);
}
const sourceFiles = source.replace(/\.db$/, '-attachments');

/** Integrity and contents of a database file, opened read-only. */
function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const count = (table) => {
      try {
        return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      } catch {
        return null;
      }
    };
    return {
      ok: Object.values(integrity)[0] === 'ok',
      integrity: Object.values(integrity)[0],
      counts: {
        companies: count('companies'),
        users: count('users'),
        rfqs: count('rfqs'),
        quotes: count('quotes'),
        inbound_messages: count('inbound_messages'),
        audit_events: count('audit_events'),
      },
    };
  } finally {
    db.close();
  }
}

if (check) {
  // A throwaway copy, so even opening it cannot change the backup itself.
  const scratch = mkdtempSync(path.join(tmpdir(), 'freight-restore-check-'));
  const copy = path.join(scratch, 'freight.db');
  copyFileSync(source, copy);
  const result = inspect(copy);
  rmSync(scratch, { recursive: true, force: true });
  const files = existsSync(sourceFiles) ? readdirSync(sourceFiles).length : null;
  console.log(`Backup ${path.basename(source)} (${(statSync(source).size / 1024).toFixed(0)} KB)`);
  console.log(`  integrity: ${result.integrity}`);
  for (const [k, v] of Object.entries(result.counts)) console.log(`  ${k}: ${v ?? 'missing'}`);
  console.log(`  attachments: ${files === null ? 'not included in this backup' : files}`);
  if (!result.ok) {
    console.error('This backup is damaged. Do not restore it.');
    process.exit(1);
  }
  console.log('The backup opens and passes the integrity check.');
  process.exit(0);
}

// --yes: restore into the live data folder.
const DATA_DIR = process.env.FREIGHT_DATA_DIR
  ? path.resolve(process.env.FREIGHT_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
const DB_FILE = process.env.FREIGHT_DB_FILE || path.join(DATA_DIR, 'freight.db');
const ATTACHMENTS = path.join(DATA_DIR, 'attachments');

const verdict = inspect(source);
if (!verdict.ok) {
  console.error(`The backup fails its integrity check (${verdict.integrity}). Nothing was changed.`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const suffix of ['', '-wal', '-shm']) {
  const live = `${DB_FILE}${suffix}`;
  if (existsSync(live)) renameSync(live, `${live}.before-restore-${stamp}`);
}
copyFileSync(source, DB_FILE);
console.log(`Restored the database from ${path.basename(source)}. The previous one is kept as ${path.basename(DB_FILE)}.before-restore-${stamp}.`);

if (existsSync(sourceFiles)) {
  if (existsSync(ATTACHMENTS)) renameSync(ATTACHMENTS, `${ATTACHMENTS}.before-restore-${stamp}`);
  cpSync(sourceFiles, ATTACHMENTS, { recursive: true });
  console.log(`Restored ${readdirSync(ATTACHMENTS).length} attachment(s).`);
} else {
  console.log('This backup has no attachments folder; the current attachments were left in place.');
}
console.log('Start the application again.');
