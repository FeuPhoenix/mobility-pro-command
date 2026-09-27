/**
 * Starting an RFQ from an email (W5). Off unless RFQ_EMAIL_INTAKE=on.
 *
 * A person already on the People list emails the freight mailbox with
 * "New RFQ" or "RFQ request" in the subject, and the shipping requirement
 * either as labelled lines or as the Excel template attached. Collection hands
 * it here instead of to the reply matcher.
 *
 * WHAT IT WILL AND WILL NOT DO
 * ----------------------------
 * - It creates DRAFT RFQs only, in the sender's name and within the sender's
 *   companies, through the same `createRfq` and validation as the form.
 * - It never selects providers, prepares email or sends anything. Choosing who
 *   is asked, and approving what they are sent, stay with a person.
 * - A request it cannot read in full creates nothing. It is kept, with every
 *   problem in plain language, on the Replies screen for a person to act on.
 * - The same email collected twice is recognised by its message id.
 *
 * The sender check is by address. Email From addresses can be forged, which is
 * one reason this only ever produces drafts a person reviews.
 */

import type { Company, Incoterm, RfqRequest } from '../types';
import {
  assertCanEdit,
  audit,
  findRfqRequestByExternalId,
  findUserByEmail,
  getRfqRequest,
  insertRfqRequest,
  listCompanies,
  newId,
  now,
  setRfqRequestStatus,
  tx,
  FreightError,
  type Ctx,
} from '../repo';
import { findReference } from '../domain/matching';
import { readCells, UnreadableFile } from '../parsers/excel';
import { looksLikeRfqTemplate, parseRequestSheet, parseRequestText, type ParsedRequest } from '../parsers/rfqRequest';
import { createRfq, validateRfqInput } from './rfq';
import type { IncomingMail } from './inbox';

export function intakeEnabled(): boolean {
  return process.env.RFQ_EMAIL_INTAKE === 'on';
}

const SUBJECT = /\b(new\s+rfq|rfq\s+request|shipping\s+requirement)\b/i;

/**
 * Should this message be read as a request for a new RFQ, not a provider reply?
 * Only when intake is on, the subject asks for one, it is not a reply to an
 * existing request, and the sender is a person in this workspace.
 */
export function isRfqRequest(mail: IncomingMail): boolean {
  if (!intakeEnabled()) return false;
  if (!SUBJECT.test(mail.subject) || /^\s*re\s*:/i.test(mail.subject)) return false;
  if (findReference(mail.subject)) return false;
  const person = findUserByEmail(mail.fromEmail);
  return Boolean(person && !person.disabled && person.role !== 'system_mailbox_collector');
}

async function parse(mail: IncomingMail): Promise<ParsedRequest> {
  for (const a of mail.attachments) {
    if (!/\.(xlsx|csv)$/i.test(a.filename)) continue;
    try {
      const cells = await readCells(a.content, a.filename);
      if (looksLikeRfqTemplate(cells)) {
        // A company line in the body still applies to an attached sheet.
        const fromBody = parseRequestText(mail.bodyText).companyCode;
        return { ...parseRequestSheet(cells, a.filename), companyCode: fromBody };
      }
    } catch (err) {
      if (!(err instanceof UnreadableFile)) throw err;
    }
  }
  return parseRequestText(mail.bodyText);
}

function whichCompany(companies: Company[], code: string | null): Company | string {
  if (code) {
    return (
      companies.find((c) => c.code === code) ??
      `"Company: ${code}" is not a company you can raise requests for${companies.length > 0 ? ` (${companies.map((c) => c.code).join(', ')})` : ''}.`
    );
  }
  if (companies.length === 1) return companies[0];
  return `Add a "Company:" line: you can raise requests for ${companies.map((c) => c.code).join(', ') || 'no company yet'}.`;
}

export async function ingestRfqRequest(mail: IncomingMail): Promise<RfqRequest> {
  const existing = findRfqRequestByExternalId(mail.externalId);
  if (existing) return existing;

  const person = findUserByEmail(mail.fromEmail);
  if (!person) throw new FreightError('That sender is not in this workspace.');
  const ctx: Ctx = { user: person };
  const companies = listCompanies(ctx);

  const problems: string[] = [];
  if (person.role === 'viewer') problems.push('Your access is read-only, so an RFQ cannot be raised in your name.');

  const parsed = await parse(mail);
  problems.push(...parsed.problems);

  const company = whichCompany(companies, parsed.companyCode);
  if (typeof company === 'string') problems.push(company);

  const inputs =
    typeof company === 'string'
      ? []
      : parsed.requests.map((r) => ({ ...r, companyId: company.id, incoterm: r.incoterm as Incoterm }));
  inputs.forEach((input, i) => {
    for (const e of validateRfqInput(input)) problems.push(inputs.length > 1 ? `Requirement ${i + 1}: ${e}` : e);
  });

  const request: RfqRequest = {
    id: newId('rreq'),
    externalId: mail.externalId,
    fromEmail: mail.fromEmail.toLowerCase(),
    userId: person.id,
    subject: mail.subject,
    receivedAt: mail.receivedAt,
    bodyText: mail.bodyText,
    status: problems.length === 0 ? 'created' : 'needs_attention',
    rfqIds: [],
    problems,
    companyIds: typeof company === 'string' ? person.companyIds : [company.id],
    simulated: mail.simulated,
    createdAt: now(),
  };

  // All the drafts from one email, and the record of it, land together or not at all.
  return tx(() => {
    if (problems.length === 0) {
      for (const input of inputs) request.rfqIds.push(createRfq(ctx, input).id);
    }
    insertRfqRequest(request);
    audit(ctx, {
      companyId: typeof company === 'string' ? null : company.id,
      action: problems.length === 0 ? 'rfq.requested_by_email' : 'rfq.request_needs_attention',
      subject: `rfq-request:${request.id}`,
      summary:
        problems.length === 0
          ? `${person.name} emailed a shipping requirement; ${request.rfqIds.length} draft RFQ${request.rfqIds.length === 1 ? ' was' : 's were'} created. Providers have not been chosen and nothing has been sent.`
          : `${person.name} emailed a shipping requirement that could not be read in full, so no RFQ was created: ${problems.join(' ')}`,
    });
    return request;
  });
}

/** A person has dealt with a request that needed attention (e.g. used the form). */
export function dismissRfqRequest(ctx: Ctx, id: string): RfqRequest {
  assertCanEdit(ctx);
  const request = getRfqRequest(id);
  if (!request || !request.companyIds.some((c) => ctx.user.companyIds.includes(c))) {
    throw new FreightError('That request was not found.', 404, 'not_found');
  }
  if (request.status !== 'needs_attention') throw new FreightError('Only a request that needs attention can be dismissed.');
  setRfqRequestStatus(id, 'dismissed');
  audit(ctx, {
    companyId: request.companyIds[0] ?? null,
    action: 'rfq.request_dismissed',
    subject: `rfq-request:${id}`,
    summary: `${ctx.user.name} dismissed the emailed request "${request.subject}" from ${request.fromEmail}.`,
  });
  return { ...request, status: 'dismissed' };
}
