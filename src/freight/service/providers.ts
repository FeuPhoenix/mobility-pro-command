/**
 * Company and provider maintenance, including the spreadsheet import.
 *
 * The import is deliberately two-phase: the file is parsed and validated in
 * full and a report is returned, and only a second call actually writes. A
 * partial import that stops halfway through a bad file is much harder to undo
 * than one that never started.
 */

import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import type { Company, CompanyProvider, Lane, Provider, ProviderContact, RelationshipStatus } from '../types';
import { RELATIONSHIP_LABEL } from '../types';
import {
  audit,
  findCompanyProvider,
  findProviderByName,
  getCompany,
  insertCompany,
  insertCompanyProvider,
  insertContact,
  insertProvider,
  listCompanyProviders,
  listContacts,
  newId,
  now,
  updateCompanyProvider,
  updateProvider,
  assertCanEdit,
  assertCompanyAccess,
  getCompanyProvider,
  FreightError,
  tx,
  type Ctx,
} from '../repo';
import { UnreadableFile } from '../parsers/excel';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATUSES: RelationshipStatus[] = ['active', 'contracted', 'excluded', 'prospect'];

export function createCompany(
  ctx: Ctx,
  input: { code: string; name: string; country: string; addressLines: string[] },
): Company {
  assertCanEdit(ctx);
  if (ctx.user.role !== 'logistics_manager') {
    throw new FreightError('Only the Logistics Operations Manager can add a company.', 403, 'forbidden');
  }
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z]{2,6}$/.test(code)) {
    throw new FreightError('The company code must be 2 to 6 letters. It appears in every RFQ reference.');
  }
  if (!input.name.trim()) throw new FreightError('The company needs a name.');

  const company: Company = {
    id: newId('co'),
    code,
    name: input.name.trim(),
    country: input.country.trim() || 'Egypt',
    status: 'active',
    addressLines: input.addressLines.filter((l) => l.trim()),
    createdAt: now(),
  };
  try {
    insertCompany(company);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new FreightError(`The company code ${code} is already in use.`);
    }
    throw err;
  }
  // The creator must be able to see what they just made.
  ctx.user.companyIds.push(company.id);
  audit(ctx, {
    companyId: company.id,
    action: 'company.created',
    subject: `company:${company.id}`,
    summary: `Added the company ${company.name} (${company.code}).`,
  });
  return company;
}

export interface ProviderInput {
  name: string;
  kind: string;
  country: string;
  website: string | null;
  generalEmail: string | null;
  notes: string | null;
  status: RelationshipStatus;
  restrictionReason: string | null;
  accountRef: string | null;
  lanes: Lane[];
  contacts: { name: string; email: string; role: string | null; isPrimary: boolean }[];
}

function validateProviderInput(input: ProviderInput): string[] {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push('A provider name is required.');
  if (!STATUSES.includes(input.status)) {
    errors.push(`"${input.status}" is not a relationship status. Use one of: ${STATUSES.join(', ')}.`);
  }
  if ((input.status === 'contracted' || input.status === 'excluded') && !input.restrictionReason?.trim()) {
    errors.push(
      `A provider marked "${RELATIONSHIP_LABEL[input.status]}" needs a reason, because outreach to it will be blocked.`,
    );
  }
  if (input.generalEmail && !EMAIL_RE.test(input.generalEmail)) {
    errors.push(`"${input.generalEmail}" is not a valid email address.`);
  }
  for (const c of input.contacts) {
    if (!EMAIL_RE.test(c.email)) errors.push(`"${c.email}" is not a valid contact email address.`);
    if (!c.name.trim()) errors.push('Every contact needs a name.');
  }
  if (input.status === 'active' && input.contacts.length === 0 && !input.generalEmail) {
    errors.push('An active provider needs at least one contact or a general email address, or no RFQ can reach it.');
  }
  return errors;
}

