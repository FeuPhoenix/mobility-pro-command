/**
 * What the reader makes of a folder of real `.eml` quotations.
 *
 *   SAMPLES=C:/path/to/folder npx tsx scripts/extraction-report.mts
 *
 * Reads every `.eml` in the folder, runs it through the same parsing and
 * extraction the application uses, and prints one line per file: which figures
 * came out, how many charges were recognised, and how many money lines it could
 * not place.
 *
 * It asserts nothing. The point is to see the truth about real provider
 * formatting before changing a single pattern - and then to write a test for
 * each format met, rather than tuning a regex until one file looks right.
 *
 * It prints subjects and senders, so send its output nowhere: these are real
 * customers and real rates.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEml, UnreadableEml } from '../src/freight/parsers/eml';
import { storeFile, validateUpload } from '../src/freight/files';
import { extractQuote } from '../src/freight/domain/extraction';
import type { InboundMessage, Quote } from '../src/freight/types';

const dir = process.env.SAMPLES;
if (!dir) {
  console.error('Set SAMPLES to the folder holding the .eml files.');
  process.exit(2);
}

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.eml')).sort();
console.log(`${files.length} files in ${dir}\n`);

const v = <T>(f: { value: T | null }): string => (f.value === null ? '-' : String(f.value));

interface Row {
  file: string;
  from: string;
  status: Quote['status'];
  currency: string;
  base: string;
  basis: string;
  transit: string;
  valid: string;
  charges: number;
  unplaced: number;
  attachments: string;
  note: string;
}

const rows: Row[] = [];

for (const file of files) {
  const full = path.join(dir, file);
  let parsed;
  try {
    parsed = parseEml(readFileSync(full));
  } catch (err) {
    rows.push({
      file, from: '', status: 'unreadable' as Quote['status'], currency: '-', base: '-', basis: '-',
      transit: '-', valid: '-', charges: 0, unplaced: 0, attachments: '',
      note: err instanceof UnreadableEml ? err.message : String(err),
    });
    continue;
  }

  const message: InboundMessage = {
    id: `sample-${file}`,
    companyId: 'co',
    rfqId: null,
    companyProviderId: null,
    externalId: parsed.messageId,
    threadId: null,
    inReplyTo: parsed.inReplyTo,
    fromEmail: parsed.fromEmail,
    fromName: parsed.fromName,
    subject: parsed.subject,
    receivedAt: parsed.date ?? new Date().toISOString(),
    bodyText: parsed.bodyText,
    // Stored for real, so the PDF and spreadsheet readers actually run.
    // Anything the application would refuse on upload is left out here too.
    attachments: parsed.attachments.flatMap((a) => {
      try {
        validateUpload(a.filename, a.content.length);
      } catch {
        return [];
      }
      return [
        {
          filename: a.filename,
          contentType: a.contentType,
          storageKey: storeFile(a.filename, a.content),
          bytes: a.content.length,
        },
      ];
    }),
    matchState: 'matched',
    matchReason: null,
    candidates: [],
    simulated: false,
    createdAt: new Date().toISOString(),
  } as unknown as InboundMessage;

  const { quote } = await extractQuote({ message, at: new Date().toISOString() });

  rows.push({
    file,
    from: parsed.fromEmail,
    status: quote.status,
    currency: v(quote.currency),
    base: v(quote.baseFreight),
    basis: v(quote.containerBasis),
    transit: v(quote.transitDays),
    valid: v(quote.validUntil),
    charges: quote.surcharges.length,
    unplaced: quote.unplacedLines.length,
    attachments: parsed.attachments.map((a) => a.filename).join(', '),
    note: quote.unreadableReason ?? '',
  });
}

/* --------------------------------- The report --------------------------------- */

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

console.log(
  `${pad('file', 44)} ${pad('status', 13)} ${pad('cur', 4)} ${pad('base', 9)} ${pad('basis', 6)} ${pad('days', 5)} ${pad('valid', 11)} chg unpl`,
);
console.log('-'.repeat(120));
for (const r of rows) {
  console.log(
    `${pad(r.file, 44)} ${pad(r.status, 13)} ${pad(r.currency, 4)} ${pad(r.base, 9)} ${pad(r.basis, 6)} ${pad(r.transit, 5)} ${pad(r.valid, 11)} ${String(r.charges).padStart(3)} ${String(r.unplaced).padStart(4)}`,
  );
}

const got = (k: keyof Row) => rows.filter((r) => r[k] !== '-' && r[k] !== '').length;
const pct = (n: number) => `${Math.round((n / rows.length) * 100)}%`;

console.log(`\nOut of ${rows.length} files:`);
console.log(`  base freight read      ${got('base')}  (${pct(got('base'))})`);
console.log(`  currency read          ${got('currency')}  (${pct(got('currency'))})`);
console.log(`  container basis read   ${got('basis')}  (${pct(got('basis'))})`);
console.log(`  transit time read      ${got('transit')}  (${pct(got('transit'))})`);
console.log(`  validity read          ${got('valid')}  (${pct(got('valid'))})`);
console.log(`  with any charge        ${rows.filter((r) => r.charges > 0).length}`);
console.log(`  with unplaced lines    ${rows.filter((r) => r.unplaced > 0).length}`);
console.log(`  unreadable             ${rows.filter((r) => r.status === 'unreadable').length}`);
console.log(`  read as a decline      ${rows.filter((r) => r.status === 'declined').length}`);
console.log(`  with attachments       ${rows.filter((r) => r.attachments).length}`);

const withFiles = rows.filter((r) => r.attachments);
if (withFiles.length) {
  console.log('\nAttachments seen:');
  for (const r of withFiles) console.log(`  ${pad(r.file, 44)} ${r.attachments}`);
}

const notes = rows.filter((r) => r.note);
if (notes.length) {
  console.log('\nCould not be read:');
  for (const r of notes) console.log(`  ${pad(r.file, 44)} ${r.note}`);
}
