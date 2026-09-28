/**
 * The live quotation write, against a real HTTP server behaving like Frappe.
 *
 * The other live test injects a fake `fetch`. This one runs the adapter's real
 * network path - URL building, the token header, query encoding, status
 * handling - against a small server that keeps records in a map and enforces a
 * unique index on `freight_idempotency_key`, the way ERPNext will.
 *
 * It is still not ERPNext. What it proves is that our side speaks the protocol
 * it thinks it does; only a write against their instance proves the rest.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LiveErp, ErpFailure } from '@/freight/adapters/erpnext';
import { parentDoctype, childDoctype, PARENT, CHILD } from '../scripts/erpnext/freight-quotation-doctype.mjs';
import type { Company, Quote, Rfq } from '@/freight/types';

/* --------------------------------- A small Frappe ------------------------------ */

interface Doc {
  name: string;
  freight_idempotency_key: string;
  [key: string]: unknown;
}

const state = {
  docs: new Map<string, Doc>(),
  /** Drops one field from the served DocType metadata. */
  missingField: null as string | null,
  lookupStatus: 200,
  /** Serves an insert that loses a race with another writer. */
  raceOnInsert: false,
  requests: [] as { method: string; url: string; auth: string | undefined }[],
};

let server: Server;
let base = '';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    req.on('data', (c) => (out += c));
    req.on('end', () => resolve(out));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    state.requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    // Frappe rejects an unauthenticated call before anything else does.
    if (req.headers.authorization !== 'token k:s') return json(401, { message: 'Not permitted' });

    if (url.pathname === '/api/method/frappe.auth.get_logged_user') {
      return json(200, { message: 'freight@mobilitypro.test' });
    }

    if (url.pathname === `/api/resource/DocType/${encodeURIComponent(PARENT)}`) {
      const fields = parentDoctype({ module: 'Freight', supplierLink: false }).fields.filter(
        (f) => f.fieldname !== state.missingField,
      );
      return json(200, { data: { fields } });
    }
    if (url.pathname === `/api/resource/DocType/${encodeURIComponent(CHILD)}`) {
      return json(200, { data: { fields: childDoctype({ module: 'Freight' }).fields } });
    }

    const collection = `/api/resource/${encodeURIComponent(PARENT)}`;

    // The idempotency lookup.
    if (req.method === 'GET' && url.pathname === collection) {
      if (state.lookupStatus !== 200) return json(state.lookupStatus, { message: 'upstream trouble' });
      const filters = JSON.parse(url.searchParams.get('filters') ?? '[]') as [string, string, string][];
      const key = filters.find((f) => f[0] === 'freight_idempotency_key')?.[2];
      const hit = [...state.docs.values()].find((d) => d.freight_idempotency_key === key);
      return json(200, { data: hit ? [{ name: hit.name }] : [] });
    }

    if (req.method === 'POST' && url.pathname === collection) {
      const doc = JSON.parse(await readBody(req)) as Doc;
      if (state.raceOnInsert) {
        // Another writer inserted first: the unique index refuses this one, and
        // the record it lost to is now there to be found.
        state.docs.set('FQ-RACE', { ...doc, name: 'FQ-RACE' });
        state.raceOnInsert = false;
        return json(409, { exception: 'frappe.exceptions.DuplicateEntryError: Freight Quotation' });
      }
      if ([...state.docs.values()].some((d) => d.freight_idempotency_key === doc.freight_idempotency_key)) {
        return json(409, { exception: 'frappe.exceptions.DuplicateEntryError' });
      }
      const name = `FQ-${state.docs.size + 1}`;
      state.docs.set(name, { ...doc, name });
      return json(200, { data: { name } });
    }

    if (req.method === 'PUT' && url.pathname.startsWith(`${collection}/`)) {
      const name = decodeURIComponent(url.pathname.slice(collection.length + 1));
      const existing = state.docs.get(name);
      if (!existing) return json(404, { message: 'Not found' });
      state.docs.set(name, { ...existing, ...(JSON.parse(await readBody(req)) as Doc), name });
      return json(200, { data: { name } });
    }

    return json(404, { message: `no route for ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  state.docs.clear();
  state.missingField = null;
  state.lookupStatus = 200;
  state.raceOnInsert = false;
  state.requests = [];
});

/* ----------------------------------- Fixtures ---------------------------------- */

const erp = () =>
  new LiveErp({
    baseUrl: base,
    apiKey: 'k',
    apiSecret: 's',
    doctype: 'Freight Comparison',
    quotationDoctype: PARENT,
    companyMap: {} as Record<string, string>,
  });

const field = <T>(value: T | null) => ({
  value,
  confidence: (value === null ? 'missing' : 'high') as never,
  sourceRef: 'email body, line 5',
  sourceText: null,
  correctedBy: null,
  correctedAt: null,
  note: null,
});

const company = { id: 'co1', code: 'MPD', name: 'Mobility Pro Distribution S.A.E.' } as Company;
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
    shippingLine: field('Oriental Star'),
    originPort: field('CNSHA'),
    destinationPort: field('EGALY'),
    currency: field('USD'),
    containerBasis: field('40HC'),
    baseFreight: field(1640),
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
    ],
    totalQuoted: field(null),
    transitDays: field(38),
    freeDaysDestination: field(3),
    validUntil: field('2099-12-31'),
    sailingDate: field('2026-11-14'),
    paymentTerms: field('30 days'),
    inclusions: field([]),
    exclusions: field([]),
    conditions: field([]),
    extractorId: 'deterministic/text@1',
    extractedAt: '2026-09-21T00:00:00.000Z',
    reviewedBy: 'u1',
    reviewedAt: '2026-09-22T00:00:00.000Z',
    createdAt: '2026-09-21T00:00:00.000Z',
    ...over,
  }) as Quote;

const input = (key = 'key-1', q = quote()) => ({
  idempotencyKey: key,
  company,
  rfq,
  quote: q,
  providerName: 'Nile Star Logistics',
  supplierName: null,
  attempt: 1,
});

/* ------------------------------------ Tests ------------------------------------ */

describe('the real HTTP path', () => {
  it('writes a quotation and reads back the name ERPNext gave it', async () => {
    const result = await erp().recordQuotation(input());

    expect(result.simulated).toBe(false);
    expect(result.doctype).toBe(PARENT);
    expect(result.remoteName).toBe('FQ-1');
    expect(result.remoteUrl).toBe(`${base}/app/freight-quotation/FQ-1`);
    expect(result.updatedExisting).toBe(false);

    // Every call carried the token header; Frappe would have refused otherwise.
    expect(state.requests.every((r) => r.auth === 'token k:s')).toBe(true);
  });

  it('sends a charge with no amount as null, over the wire', async () => {
    await erp().recordQuotation(input());
    const written = state.docs.get('FQ-1') as Doc & { charges: { amount: unknown }[] };

    // Through real JSON, where undefined would have vanished and zero would lie.
    expect(written.charges[0]).toHaveProperty('amount');
    expect(written.charges[0].amount).toBeNull();
    expect(written.base_freight).toBe(1640);
    expect(written.total_quoted_by_provider).toBeNull();
  });
});

describe('a retry does not duplicate', () => {
  it('updates the record the first attempt wrote', async () => {
    await erp().recordQuotation(input());
    const again = await erp().recordQuotation(input());

    expect(again.updatedExisting).toBe(true);
    expect(again.remoteName).toBe('FQ-1');
    expect(state.docs.size).toBe(1);
  });

  it('recovers when another writer won the race', async () => {
    state.raceOnInsert = true;
    const result = await erp().recordQuotation(input());

    // The insert was refused by the unique index; it found the winner and
    // updated that, rather than failing or writing a second record.
    expect(result.updatedExisting).toBe(true);
    expect(result.remoteName).toBe('FQ-RACE');
    expect(state.docs.size).toBe(1);
  });

  it('writes nothing at all when the lookup itself fails', async () => {
    state.lookupStatus = 503;
    await expect(erp().recordQuotation(input())).rejects.toThrow(/nothing was written/i);

    expect(state.docs.size).toBe(0);
    // Inserting blind after a failed lookup is how a retry creates a duplicate.
    expect(state.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('keeps separate records for separate versions', async () => {
    await erp().recordQuotation(input('key-v1'));
    await erp().recordQuotation(input('key-v2', quote({ version: 2, supersedesQuoteId: 'q1' })));
    expect(state.docs.size).toBe(2);
  });
});

describe('the destination is checked before every write', () => {
  it('refuses when the DocType is missing a field, rather than losing it', async () => {
    // Frappe drops unknown fields silently, so a gap here would report success
    // while losing the column.
    state.missingField = 'base_freight';

    const err = await erp()
      .recordQuotation(input())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ErpFailure);
    expect((err as ErpFailure).retryable).toBe(false);
    expect((err as ErpFailure).setupRequirements.join(' ')).toMatch(/base_freight/);
    expect(state.docs.size).toBe(0);
  });
});

describe('the connection check', () => {
  it('reports connected only after the instance answers', async () => {
    const adapter = erp();
    expect(adapter.status().connected).toBe(false);

    const probed = await adapter.probe();
    expect(probed.connected).toBe(true);
    expect(probed.kind).toBe('live');
  });
});