/** Creates or updates a provider and this company's relationship with it. */
export function upsertProvider(ctx: Ctx, companyId: string, input: ProviderInput): { providerId: string; linkId: string } {
  assertCanEdit(ctx);
  assertCompanyAccess(ctx, companyId);
  const errors = validateProviderInput(input);
  if (errors.length > 0) throw new FreightError(errors.join(' '));

  return tx(() => {
    const at = now();
    let provider = findProviderByName(input.name);
    if (provider) {
      // Shared details are updated, not duplicated.
      provider = {
        ...provider,
        kind: input.kind || provider.kind,
        country: input.country || provider.country,
        website: input.website ?? provider.website,
        generalEmail: input.generalEmail ?? provider.generalEmail,
        notes: input.notes ?? provider.notes,
      };
      updateProvider(provider);
    } else {
      provider = {
        id: newId('pr'),
        name: input.name.trim(),
        kind: input.kind.trim() || 'Freight forwarder',
        country: input.country.trim() || 'Unknown',
        website: input.website,
        generalEmail: input.generalEmail,
        notes: input.notes,
        createdAt: at,
      };
      insertProvider(provider);
    }

    let link = findCompanyProvider(companyId, provider.id);
    if (link) {
      const previous = link.status;
      link = {
        ...link,
        status: input.status,
        restrictionReason: input.restrictionReason,
        accountRef: input.accountRef,
        lanes: input.lanes,
        notes: input.notes,
      };
      updateCompanyProvider(link);
      if (previous !== input.status) {
        audit(ctx, {
          companyId,
          action: 'provider.status_changed',
          subject: `provider:${link.id}`,
          summary: `Changed ${provider.name} from ${RELATIONSHIP_LABEL[previous]} to ${RELATIONSHIP_LABEL[input.status]}.`,
          detail: { from: previous, to: input.status, reason: input.restrictionReason },
        });
      }
    } else {
      link = {
        id: newId('cp'),
        companyId,
        providerId: provider.id,
        status: input.status,
        restrictionReason: input.restrictionReason,
        accountRef: input.accountRef,
        lanes: input.lanes,
        notes: input.notes,
        createdAt: at,
      };
      insertCompanyProvider(link);
      audit(ctx, {
        companyId,
        action: 'provider.added',
        subject: `provider:${link.id}`,
        summary: `Added ${provider.name} to the provider list as ${RELATIONSHIP_LABEL[input.status]}.`,
      });
    }

    for (const c of input.contacts) {
      insertContact({
        id: newId('pc'),
        companyProviderId: link.id,
        name: c.name.trim(),
        email: c.email.trim().toLowerCase(),
        role: c.role,
        isPrimary: c.isPrimary,
      });
    }

    return { providerId: provider.id, linkId: link.id };
  });
}

/* --------------------------------- Import ------------------------------------ */

export interface ImportRow {
  rowNumber: number;
  input: ProviderInput | null;
  errors: string[];
  warnings: string[];
  /** Set when a provider of this name already exists for this company. */
  duplicateOf: string | null;
  action: 'create' | 'update' | 'skip';
}

export interface ImportReport {
  rows: ImportRow[];
  valid: number;
  invalid: number;
  duplicates: number;
  /** Header problems that make the whole file unusable. */
  fatal: string | null;
}

function cellString(row: ExcelJS.Row, index: number): string {
  const v = row.getCell(index).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as { text?: string; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('').trim();
    if (typeof o.text === 'string') return o.text.trim();
    if (o.result !== undefined && o.result !== null) return String(o.result).trim();
    return '';
  }
  return String(v).trim();
}

function parseLanes(raw: string): Lane[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [origin, destination] = part.split(/[>→-]/).map((s) => s?.trim().toUpperCase() ?? '');
      return { originPort: origin, destinationPort: destination };
    })
    .filter((l) => l.originPort && l.destinationPort);
}

