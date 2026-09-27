/**
 * Writing raw quotations to ERPNext.
 *
 * The three rules the customer's analytics depend on are the point of this
 * file: only checked quotations go across, a missing charge stays missing, and
 * each revision is its own record.
 */

import { describe, expect, it } from 'vitest';
import {
  quotationPayload,
  quotationBlockedReason,
  quotationFieldNames,
  QUOTATION_CHARGE_FIELDS,
} from '@/freight/adapters/erpquotation';
import { parentDoctype, childDoctype } from '../scripts/erpnext/freight-quotation-doctype.mjs';
import type { Company, Quote, Rfq, Surcharge } from '@/freight/types';

const company: Company = {
  id: 'co1', code: 'MPD', name: 'Mobility Pro Distribution S.A.E.', country: 'Egypt',
  status: 'active', addressLines: [], createdAt: '2026-01-01T00:00:00.000Z',
};

const rfq: Rfq = {
  id: 'rfq1', reference: 'RFQ-MPD-2026-0001', companyId: 'co1', title: 'Tyres',
  originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB',
  containers: [{ type: '40HC', quantity: 6, grossWeightKg: null, commodity: 'Tyres' }],
  cargoNotes: null, targetShipFrom: '2026-11-10', targetShipTo: '2026-11-24',
  responseDeadline: '2026-10-06T17:00:00.000Z', instructions: null, requestedCurrency: 'USD',
  status: 'closed', createdBy: 'u1', createdAt: '2026-09-20T00:00:00.000Z',
  closedAt: null, closedBy: null,
};

const field = <T>(value: T | null, over: Partial<{ confidence: string; correctedBy: string | null }> = {}) => ({
  value,
  confidence: (over.confidence ?? (value === null ? 'missing' : 'high')) as never,
  sourceRef: 'email body, line 5',
  sourceText: null,
  correctedBy: over.correctedBy ?? null,
  correctedAt: null,
  note: null,
});

function quote(over: Partial<Quote> = {}): Quote {
  return {
    id: 'q1', companyId: 'co1', rfqId: 'rfq1', companyProviderId: 'cp1',
    version: 1, supersedesQuoteId: null, status: 'confirmed',
    sourceKind: 'email_body', sourceMessageId: 'm1', sourceAttachment: null, unreadableReason: null,
    shippingLine: field('Oriental Star'), originPort: field('CNSHA'), destinationPort: field('EGALY'),
    currency: field('USD'), containerBasis: field('40HC'), baseFreight: field(1640),
    surcharges: [], totalQuoted: field(11799), transitDays: field(38),
    freeDaysDestination: field(3), validUntil: field('2026-11-30'), sailingDate: field('2026-11-14'),
    paymentTerms: field('30 days'), inclusions: field(['ocean freight']), exclusions: field(['customs']),
    conditions: field([]),
    extractorId: 'deterministic/text@1', extractedAt: '2026-09-21T00:00:00.000Z',
    reviewedBy: 'u1', reviewedAt: '2026-09-22T00:00:00.000Z', createdAt: '2026-09-21T00:00:00.000Z',
    ...over,
  } as Quote;
}

const input = (q: Quote) => ({
  idempotencyKey: 'key-1',
  company,
  rfq,
  quote: q,
  providerName: 'Nile Star Logistics',
  supplierName: null,
  attempt: 1,
});

/* ------------------------------ Rule 1: checked ------------------------------- */

describe('only checked quotations are written', () => {
  it('allows a confirmed one', () => {
    expect(quotationBlockedReason(quote())).toBeNull();
  });

  it('refuses one nobody has checked, and says why', () => {
    const reason = quotationBlockedReason(quote({ status: 'needs_review' }));
    expect(reason).toMatch(/have not been checked/i);
  });

  it('refuses a superseded version', () => {
    expect(quotationBlockedReason(quote({ status: 'superseded' }))).toMatch(/replaced by a later/i);
  });

  it('refuses an unreadable one and a decline', () => {
    expect(quotationBlockedReason(quote({ status: 'unreadable' }))).toMatch(/could not be read/i);
    expect(quotationBlockedReason(quote({ status: 'declined' }))).toMatch(/declined/i);
  });
});

/* --------------------------- Rule 2: missing stays missing --------------------- */

