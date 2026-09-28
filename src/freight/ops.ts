/**
 * Operating the freight module on a server: the health check behind
 * GET /api/health. Backups are scripts/backup.mjs, which runs outside the app.
 */

import { accessSync, constants } from 'node:fs';
import { DATA_DIR, db } from './db';

export interface Health {
  ok: boolean;
  database: 'ok' | 'error';
  writable: boolean;
  node: string;
  detail: string | null;
}

/** Deliberately says nothing about configuration or data: it may be public. */
export function health(): Health {
  let database: Health['database'] = 'ok';
  let writable = true;
  let detail: string | null = null;
  try {
    db().prepare('SELECT 1').get();
  } catch (err) {
    database = 'error';
    detail = err instanceof Error ? err.message : 'The database could not be opened.';
  }
  try {
    accessSync(DATA_DIR, constants.W_OK);
  } catch {
    writable = false;
    detail = detail ?? 'The data folder is not writable. The freight module needs a writable disk.';
  }
  return { ok: database === 'ok' && writable, database, writable, node: process.versions.node, detail };
}
