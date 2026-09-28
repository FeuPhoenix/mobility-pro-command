/**
 * Writes the freight DocType definitions out as files their ERPNext team can
 * use directly, so nobody has to read our source to build the destination.
 *
 *   node scripts/erpnext/emit-doctypes.mjs [--out=dir] [--module=Freight] [--no-supplier-link]
 *
 * It emits, per DocType, the JSON Frappe accepts at
 * **Developer → DocType → Menu → Import** (and which drops into a custom app's
 * `doctype/<name>/<name>.json` unchanged), plus a field table to paste into a
 * message.
 *
 * The definitions come from `freight-quotation-doctype.mjs`, the same ones a
 * unit test checks against the payload we write. Regenerate rather than editing
 * the output: Frappe silently drops unknown fields, so a hand-edited file loses
 * data while reporting success.
 *
 * `--no-supplier-link` emits `supplier` as plain Data, for a tenant where
 * freight providers are not yet Suppliers.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { doctypes, PARENT, INTEGRATION_ROLE } from './freight-quotation-doctype.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const OUT = arg('out', 'docs/erpnext');
const MODULE = arg('module', 'Freight');
const SUPPLIER_LINK = !process.argv.includes('--no-supplier-link');

const slug = (name) => name.toLowerCase().replace(/\s+/g, '_');

/** The notes that matter more than the types, kept with the field they govern. */
const NOTE = {
  freight_idempotency_key: 'What a retry searches on. The unique index is what makes a retry safe.',
  amount: 'Optional, no default. A charge named without a price is empty, never zero.',
  base_freight: 'Optional, no default. Empty means the provider did not state it.',
  total_quoted_by_provider: 'Optional. Only meaningful when the provider gave a total themselves.',
  quotation_version: '1, then 2 for a revision. A revision is a separate record.',
  supersedes_quotation: 'Set on a revision. Exclude superseded rows when aggregating.',
  field_confidence: 'Per field: high, medium, low, missing, corrected_by_reviewer.',
  quotation_status: 'Only confirmed quotations are ever written.',
};

function table(def) {
  const rows = def.fields.map((f) => {
    const flags = [
      f.reqd ? 'required' : '',
      f.unique ? 'unique' : '',
      f.read_only ? 'read-only' : '',
    ].filter(Boolean).join(', ');
    // Select options are newline separated, which would break the table row.
    const options = String(f.options ?? '').split(/[\r\n]+/).filter(Boolean).join(' / ');
    const type = options ? `${f.fieldtype} → ${options}` : f.fieldtype;
    return `| \`${f.fieldname}\` | ${type} | ${flags || '—'} | ${NOTE[f.fieldname] ?? f.description ?? ''} |`;
  });
  return [
    `### ${def.name}${def.istable ? ' (child table)' : ''}`,
    '',
    '| Field | Type | Flags | Notes |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

mkdirSync(OUT, { recursive: true });

const defs = doctypes({ module: MODULE, supplierLink: SUPPLIER_LINK });
for (const def of defs) {
  const path = `${OUT}/${slug(def.name)}.json`;
  writeFileSync(path, `${JSON.stringify(def, null, 2)}\n`, 'utf8');
  console.log(`  wrote ${path}  (${def.fields.length} fields)`);
}

const md = [
  '# Freight quotation DocTypes',
  '',
  '**Generated — do not edit.** Regenerate with `node scripts/erpnext/emit-doctypes.mjs`.',
  'The reasoning behind these fields is in `docs/FREIGHT_ERPNEXT.md`.',
  '',
  '## How to create them',
  '',
  `1. Create the child table **before** the parent: ${defs.map((d) => `\`${d.name}\``).join(', then ')}.`,
  '2. Developer → DocType → Menu → Import, one JSON file each.',
  `3. Confirm the unique index on \`freight_idempotency_key\` exists. Without it a retry after a`,
  '   timeout writes a second record instead of finding the first.',
  `4. Create the role **${INTEGRATION_ROLE}** and give the integration user only that role.`,
  '',
  '## Two things to keep as they are',
  '',
  '- **`amount` and `base_freight` stay optional with no default.** A provider naming a charge',
  '  without pricing it is ordinary; a zero makes their offer look like the cheapest when it is not.',
  '  Reports should read empty as unknown.',
  `- **Each revision is its own record.** Filter to \`quotation_status = 'confirmed'\` and exclude`,
  "  rows named in another row's `supersedes_quotation`, or the same offer is counted twice.",
  '',
  ...defs.map(table),
].join('\n');

writeFileSync(`${OUT}/README.md`, `${md}\n`, 'utf8');
console.log(`  wrote ${OUT}/README.md`);
console.log(`\n${PARENT} definitions written to ${OUT}. Hand that folder over as-is.`);
