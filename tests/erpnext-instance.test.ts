/**
 * The quotation write against a REAL ERPNext instance.
 *
 * Skipped unless you point it at one:
 *
 *   ERPNEXT_LIVE_URL=http://127.0.0.1:8080 \
 *   ERPNEXT_LIVE_KEY=... ERPNEXT_LIVE_SECRET=... \
 *   npx vitest run tests/erpnext-instance.test.ts
 *
 * **A test instance only.** It creates and updates records. Point it at the
 * customer's production site and it will write to it.
 *
 * Prepare the instance first:
 *   node scripts/erpnext-create-doctype.mjs --destination quotation
 * and make sure a Company exists whose name matches, or set ERPNEXT_COMPANY_MAP.
 *
 * Everything here was first run against ERPNext 15.121.4 in a throwaway
 * container, and three things it found are why the file exists: Frappe cannot
 * store an empty number, a document name built from RFQ, provider and version
 * collides, and the module must exist before the DocType.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { LiveErp } from '@/freight/adapters/erpnext';
import type { Company, Quote, Rfq } from '@/freight/types';

const BASE = process.env.ERPNEXT_LIVE_URL?.replace(/\/+$/, '') ?? '';
const KEY = process.env.ERPNEXT_LIVE_KEY ?? '';
const SECRET = process.env.ERPNEXT_LIVE_SECRET ?? '';
const QUOTATION_DOCTYPE = process.env.ERPNEXT_LIVE_QUOTATION_DOCTYPE ?? 'Freight Quotation';
const COMPANY = process.env.ERPNEXT_LIVE_COMPANY ?? 'Mobility Pro Distribution S.A.E.';

const configured = Boolean(BASE && KEY && SECRET);

const headers = {
  authorization: `token ${KEY}:${SECRET}`,
  accept: 'application/json',
  'content-type': 'application/json',
};

const erp = () =>
  new LiveErp({
    baseUrl: BASE,
    apiKey: KEY,
    apiSecret: SECRET,
    doctype: '',
    quotationDoctype: QUOTATION_DOCTYPE,
    companyMap: {} as Record<string, string>,
  });

const f = <T>(value: T | null) => ({
  value,
  confidence: (value === null ? 'missing' : 'high') as never,
  sourceRef: 'email body, line 5',
  sourceText: null,
  correctedBy: null,
  correctedAt: null,
  note: null,
});

const company = { id: 'co1', code: 'MPD', name: COMPANY } as Company;
const rfq = {
  id: 'rfq1',
  reference: 'RFQ-MPD-2026-0001',
  originPort: 'CNSHA',
  destinationPort: 'EGALY',
  incoterm: 'FOB',
  requestedCurrency: 'USD',
} as Rfq;

const quote = (over: Partial<Quote> = {}) =>
  ({
    id: 'q1',
    companyId: 'co1',
    rfqId: 'rfq1',
    companyProviderId: 'cp1',
    version: 1,
    supersedesQuoteId: null,
    status: 'confirmed',
    sourceKind: 'email_body',
    sourceMessageId: 'm1',
    sourceAttachment: null,
    unreadableReason: null,
    shippingLine: f('Oriental Star'),
    originPort: f('CNSHA'),
    destinationPort: f('EGALY'),
    currency: f('USD'),
    containerBasis: f('40HC'),
    baseFreight: f(1640),
    surcharges: [
      {
        code: 'THC-DEST',
        label: 'Terminal handling (destination)',
        amount: null,
        currency: null,
        basis: 'per_container',
        sourceRef: 'line 9',
        confidence: 'missing',
      },
      {
        code: 'BAF',
        label: 'Bunker adjustment',
        amount: 185,
        currency: 'USD',
        basis: 'per_container',
        sourceRef: 'line 10',
        confidence: 'high',
      },
    ],
    totalQuoted: f(null),
    transitDays: f(38),
    freeDaysDestination: f(3),
    validUntil: f('2099-12-31'),
    sailingDate: f('2026-11-14'),
    paymentTerms: f('30 days'),
    inclusions: f([]),
    exclusions: f([]),
    conditions: f([]),
    extractorId: 'deterministic/text@1',
    extractedAt: '2026-09-21T00:00:00.000Z',
    reviewedBy: 'u1',
    reviewedAt: '2026-09-22T00:00:00.000Z',
    createdAt: '2026-09-21T00:00:00.000Z',
    ...over,
  }) as Quote;

const input = (key: string, q = quote()) => ({
  idempotencyKey: key,
  company,
  rfq,
  quote: q,
  providerName: 'Nile Star Logistics',
  supplierName: null,
  attempt: 1,
});

/** One run's key, so repeated runs do not fight over the same record. */
const KEY_PREFIX = `check-${Date.now()}`;

