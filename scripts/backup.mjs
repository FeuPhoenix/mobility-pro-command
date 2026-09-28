/**
 * Takes a consistent backup of the freight store while it is running.
 *
 *   node scripts/backup.mjs [--out=dir] [--keep=14] [--no-attachments]
 *
 * Writes, per run:
 *   freight-<stamp>.db               the database
 *   freight-<stamp>-attachments/     the quotations and workbooks it refers to
 *
 * The database uses SQLite's `VACUUM INTO`, which writes a complete, already-
 * checkpointed copy in one statement. Copying the file with `cp` is not
 * equivalent: the database runs in WAL mode, so recent writes live in a sidecar
 * file and a naive copy can restore to a state that never existed.
 *
 * Attachments are copied after the database, so every file the backed-up
 * database refers to is present (a file added in between is simply extra).
 *
 * The default `--out` is inside the data folder, on the same disk. Copy the
 * backups somewhere else as well: a backup on the same disk does not survive
 * losing the disk. Restore with scripts/restore.mjs.
 */

import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DATA_DIR = process.env.FREIGHT_DATA_DIR
  ? path.resolve(process.env.FREIGHT_DATA_DIR)
  : path.resolve(process.cwd(), 'data');
// Must match src/freight/db.ts exactly, or this backs up nothing and says it
// worked.
const DB_FILE = process.env.FREIGHT_DB_FILE || path.join(DATA_DIR, 'freight.db');
const ATTACHMENTS = path.join(DATA_DIR, 'attachments');

const OUT = path.resolve(arg('out', path.join(DATA_DIR, 'backups')));
const KEEP = Number(arg('keep', '14'));
const WITH_ATTACHMENTS = !process.argv.includes('--no-attachments');

mkdirSync(OUT, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(OUT, `freight-${stamp}.db`);

if (!existsSync(DB_FILE)) {
  console.error(`No database at ${DB_FILE}. Nothing was backed up.`);
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE, { readOnly: true });
try {
  // One statement, and it refuses rather than half-writing if the target exists.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
console.log(`Wrote ${target} (${(statSync(target).size / 1024).toFixed(0)} KB)`);

if (WITH_ATTACHMENTS && existsSync(ATTACHMENTS)) {
  const folder = path.join(OUT, `freight-${stamp}-attachments`);
  cpSync(ATTACHMENTS, folder, { recursive: true });
  console.log(`Copied ${readdirSync(folder).length} attachment(s) to ${folder}`);
}

// Keep the most recent, discard the rest - and each run's attachments with it.
// A backup nobody prunes fills the disk that the application needs.
if (Number.isFinite(KEEP) && KEEP > 0) {
  const backups = readdirSync(OUT)
    .filter((f) => /^freight-.*\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of backups.slice(KEEP)) {
    unlinkSync(path.join(OUT, old));
    const files = path.join(OUT, old.replace(/\.db$/, '-attachments'));
    if (existsSync(files)) rmSync(files, { recursive: true, force: true });
    console.log(`  pruned ${old}`);
  }
}
