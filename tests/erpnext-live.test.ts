/**
 * The live ERPNext adapter (W3), against a faked Frappe.
 *
 * Nothing here touches the network. What is under test is the guard (no write
 * until the destination can hold the whole record), idempotency across
 * retries and races, and the proposed DocType agreeing with the payload.
 */

import { describe, expect, it } from 'vitest';
import { LiveErp, destinationProblems, erpPayload, type ErpRecordInput } from '@/freight/adapters/erpnext';
import { childDoctype, parentDoctype, PARENT, CHILD } from '../scripts/erpnext/freight-comparison-doctype.mjs';

const BASE = 'https://erp.mp-real.com';
const CFG = {
  baseUrl: BASE,
  apiKey: 'k',
  apiSecret: 's',
  doctype: PARENT,
  quotationDoctype: 'Freight Quotation',
  companyMap: {} as Record<string, string>,
};

const parentFields = parentDoctype({ module: 'Buying', supplierLink: false }).fields;
const childFields = childDoctype({ module: 'Buying' }).fields;

const INPUT = {
  idempotencyKey: 'key-123',
  company: { code: 'MPD', name: 'Mobility Pro Distribution' },
  rfq: { reference: 'RFQ-MPD-2026-0001', originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB' },
  comparison: {
    lines: [
      { quoteId: 'q1', companyProviderId: 'cp1', providerName: 'Suez Gateway', version: 2, comparable: true, totalInQuoteCurrency: 12165, quoteCurrency: 'USD', totalInBaseCurrency: 12165, transitDays: 24, freeDays: 14, validUntil: '2099-12-31', rank: 1, scoreTotal: 81.2 },
      { quoteId: 'q2', companyProviderId: 'cp2', providerName: 'Nile Star', version: 1, comparable: true, totalInQuoteCurrency: 11799, quoteCurrency: 'USD', totalInBaseCurrency: 11799, transitDays: 35, freeDays: 7, validUntil: '2099-12-31', rank: 2, scoreTotal: 74.0 },
    ],
    recommendedQuoteId: 'q1',
    cheapestQuoteId: 'q2',
    criteria: { baseCurrency: 'USD', weightCost: 60, weightTransit: 25, weightFreeDays: 15 },
    recommendationReasons: ['11 days faster'],
    recommendationTradeoffs: ['USD 366 more'],
    blockedNotes: [],
    fxRates: [],
  },
  providerNames: { cp1: 'Suez Gateway Shipping', cp2: 'Nile Star Logistics' },
  workbook: { filename: 'Freight comparison RFQ-MPD-2026-0001.xlsx', content: Buffer.from('xlsx') },
  comparisonDate: '2026-09-27',
} as unknown as ErpRecordInput;

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A tiny Frappe: DocType metadata, one resource collection, File, upload_file. */
function fakeFrappe(opts: {
  parent?: typeof parentFields | null;
  existing?: string | null;
  lookupStatus?: number;
  insertRace?: boolean;
  fileAttached?: boolean;
} = {}) {
  const calls: Call[] = [];
  let existing = opts.existing ?? null;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ? '[form]' : null;
    calls.push({ method, url, body });

    if (url.includes('/api/method/frappe.auth.get_logged_user')) return json({ message: 'api@mp-real.com' });
    if (url.includes('/api/method/frappe.utils.change_log.get_versions')) return json({ message: { erpnext: { version: '15.40.0' } } });
    if (url.endsWith(`/api/resource/DocType/${PARENT}`)) {
      return opts.parent === null ? json({}, 404) : json({ data: { fields: opts.parent ?? parentFields } });
    }
    if (url.endsWith(`/api/resource/DocType/${CHILD}`)) return json({ data: { fields: childFields } });
    if (url.includes(`/api/resource/${PARENT}?filters=`)) {
      if (opts.lookupStatus) return json({}, opts.lookupStatus);
      return json({ data: existing ? [{ name: existing }] : [] });
    }
    if (method === 'POST' && url.endsWith(`/api/resource/${PARENT}`)) {
      if (opts.insertRace) {
        existing = 'FC-2026-00007'; // the other retry got there first
        return json({ exc_type: 'DuplicateEntryError', exception: 'frappe.exceptions.DuplicateEntryError' }, 409);
      }
      existing = 'FC-2026-00001';
      return json({ data: { name: existing } });
    }
    if (method === 'PUT' && url.includes(`/api/resource/${PARENT}/`)) {
      return json({ data: { name: url.split('/').pop() } });
    }
    if (url.includes('/api/resource/File?filters=')) return json({ data: opts.fileAttached ? [{ name: 'f1' }] : [] });
    if (url.endsWith('/api/method/upload_file')) return json({ message: { name: 'f1' } });
    return json({ exception: `no route ${method} ${url}` }, 404);
  }) as typeof fetch;
  return { http, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method === 'POST' || c.method === 'PUT');