interface WrittenDoc {
  base_freight: number;
  total_quoted_by_provider: number;
  unstated_numbers: string | null;
  freight_idempotency_key: string;
  field_confidence: string;
  record_slug: string;
  charges: { charge_code: string; amount: number; amount_missing: number }[];
}

async function readBack(name: string): Promise<WrittenDoc> {
  const res = await fetch(`${BASE}/api/resource/${encodeURIComponent(QUOTATION_DOCTYPE)}/${encodeURIComponent(name)}`, {
    headers,
  });
  expect(res.ok, `reading ${name} back returned ${res.status}`).toBe(true);
  return ((await res.json()) as { data: WrittenDoc }).data;
}

describe.skipIf(!configured)('against a real ERPNext instance', () => {
  beforeAll(() => {
    // Nobody should discover halfway through that this ran somewhere real.
    console.log(`[erpnext-instance] writing to ${BASE} as a test instance`);
  });

  it('reports the destination ready before writing anything', async () => {
    const probe = await erp().probe();
    expect(probe.connected, probe.detail).toBe(true);
    expect(probe.setupRequirements, probe.setupRequirements.join('; ')).toEqual([]);
  });

  it('writes a quotation that reads back intact', async () => {
    const key = `${KEY_PREFIX}-intact`;
    const result = await erp().recordQuotation(input(key));

    expect(result.simulated).toBe(false);
    const doc = await readBack(result.remoteName);

    expect(doc.freight_idempotency_key).toBe(key);
    expect(doc.base_freight).toBe(1640);
    expect(JSON.parse(doc.field_confidence)).toMatchObject({ base_freight: 'high' });
    expect(doc.charges).toHaveLength(2);
    expect(doc.charges.find((c) => c.charge_code === 'BAF')?.amount).toBe(185);
  });

  it('keeps an unstated number distinguishable from zero', async () => {
    const key = `${KEY_PREFIX}-missing`;
    const doc = await readBack((await erp().recordQuotation(input(key))).remoteName);

    // Frappe stores a Float as NOT NULL with a default of 0, so the number
    // itself cannot carry "not stated". These two columns are what do.
    const thc = doc.charges.find((c) => c.charge_code === 'THC-DEST');
    expect(thc?.amount_missing).toBe(1);
    expect(doc.charges.find((c) => c.charge_code === 'BAF')?.amount_missing).toBe(0);
    expect(doc.unstated_numbers ?? '').toContain('total_quoted_by_provider');
  });

  it('updates on a retry instead of writing a second record', async () => {
    const key = `${KEY_PREFIX}-retry`;
    const first = await erp().recordQuotation(input(key));
    const again = await erp().recordQuotation(input(key));

    expect(again.updatedExisting).toBe(true);
    expect(again.remoteName).toBe(first.remoteName);

    const filters = encodeURIComponent(JSON.stringify([['freight_idempotency_key', '=', key]]));
    const res = await fetch(
      `${BASE}/api/resource/${encodeURIComponent(QUOTATION_DOCTYPE)}?filters=${filters}&limit_page_length=0`,
      { headers },
    );
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it('gives two quotations sharing an RFQ, provider and version separate records', async () => {
    // The document name has to carry the key. Without that they collide, and
    // ERPNext reports a duplicate whose record cannot be found by key - a write
    // that then fails on every retry.
    const a = await erp().recordQuotation(input(`${KEY_PREFIX}-clash-a`));
    const b = await erp().recordQuotation(input(`${KEY_PREFIX}-clash-b`));

    expect(a.remoteName).not.toBe(b.remoteName);
    expect(b.updatedExisting).toBe(false);
  });

  it('records a revision separately from the version it replaces', async () => {
    const v1 = await erp().recordQuotation(input(`${KEY_PREFIX}-v1`));
    const v2 = await erp().recordQuotation(
      input(`${KEY_PREFIX}-v2`, quote({ version: 2, supersedesQuoteId: 'q1' })),
    );

    expect(v2.remoteName).not.toBe(v1.remoteName);
    expect((await readBack(v1.remoteName)).freight_idempotency_key).toBe(`${KEY_PREFIX}-v1`);
  });
});
