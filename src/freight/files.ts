/**
 * Attachment storage.
 *
 * Files are written under the data directory and referenced everywhere else by
 * an opaque storage key. The key is validated on every read so a crafted key
 * cannot escape the directory, and the API never exposes an absolute path.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { attachmentDir } from './db';

/** Only these may be attached to, or accepted from, an email. */
export const ALLOWED_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
};

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export class FileError extends Error {}

/** A key is a flat `<uuid>-<safe name>`; anything else is rejected. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

export function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes('..')) {
    throw new FileError('That attachment reference is not valid.');
  }
}

export function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

export function validateUpload(filename: string, bytes: number): { contentType: string } {
  const ext = extensionOf(filename);
  const contentType = ALLOWED_TYPES[ext];
  if (!contentType) {
    throw new FileError(
      `${ext || 'That file type'} is not accepted. Attach a .xlsx, .xls, .csv, .pdf or .txt file.`,
    );
  }
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw new FileError(
      `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (bytes === 0) throw new FileError('That file is empty.');
  return { contentType };
}

function sanitise(filename: string): string {
  return (
    path
      .basename(filename)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 120) || 'file'
  );
}

export function storeFile(filename: string, content: Buffer): string {
  mkdirSync(attachmentDir(), { recursive: true });
  const key = `${randomUUID().slice(0, 8)}-${sanitise(filename)}`;
  assertSafeKey(key);
  writeFileSync(path.join(attachmentDir(), key), content);
  return key;
}

export function readFile(key: string): Buffer {
  assertSafeKey(key);
  const full = path.join(attachmentDir(), key);
  if (!existsSync(full)) throw new FileError('That attachment is no longer stored on this server.');
  return readFileSync(full);
}

export function fileExists(key: string): boolean {
  try {
    assertSafeKey(key);
  } catch {
    return false;
  }
  return existsSync(path.join(attachmentDir(), key));
}

export function fileSize(key: string): number {
  assertSafeKey(key);
  const full = path.join(attachmentDir(), key);
  return existsSync(full) ? statSync(full).size : 0;
}