describe('the proposed DocType', () => {
  it('holds every field the application writes', () => {
    expect(destinationProblems(PARENT, parentFields, childFields, CHILD)).toEqual([]);
  });

  it('marks the idempotency key Unique, so ERPNext itself refuses a duplicate', () => {
    expect(parentFields.find((f) => f.fieldname === 'freight_idempotency_key')?.unique).toBe(1);
  });

  it('can link providers to Suppliers instead, if they already exist in ERPNext', () => {
    const linked = parentDoctype({ module: 'Buying', supplierLink: true }).fields.find((f) => f.fieldname === 'recommended_provider');
    expect(linked).toMatchObject({ fieldtype: 'Link', options: 'Supplier' });
  });
});

describe('the destination guard', () => {
  it('names every problem that would lose data or allow a duplicate', () => {
    const noKey = parentFields.filter((f) => f.fieldname !== 'freight_idempotency_key' && f.fieldname !== 'cheapest_total');
    const problems = destinationProblems(PARENT, noKey, childFields.filter((f) => f.fieldname !== 'rank'), CHILD);
    expect(problems.join('\n')).toMatch(/no freight_idempotency_key/);
    expect(problems.join('\n')).toMatch(/silently drop: cheapest_total/);
    expect(problems.join('\n')).toMatch(/child table is missing: rank/);

    const notUnique = parentFields.map((f) => (f.fieldname === 'freight_idempotency_key' ? { ...f, unique: 0 } : f));
    expect(destinationProblems(PARENT, notUnique, childFields, CHILD).join()).toMatch(/not marked Unique/);
  });

  it('writes nothing when the destination is not ready, and says what to fix', async () => {
    const { http, calls } = fakeFrappe({ parent: parentFields.filter((f) => f.fieldname !== 'offers') });
    const err = await new LiveErp(CFG, http).record(INPUT).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.setupRequirements.join()).toMatch(/no "offers" child table/);
    expect(writes(calls)).toEqual([]);
  });

  it('writes nothing when the DocType does not exist', async () => {
    const { http, calls } = fakeFrappe({ parent: null });
    const err = await new LiveErp(CFG, http).record(INPUT).catch((e) => e);
    expect(err.setupRequirements.join()).toMatch(/was not found.*erpnext-create-doctype/);
    expect(writes(calls)).toEqual([]);
  });

  it('still refuses without ERPNEXT_DOCTYPE, before contacting ERPNext at all', async () => {
    const { http, calls } = fakeFrappe();
    const err = await new LiveErp({ ...CFG, doctype: null }, http).record(INPUT).catch((e) => e);
    expect(err.message).toMatch(/No ERPNext destination has been agreed/);
    expect(calls).toEqual([]);
  });
});

