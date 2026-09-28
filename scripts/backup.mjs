/**
 * Takes a consistent backup of the freight database while it is running.
 *
 *   node scripts/backup.mjs [--out=dir] [--keep=14]
 *
 * It uses SQLite's `VACUUM INTO`, which writes a complete, already-checkpointed
 * copy in one statement. Copying the `.sqlite` file with `cp` is not equivalent:
 * the database runs in WAL mode, so recent writes live in a sidecar file and a
 * naive copy can restore to a state that never existed.
 *
 * Attachments are files on disk beside the database and are NOT included here;
 * back up the whole data directory for those. This exists so a nightly job can
 * take the database safely without stopping the application.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
const DB_FILE = process.env.FREIGHT_DB_FILE ?? path.join(DATA_DIR, 'freight.db');

const OUT = path.resolve(arg('out', path.join(DATA_DIR, 'backups')));
const KEEP = Number(arg('keep', '14'));

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

// Keep the most recent, discard the rest. A backup nobody prunes fills the disk
// that the application needs to keep working.
if (Number.isFinite(KEEP) && KEEP > 0) {
  const backups = readdirSync(OUT)
    .filter((f) => /^freight-.*\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of backups.slice(KEEP)) {
    unlinkSync(path.join(OUT, old));
    console.log(`  pruned ${old}`);
  }
}