const HEADER_ALIASES: Record<string, string> = {
  'provider name': 'name',
  provider: 'name',
  name: 'name',
  type: 'kind',
  kind: 'kind',
  country: 'country',
  'general email': 'generalEmail',
  email: 'generalEmail',
  'relationship status': 'status',
  status: 'status',
  'restriction reason': 'restrictionReason',
  reason: 'restrictionReason',
  'account reference': 'accountRef',
  'account ref': 'accountRef',
  lanes: 'lanes',
  routes: 'lanes',
  'contact name': 'contactName',
  'contact email': 'contactEmail',
  'contact role': 'contactRole',
  'primary contact': 'contactPrimary',
  primary: 'contactPrimary',
  notes: 'notes',
};

/** Parses and validates the file without writing anything. */
export async function analyseProviderImport(
  ctx: Ctx,
  companyId: string,
  buffer: Buffer,
  filename: string,
): Promise<ImportReport> {
  assertCompanyAccess(ctx, companyId);

  const wb = new ExcelJS.Workbook();
  try {
    if (filename.toLowerCase().endsWith('.csv')) {
      await wb.csv.read(Readable.from(buffer.toString('utf8')));
    } else {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    }
  } catch {
    throw new UnreadableFile(
      `${filename} could not be opened. Save it as .xlsx or .csv and try again, or download the template.`,
    );
  }

  const sheet = wb.worksheets[0];
  if (!sheet || sheet.rowCount < 2) {
    return { rows: [], valid: 0, invalid: 0, duplicates: 0, fatal: 'The file has no data rows.' };
  }

  // Map the header row by name, so column order does not matter.
  const headerRow = sheet.getRow(1);
  const columns: Record<string, number> = {};
  headerRow.eachCell((cell, index) => {
    const key = HEADER_ALIASES[String(cell.value ?? '').trim().toLowerCase()];
    if (key && !(key in columns)) columns[key] = index;
  });
  if (!columns.name) {
    return {
      rows: [],
      valid: 0,
      invalid: 0,
      duplicates: 0,
      fatal:
        'No "Provider name" column was found in the first row. Download the template to see the expected columns.',
    };
  }

  const existing = listCompanyProviders(ctx, companyId);
  const byName = new Map(existing.map((p) => [p.provider.name.trim().toLowerCase(), p]));

  // Several rows can describe the same provider, each adding a contact.
  const grouped = new Map<string, ImportRow>();
  const rows: ImportRow[] = [];

  for (let n = 2; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    const get = (key: string) => (columns[key] ? cellString(row, columns[key]) : '');
    const name = get('name');
    if (!name) continue; // A blank row is not an error.

    const contactEmail = get('contactEmail');
    const contact = contactEmail
      ? [
          {
            name: get('contactName') || contactEmail.split('@')[0],
            email: contactEmail.toLowerCase(),
            role: get('contactRole') || null,
            isPrimary: /^(y|yes|true|1|primary)$/i.test(get('contactPrimary')),
          },
        ]
      : [];

    const key = name.trim().toLowerCase();
    const alreadyInFile = grouped.get(key);
    if (alreadyInFile && alreadyInFile.input) {
      // Another contact for a provider already seen in this file.
      alreadyInFile.input.contacts.push(...contact);
      if (contact.length === 0) {
        alreadyInFile.warnings.push(`Row ${n} repeats ${name} but adds no contact, so it was ignored.`);
      }
      continue;
    }

    const statusRaw = (get('status') || 'active').toLowerCase();
    const input: ProviderInput = {
      name,
      kind: get('kind'),
      country: get('country'),
      website: null,
      generalEmail: get('generalEmail') || null,
      notes: get('notes') || null,
      status: statusRaw as RelationshipStatus,
      restrictionReason: get('restrictionReason') || null,
      accountRef: get('accountRef') || null,
      lanes: parseLanes(get('lanes')),
      contacts: contact,
    };

    const errors = validateProviderInput(input);
    const duplicate = byName.get(key);
    const warnings: string[] = [];
    if (duplicate) {
      warnings.push(
        `${name} is already on the list for this company as ${RELATIONSHIP_LABEL[duplicate.link.status]}. Importing will update it rather than create a second entry.`,
      );
    }
    if (!get('lanes')) warnings.push('No lanes were given, so this provider will not be suggested by route.');

    const entry: ImportRow = {
      rowNumber: n,
      input: errors.length === 0 ? input : input,
      errors,
      warnings,
      duplicateOf: duplicate ? duplicate.provider.name : null,
      action: errors.length > 0 ? 'skip' : duplicate ? 'update' : 'create',
    };
    grouped.set(key, entry);
    rows.push(entry);
  }

  // Re-validate after contact grouping: a provider whose only contact arrived
  // on a later row should no longer fail the "needs a contact" check.
  for (const r of rows) {
    if (!r.input) continue;
    r.errors = validateProviderInput(r.input);
    if (r.errors.length > 0) r.action = 'skip';
  }

  return {
    rows,
    valid: rows.filter((r) => r.errors.length === 0).length,
    invalid: rows.filter((r) => r.errors.length > 0).length,
    duplicates: rows.filter((r) => r.duplicateOf).length,
    fatal: null,
  };
}

