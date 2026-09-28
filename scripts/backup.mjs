/**
 * Backs up the freight store (database + attachments), safely while the
 * application is running, and prunes old backups.
 *
 *   node scripts/backup.mjs [target-folder] [keep-days]
 *
 * Defaults: target = $FREIGHT_BACKUP_DIR or ./backups, keep 14 days.
 * Reads the store from $FREIGHT_DATA_DIR (default ./data), exactly as the app.
 * Schedule it daily (cron, systemd timer or Windows Task Scheduler), and copy
 * the target folder somewhere off the server: a backup on the same disk does
 * not survive losing the disk.
 *
 * To restore: stop the app, replace data/freight.db and data/attachments with
 * the ones from a backup folder, start the app.
 */

import { DatabaseSync, backup } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.FREIGHT_DATA_DIR ?? 'data');
const dbPath = process.env.FREIGHT_DB_FILE ?? path.join(dataDir, 'freight.db');
const target = path.resolve(process.argv[2] ?? process.env.FREIGHT_BACKUP_DIR ?? 'backups');
const keepDays = Number.parseInt(process.argv[3] ?? '14', 10);

if (!existsSync(dbPath)) {
  console.error(`No freight database at ${dbPath}. Set FREIGHT_DATA_DIR to the folder the app uses.`);
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const folder = path.join(target, `freight-${stamp}`);
mkdirSync(folder, { recursive: true });

const source = new DatabaseSync(dbPath, { readOnly: true });
await backup(source, path.join(folder, 'freight.db'));
source.close();

const attachments = path.join(dataDir, 'attachments');
let files = 0;
if (existsSync(attachments)) {
  cpSync(attachments, path.join(folder, 'attachments'), { recursive: true });
  files = readdirSync(attachments).length;
}

let removed = 0;
const cutoff = Date.now() - keepDays * 86_400_000;
for (const name of readdirSync(target)) {
  if (!/^freight-\d{8}-\d{4}$/.test(name)) continue;
  const full = path.join(target, name);
  if (full !== folder && statSync(full).mtimeMs < cutoff) {
    rmSync(full, { recursive: true, force: true });
    removed += 1;
  }
}

console.log(
  `Backed up to ${folder}: database ${statSync(path.join(folder, 'freight.db')).size} bytes, ${files} attachment${files === 1 ? '' : 's'}.` +
    (removed > 0 ? ` Removed ${removed} backup${removed === 1 ? '' : 's'} older than ${keepDays} days.` : ''),
);