describe('a missing charge is never zero', () => {
  const surcharge = (over: Partial<Surcharge>): Surcharge => ({
    code: 'THC-DEST', label: 'Terminal handling (destination)', amount: null, currency: null,
    basis: 'per_container', sourceRef: 'email body, line 9', confidence: 'missing', ...over,
  });

  it('writes null for a charge with no amount', () => {
    const payload = quotationPayload(input(quote({ surcharges: [surcharge({})] })));
    const charges = payload.charges as Record<string, unknown>[];
    expect(charges[0].amount).toBeNull();
    expect(charges[0].amount).not.toBe(0);
    expect(charges[0].charge_label).toBe('Terminal handling (destination)');
  });

  it('writes the amount when there is one', () => {
    const payload = quotationPayload(input(quote({ surcharges: [surcharge({ code: 'BAF', amount: 185, currency: 'USD', confidence: 'high' })] })));
    expect((payload.charges as Record<string, unknown>[])[0].amount).toBe(185);
  });

  it('writes null, not zero, for a field the provider never stated', () => {
    const payload = quotationPayload(input(quote({ baseFreight: field(null), transitDays: field(null) })));
    expect(payload.base_freight).toBeNull();
    expect(payload.transit_days).toBeNull();
  });
});

/* ----------------------------- Rule 3: revisions ------------------------------- */

describe('revisions stay apart', () => {
  it('carries the version and what it supersedes', () => {
    const payload = quotationPayload(input(quote({ version: 2, supersedesQuoteId: 'q1' })));
    expect(payload.quotation_version).toBe(2);
    expect(payload.supersedes_quotation).toBe('q1');
  });
});

/* -------------------------------- Provenance ------------------------------------ */

describe('provenance travels with the figures', () => {
  it('records how confident each field was', () => {
    const payload = quotationPayload(input(quote({ currency: field('USD', { confidence: 'medium' }) })));
    const confidence = JSON.parse(payload.field_confidence as string) as Record<string, string>;
    expect(confidence.base_freight).toBe('high');
    expect(confidence.currency).toBe('medium');
  });

  it('marks a value a person corrected, rather than calling it machine-read', () => {
    const payload = quotationPayload(input(quote({ baseFreight: field(1700, { correctedBy: 'u1' }) })));
    const confidence = JSON.parse(payload.field_confidence as string) as Record<string, string>;
    expect(confidence.base_freight).toBe('corrected_by_reviewer');
  });

  it('keeps the extractor and the source file', () => {
    const payload = quotationPayload(input(quote({ sourceKind: 'excel', sourceAttachment: 'Rates.xlsx' })));
    expect(payload.source_kind).toBe('excel');
    expect(payload.source_attachment).toBe('Rates.xlsx');
    expect(payload.extractor).toBe('deterministic/text@1');
  });
});

/* ------------------------- The DocType matches the payload ---------------------- */

describe('the proposed DocType holds everything written', () => {
  const parent = parentDoctype({ module: 'Freight', supplierLink: true });
  const child = childDoctype({ module: 'Freight' });

  it('has every parent field the payload writes', () => {
    const defined = new Set(parent.fields.map((f) => f.fieldname));
    const missing = quotationFieldNames().filter((f) => f !== 'charges' && !defined.has(f));
    // Frappe silently drops unknown fields, so a gap here loses data in
    // production while reporting success.
    expect(missing, `missing from the DocType: ${missing.join(', ')}`).toEqual([]);
  });

  it('has every charge field the payload writes', () => {
    const defined = new Set(child.fields.map((f) => f.fieldname));
    const missing = QUOTATION_CHARGE_FIELDS.filter((f) => !defined.has(f));
    expect(missing, `missing from the child table: ${missing.join(', ')}`).toEqual([]);
  });

  it('makes the integration key unique, which is what makes a retry safe', () => {
    const key = parent.fields.find((f) => f.fieldname === 'freight_idempotency_key');
    expect(key?.unique).toBe(1);
  });

  it('leaves the charge amount optional and undefaulted', () => {
    const amount = child.fields.find((f) => f.fieldname === 'amount');
    // A required or defaulted amount would turn "not stated" into zero.
    expect(amount?.reqd).toBeUndefined();
    expect(amount?.default).toBeUndefined();
  });

  it('does not require base freight either', () => {
    const base = parent.fields.find((f) => f.fieldname === 'base_freight');
    expect(base?.reqd).toBeUndefined();
    expect(base?.default).toBeUndefined();
  });
});