/** Writes the rows that passed validation. Invalid rows are never written. */
export function commitProviderImport(
  ctx: Ctx,
  companyId: string,
  report: ImportReport,
): { created: number; updated: number; skipped: number } {
  assertCanEdit(ctx);
  assertCompanyAccess(ctx, companyId);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of report.rows) {
    if (row.errors.length > 0 || !row.input) {
      skipped += 1;
      continue;
    }
    upsertProvider(ctx, companyId, row.input);
    if (row.action === 'update') updated += 1;
    else created += 1;
  }

  audit(ctx, {
    companyId,
    action: 'provider.imported',
    subject: `company:${companyId}`,
    summary: `Imported a provider list: ${created} added, ${updated} updated, ${skipped} skipped because of validation errors.`,
    detail: { created, updated, skipped },
  });

  return { created, updated, skipped };
}

/** Everything the provider screen needs for one company. */
export function providerDirectory(ctx: Ctx, companyId: string) {
  const company = getCompany(ctx, companyId);
  const providers = listCompanyProviders(ctx, companyId);
  return {
    company,
    providers: providers.map((p) => ({
      ...p,
      contactCount: p.contacts.length,
    })),
  };
}

export function setProviderStatus(
  ctx: Ctx,
  linkId: string,
  status: RelationshipStatus,
  reason: string | null,
): CompanyProvider {
  assertCanEdit(ctx);
  const view = getCompanyProvider(ctx, linkId);
  if ((status === 'contracted' || status === 'excluded') && !reason?.trim()) {
    throw new FreightError(
      `Marking ${view.provider.name} as ${RELATIONSHIP_LABEL[status]} blocks outreach, so it needs a reason.`,
    );
  }
  const next: CompanyProvider = { ...view.link, status, restrictionReason: reason };
  updateCompanyProvider(next);
  audit(ctx, {
    companyId: next.companyId,
    action: 'provider.status_changed',
    subject: `provider:${next.id}`,
    summary: `Changed ${view.provider.name} to ${RELATIONSHIP_LABEL[status]}${reason ? `: ${reason}` : ''}.`,
  });
  return next;
}

export function addContact(
  ctx: Ctx,
  linkId: string,
  contact: { name: string; email: string; role: string | null; isPrimary: boolean },
): ProviderContact[] {
  assertCanEdit(ctx);
  const view = getCompanyProvider(ctx, linkId);
  if (!EMAIL_RE.test(contact.email)) throw new FreightError(`"${contact.email}" is not a valid email address.`);
  if (!contact.name.trim()) throw new FreightError('The contact needs a name.');
  insertContact({
    id: newId('pc'),
    companyProviderId: linkId,
    name: contact.name.trim(),
    email: contact.email.trim().toLowerCase(),
    role: contact.role,
    isPrimary: contact.isPrimary,
  });
  audit(ctx, {
    companyId: view.link.companyId,
    action: 'provider.contact_added',
    subject: `provider:${linkId}`,
    summary: `Added ${contact.name} (${contact.email}) as a contact for ${view.provider.name}.`,
  });
  return listContacts(linkId);
}

export type { Provider, CompanyProvider };