describe('writing a comparison', () => {
  it('creates the record with the mapped company and attaches the workbook', async () => {
    const { http, calls } = fakeFrappe();
    const erp = new LiveErp({ ...CFG, companyMap: { MPD: 'Mobility Pro Distribution S.A.E.' } }, http);
    const result = await erp.record(INPUT);

    expect(result).toMatchObject({ doctype: PARENT, remoteName: 'FC-2026-00001', simulated: false, updatedExisting: false });
    const insert = writes(calls).find((c) => c.method === 'POST' && c.url.endsWith(`/api/resource/${PARENT}`))!;
    const body = insert.body as Record<string, any>;
    expect(body.company).toBe('Mobility Pro Distribution S.A.E.');
    expect(body.recommendation_status).toBe('Recommended, not selected');
    expect(body.recommended_provider).toBe('Suez Gateway Shipping');
    expect(body.cheapest_provider).toBe('Nile Star Logistics');
    expect(body.offers).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith('/api/method/upload_file'))).toBe(true);
  });

  it('updates rather than duplicates on a retry, and does not attach the workbook twice', async () => {
    const { http, calls } = fakeFrappe({ existing: 'FC-2026-00001', fileAttached: true });
    const result = await new LiveErp(CFG, http).record(INPUT);
    expect(result.updatedExisting).toBe(true);
    expect(writes(calls).map((c) => `${c.method} ${c.url.replace(BASE, '')}`)).toEqual([
      `PUT /api/resource/${PARENT}/FC-2026-00001`,
    ]);
  });

  it('recovers when another retry inserted first and the unique index refused this one', async () => {
    const { http, calls } = fakeFrappe({ insertRace: true });
    const result = await new LiveErp(CFG, http).record(INPUT);
    expect(result).toMatchObject({ remoteName: 'FC-2026-00007', updatedExisting: true });
    expect(writes(calls).filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('does not insert blind when the duplicate check fails', async () => {
    const { http, calls } = fakeFrappe({ lookupStatus: 502 });
    const err = await new LiveErp(CFG, http).record(INPUT).catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/to avoid a duplicate/);
    expect(writes(calls)).toEqual([]);
  });

  it('keeps the payload mapping in one reviewable place', () => {
    expect(Object.keys(erpPayload(INPUT))).toContain('freight_idempotency_key');
  });
});

describe('checking the connection', () => {
  /** This fake serves the comparison DocType only. */
  const comparisonOnly = { ...CFG, quotationDoctype: '' };

  it('says connected and ready only when the destination can hold the record', async () => {
    const ready = await new LiveErp(comparisonOnly, fakeFrappe().http).probe();
    expect(ready).toMatchObject({ label: 'ERPNext connected', connected: true, setupRequirements: [], version: '15.40.0' });

    const notReady = await new LiveErp(comparisonOnly, fakeFrappe({ parent: parentFields.map((f) => (f.fieldname === 'freight_idempotency_key' ? { ...f, unique: 0 } : f)) }).http).probe();
    expect(notReady.label).toBe('ERPNext connected, destination not ready');
    expect(notReady.setupRequirements.join()).toMatch(/not marked Unique/);
  });

  it('is ready on one destination while still reporting what the other needs', async () => {
    // Found against a real instance: an instance holding the raw quotations is
    // usable even where the comparison DocType was never created, and calling
    // that "not ready" would be wrong - but the gap still has to be said.
    const probed = await new LiveErp(CFG, fakeFrappe().http).probe();

    expect(probed.label).toBe('ERPNext connected');
    expect(probed.setupRequirements.join()).toMatch(/Freight Quotation/);
  });

  it('refuses to call itself ready when nothing is configured', async () => {
    const probed = await new LiveErp({ ...CFG, doctype: '', quotationDoctype: '' }, fakeFrappe().http).probe();

    expect(probed.connected).toBe(true);
    expect(probed.label).toBe('ERPNext connected, destination not ready');
    expect(probed.setupRequirements.join()).toMatch(/Neither ERPNEXT_QUOTATION_DOCTYPE nor ERPNEXT_DOCTYPE/);
  });
});
