/**
 * Demo workspace or production workspace, switchable from Settings.
 *
 * The switch is OFF unless `FREIGHT_MODE_SWITCH=on` is set on the server, so a
 * deployment cannot be flipped from a browser. With it on, the two workspaces
 * are separate: the demonstration one lives in `<data>/demo/` (its own database
 * and attachments) and production keeps `<data>/freight.db`. Switching changes
 * which one the server opens; it never copies or deletes anything, so real data
 * is never visible in the anonymous demo, and demo data never reaches real
 * people.
 *
 * The chosen mode is a small file beside both databases, not a row in either.
 *
 * Demo mode forces every adapter to its simulated form, whatever the
 * environment says: fictional data must not reach a real mailbox or ERPNext.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type WorkspaceMode = 'demo' | 'production';

export function baseDataDir(): string {
  return process.env.FREIGHT_DATA_DIR
    ? path.resolve(process.env.FREIGHT_DATA_DIR)
    : path.resolve(process.cwd(), 'data');
}

export function modeSwitchEnabled(): boolean {
  return process.env.FREIGHT_MODE_SWITCH === 'on';
}

function modeFile(): string {
  return path.join(baseDataDir(), 'workspace-mode.json');
}

/** The chosen mode. Without the switch it is not a choice: production. */
export function workspaceMode(): WorkspaceMode {
  if (!modeSwitchEnabled()) return 'production';
  try {
    const raw = JSON.parse(readFileSync(modeFile(), 'utf8')) as { mode?: string };
    return raw.mode === 'production' ? 'production' : 'demo';
  } catch {
    // Nothing chosen yet: start in the demonstration, as an unconfigured
    // install always has.
    return 'demo';
  }
}

/** True when the demonstration workspace is the active one through the switch. */
export function demoWorkspaceActive(): boolean {
  return modeSwitchEnabled() && workspaceMode() === 'demo';
}

export function setWorkspaceMode(mode: WorkspaceMode): void {
  mkdirSync(baseDataDir(), { recursive: true });
  const tmp = `${modeFile()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ mode, changedAt: new Date().toISOString() }));
  renameSync(tmp, modeFile());
}

/** The database the server should have open right now. */
export function activeDbFile(): string {
  if (demoWorkspaceActive()) return path.join(baseDataDir(), 'demo', 'freight.db');
  return process.env.FREIGHT_DB_FILE || path.join(baseDataDir(), 'freight.db');
}

export function activeAttachmentDir(): string {
  return demoWorkspaceActive()
    ? path.join(baseDataDir(), 'demo', 'attachments')
    : path.join(baseDataDir(), 'attachments');
}

export function modeFileExists(): boolean {
  return existsSync(modeFile());
}
