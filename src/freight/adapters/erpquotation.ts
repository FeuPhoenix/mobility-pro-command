/**
 * Writing raw quotations to ERPNext.
 *
 * WHY RAW QUOTATIONS AND NOT THE COMPARISON
 * -----------------------------------------
 * The customer's decision, and a good one: the quotations are a reusable data
 * asset, whereas a stored comparison is only this application's conclusion
 * frozen into their ERP. Keeping the ranking logic out of ERPNext also means
 * changing how offers are weighed never needs a schema change on their side.
 *
 * The comparison writer in `erpnext.ts` is unchanged and still available; this
 * is the primary destination now, and the two are independent.
 *
 * THREE RULES THIS ENFORCES
 * -------------------------
 * 1. **Only checked quotations are written.** Every extracted figure carries a
 *    confidence and a source, and a person confirms or corrects it before it
 *    can be compared. Sending unreviewed machine output would put their
 *    analytics on numbers nobody has verified.
 * 2. **A missing charge stays missing.** It is written as null, never zero. A
 *    provider omitting a surcharge is ordinary, and zeroing it makes their
 *    offer look like the cheapest when it is not - the exact error this
 *    application exists to avoid.
 * 3. **Revisions are kept apart.** Each version is its own record, carrying its
 *    version number and the one it supersedes, so an average over the table
 *    cannot silently count the same offer twice.
 */

import { createHash } from 'node:crypto';
import type { Company, Quote, Rfq } from '../types';

export interface QuotationRecordInput {
  idempotencyKey: string;
  company: Company;
  rfq: Rfq;
  quote: Quote;
  providerName: string;
  /** The provider's id in ERPNext, when the two systems have been linked. */
  supplierName: string | null;
  /** Which attempt this is, from the persisted sync row, counting from 1. */
  attempt: number;
}

/**
 * The document written for one quotation.
 *
 * Kept in one function so the mapping is reviewable in one place, and so the
 * DocType definition can be checked against it by a test.
 */
export function quotationPayload(input: QuotationRecordInput): Record<string, unknown> {
  const { quote: q, rfq } = input;

  // `null`, never 0. See rule 2 above.
  const value = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

  return {
    // What a retry searches on, so it updates rather than inserting again.
    freight_idempotency_key: input.idempotencyKey,
    record_slug: recordSlug(input),

    company: input.company.name,
    supplier: input.supplierName,
    provider_name: input.providerName,

    rfq_reference: rfq.reference,
    route: `${rfq.originPort} - ${rfq.destinationPort}`,
    origin_port: rfq.originPort,
    destination_port: rfq.destinationPort,
    incoterm: rfq.incoterm,

    quotation_version: q.version,
    supersedes_quotation: q.supersedesQuoteId,
    quotation_status: q.status,
    received_at: q.createdAt.slice(0, 10),
    reviewed_at: q.reviewedAt ? q.reviewedAt.slice(0, 10) : null,

    shipping_line: value(q.shippingLine.value),
    currency: value(q.currency.value),
    container_basis: value(q.containerBasis.value),
    base_freight: value(q.baseFreight.value),
    total_quoted_by_provider: value(q.totalQuoted.value),
    transit_days: value(q.transitDays.value),
    free_days_destination: value(q.freeDaysDestination.value),
    valid_until: value(q.validUntil.value),
    sailing_date: value(q.sailingDate.value),
    payment_terms: value(q.paymentTerms.value),
    inclusions: (q.inclusions.value ?? []).join('\n') || null,
    exclusions: (q.exclusions.value ?? []).join('\n') || null,
    conditions: (q.conditions.value ?? []).join('\n') || null,

    // Provenance travels with the data, so their analysts can see which figures
    // were read from a labelled line and which a person corrected by hand.
    source_kind: q.sourceKind,
    source_attachment: q.sourceAttachment,
    extractor: q.extractorId,
    field_confidence: JSON.stringify(confidenceMap(q)),
    // Same reason as amount_missing on a charge: Frappe cannot store an empty
    // number, so these landed as 0 without ever being stated. A report can
    // filter on this without parsing the confidence JSON.
    unstated_numbers: unstatedNumbers(q).join(', ') || null,

    charges: q.surcharges.map((s) => ({
      charge_code: s.code,
      charge_label: s.label,
      // Null when the provider named the charge but not its amount. Frappe
      // stores a Float as 0 rather than null whatever we send, so the flag
      // below is what keeps "not stated" distinguishable from "free".
      amount: value(s.amount),
      amount_missing: s.amount === null || s.amount === undefined ? 1 : 0,
      currency: value(s.currency),
      basis: s.basis,
      confidence: s.confidence,
      source_reference: s.sourceRef,
    })),
  };
}

/**
 * The document name in ERPNext: readable, and unique.
 *
 * It ends in part of the integration key on purpose. A name built from the RFQ,
 * the provider and the version alone collides whenever two different quotations
 * share those - and ERPNext then reports a duplicate whose record cannot be
 * found by key, which is a write that fails on every retry. Found against a
 * real instance.
 *
 * The suffix is a hash of the key rather than its first characters: two keys
 * that merely start alike would otherwise still collide. It is deterministic,
 * so a retry builds the same name.
 */
