/**
 * Persistence for the freight RFQ module.
 *
 * WHY THIS DIFFERS FROM THE REST OF THE APP
 * -----------------------------------------
 * The document-control demo elsewhere in this repo is deliberately stateless -
 * the browser carries the demo document. That is right for a throwaway
 * presentation, but it cannot honestly provide what this module needs:
 *
 *   - an approval that is *bound* to reviewed content and survives a reload,
 *   - duplicate-send protection that a client cannot simply forget,
 *   - company isolation the server actually enforces,
 *   - an audit trail the user cannot rewrite.
 *
 * So the freight module keeps its own server-side store. It uses Node's built-in
 * `node:sqlite` (Node 22.5+), which means a real relational store with zero
 * native compilation and no extra service to run.
 *
 * DEPLOYMENT NOTE: this requires a writable filesystem. It runs locally and on
 * any normal Node host. It will NOT work on a read-only serverless filesystem;
 * see docs/FREIGHT_SETUP.md.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.FREIGHT_DATA_DIR
  ? path.resolve(process.env.FREIGHT_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

export const ATTACHMENT_DIR = path.join(DATA_DIR, 'attachments');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  company_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  status TEXT NOT NULL,
  address_lines TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  country TEXT NOT NULL,
  website TEXT,
  general_email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
-- Duplicate detection on import keys off a normalised name.
CREATE UNIQUE INDEX IF NOT EXISTS providers_name_key
  ON providers (lower(trim(name)));

CREATE TABLE IF NOT EXISTS company_providers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  restriction_reason TEXT,
  account_ref TEXT,
  lanes TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, provider_id)
);

CREATE TABLE IF NOT EXISTS provider_contacts (
  id TEXT PRIMARY KEY,
  company_provider_id TEXT NOT NULL REFERENCES company_providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_provider_id, email)
);

CREATE TABLE IF NOT EXISTS rfqs (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  origin_port TEXT NOT NULL,
  destination_port TEXT NOT NULL,
  incoterm TEXT NOT NULL,
  containers TEXT NOT NULL,
  cargo_notes TEXT,
  target_ship_from TEXT NOT NULL,
  target_ship_to TEXT NOT NULL,
  response_deadline TEXT NOT NULL,
  instructions TEXT,
  requested_currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT
);

CREATE TABLE IF NOT EXISTS rfq_recipients (
  id TEXT PRIMARY KEY,
  rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  company_provider_id TEXT NOT NULL REFERENCES company_providers(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  sent_at TEXT,
  first_response_at TEXT,
  reminders_sent INTEGER NOT NULL DEFAULT 0,
  last_reminder_at TEXT,
  UNIQUE (rfq_id, company_provider_id)
);

CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  company_provider_id TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  attachments TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  approved_hash TEXT,
  sent_at TEXT,
  transport_message_id TEXT,
  simulated INTEGER NOT NULL DEFAULT 1,
  failure_reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  thread_id TEXT,
  in_reply_to TEXT,
  from_email TEXT NOT NULL,
  from_name TEXT,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  body_text TEXT NOT NULL,
  attachments TEXT NOT NULL,
  match_status TEXT NOT NULL,
  match_basis TEXT NOT NULL,
  rfq_id TEXT,
  company_provider_id TEXT,
  candidates TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  simulated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  company_provider_id TEXT NOT NULL REFERENCES company_providers(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  supersedes_quote_id TEXT,
  status TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_message_id TEXT,
  source_attachment TEXT,
  unreadable_reason TEXT,
  fields TEXT NOT NULL,
  extractor_id TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (rfq_id, company_provider_id, version)
);

CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rfq_id TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  workbook_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS erp_syncs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  comparison_id TEXT NOT NULL REFERENCES comparisons(id) ON DELETE CASCADE,
  adapter TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  doctype TEXT,
  remote_name TEXT,
  remote_url TEXT,
  last_error TEXT,
  setup_requirements TEXT NOT NULL,
  last_attempt_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_company_at ON audit_events (company_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_subject ON audit_events (subject, at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let instance: DatabaseSync | null = null;

/**
 * The process-wide handle. Next.js reloads modules in development, so the
 * instance is cached on `globalThis` to avoid opening the file repeatedly.
 */
export function db(): DatabaseSync {
  if (instance) return instance;
  const cached = (globalThis as { __freightDb?: DatabaseSync }).__freightDb;
  if (cached) {
    instance = cached;
    return cached;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(ATTACHMENT_DIR, { recursive: true });
  const file = process.env.FREIGHT_DB_FILE ?? path.join(DATA_DIR, 'freight.db');
  const handle = new DatabaseSync(file);
  handle.exec(SCHEMA);
  migrate(handle);
  instance = handle;
  (globalThis as { __freightDb?: DatabaseSync }).__freightDb = handle;
  return handle;
}

/** An isolated in-memory database. Used by the tests so they never touch disk. */
export function openMemoryDb(): DatabaseSync {
  const handle = new DatabaseSync(':memory:');
  handle.exec(SCHEMA);
  migrate(handle);
  return handle;
}

/**
 * Additive changes to databases created by an earlier version. Each step checks
 * before it acts, so running it on every start is safe.
 */
function migrate(handle: DatabaseSync): void {
  const userColumns = new Set(
    (handle.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!userColumns.has('disabled')) handle.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  if (!userColumns.has('external_id')) handle.exec('ALTER TABLE users ADD COLUMN external_id TEXT');
  // Sign-in finds a person by email, so an address may belong to one person only.
  try {
    handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email))');
  } catch {
    // An older database with duplicate addresses keeps working; the People
    // screen refuses to create new duplicates.
  }
  handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_key ON users (external_id) WHERE external_id IS NOT NULL');
}

/** Point the module-wide handle at a specific database. Tests only. */
export function useDb(handle: DatabaseSync): void {
  instance = handle;
  (globalThis as { __freightDb?: DatabaseSync }).__freightDb = handle;
}

/**
 * Runs `fn` inside a transaction, so a multi-table write either lands
 * completely or not at all - important for "approve then send then log".
 */
export function tx<T>(fn: () => T): T {
  const handle = db();
  handle.exec('BEGIN');
  try {
    const out = fn();
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      /* the original error is the useful one */
    }
    throw err;
  }
}

export function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function bool(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === '1';
}

export function str(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? json<T>(row.value, fallback) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  db()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, JSON.stringify(value));
}

/** Drops every row but keeps the schema. Used by "reset the demo". */
export function truncateAll(): void {
  const handle = db();
  const tables = [
    'audit_events',
    'erp_syncs',
    'comparisons',
    'quotes',
    'inbound_messages',
    'emails',
    'rfq_recipients',
    'rfqs',
    'provider_contacts',
    'company_providers',
    'providers',
    'companies',
    'users',
    'settings',
  ];
  handle.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) handle.exec(`DELETE FROM ${t}`);
  handle.exec('PRAGMA foreign_keys = ON');
}