function recordSlug(input: QuotationRecordInput): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9 .-]/g, '').trim().slice(0, 40);
  return [
    'FQ',
    clean(input.rfq.reference),
    clean(input.providerName),
    `v${input.quote.version}`,
    createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 10),
  ].join('-');
}

/**
 * The numeric fields the provider never stated.
 *
 * They are written as 0, because a Frappe Float is NOT NULL with a default of
 * 0. Naming them here is what stops a report reading "we were quoted nothing"
 * as "we were quoted zero".
 */
function unstatedNumbers(q: Quote): string[] {
  return (
    [
      ['base_freight', q.baseFreight.value],
      ['total_quoted_by_provider', q.totalQuoted.value],
      ['transit_days', q.transitDays.value],
      ['free_days_destination', q.freeDaysDestination.value],
    ] as const
  )
    .filter(([, v]) => v === null || v === undefined)
    .map(([name]) => name);
}

/** Which figures were read cleanly, inferred, or corrected by a person. */
function confidenceMap(q: Quote): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (name: string, f: { confidence: string; correctedBy: string | null }) => {
    out[name] = f.correctedBy ? 'corrected_by_reviewer' : f.confidence;
  };
  add('shipping_line', q.shippingLine);
  add('currency', q.currency);
  add('container_basis', q.containerBasis);
  add('base_freight', q.baseFreight);
  add('total_quoted_by_provider', q.totalQuoted);
  add('transit_days', q.transitDays);
  add('free_days_destination', q.freeDaysDestination);
  add('valid_until', q.validUntil);
  add('sailing_date', q.sailingDate);
  add('payment_terms', q.paymentTerms);
  return out;
}

/**
 * Whether a quotation may be written at all.
 *
 * Returns the reason when it may not, so the screen can say why rather than
 * leaving a record silently absent.
 */
export function quotationBlockedReason(q: Quote): string | null {
  if (q.status === 'confirmed') return null;
  if (q.status === 'needs_review') {
    return 'The figures have not been checked yet. Confirm them against the source first, so ERPNext is not given unverified numbers.';
  }
  if (q.status === 'superseded') {
    return 'This version was replaced by a later quotation from the same provider. The current version is the one that is recorded.';
  }
  if (q.status === 'unreadable') {
    return 'This quotation could not be read, so there are no figures to record. Enter them by hand, or leave it flagged.';
  }
  if (q.status === 'declined') {
    return 'The provider declined to quote, so there is no quotation to record.';
  }
  return `A quotation with status "${q.status}" is not recorded.`;
}

/** The fields the destination DocType must hold, checked before any write. */
export function quotationFieldNames(): string[] {
  const sample = quotationPayload({
    idempotencyKey: 'x',
    company: { id: '', code: '', name: '', country: '', status: 'active', addressLines: [], createdAt: '' },
    rfq: {
      id: '', reference: '', companyId: '', title: '', originPort: '', destinationPort: '',
      incoterm: 'FOB', containers: [], cargoNotes: null, targetShipFrom: '', targetShipTo: '',
      responseDeadline: '', instructions: null, requestedCurrency: 'USD', status: 'draft',
      createdBy: '', createdAt: '', closedAt: null, closedBy: null,
    },
    quote: emptyQuoteShape(),
    providerName: '',
    supplierName: null,
    attempt: 1,
  });
  return Object.keys(sample);
}

/** The child-table fields, likewise. */
/**
 * The charge columns written to ERPNext.
 *
 * `amount_missing` exists because of what a real Frappe does, not what ours
 * intends: a Float column is NOT NULL with a default of 0, so a charge the
 * provider named without pricing lands as 0.00 however carefully we send null.
 * Zero and "not stated" must not be the same number in their analytics, so the
 * flag carries the difference. Found against ERPNext 15.121.4.
 */
export const QUOTATION_CHARGE_FIELDS = [
  'charge_code',
  'charge_label',
  'amount',
  'amount_missing',
  'currency',
  'basis',
  'confidence',
  'source_reference',
] as const;

function emptyQuoteShape(): Quote {
  const f = {
    value: null,
    confidence: 'missing' as const,
    sourceRef: null,
    sourceText: null,
    correctedBy: null,
    correctedAt: null,
    note: null,
  };
  return {
    id: '', companyId: '', rfqId: '', companyProviderId: '', version: 1, supersedesQuoteId: null,
    status: 'confirmed', sourceKind: 'email_body', sourceMessageId: null, sourceAttachment: null,
    unreadableReason: null,
    shippingLine: f, originPort: f, destinationPort: f, currency: f, containerBasis: f,
    baseFreight: f, surcharges: [], totalQuoted: f, transitDays: f, freeDaysDestination: f,
    validUntil: f, sailingDate: f, paymentTerms: f, inclusions: f, exclusions: f, conditions: f,
    extractorId: '', extractedAt: '', reviewedBy: null, reviewedAt: null, createdAt: '',
  } as unknown as Quote;
}
