/**
 * Syncing quotations to ERPNext.
 *
 * The behaviours that matter operationally: unchecked quotations are never
 * sent, a retry does not duplicate, a success is not repeated, and a revision
 * is its own record rather than overwriting the offer it replaced.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb, setSetting } from '@/freight/db';
import { insertUser, listCompanyProviders, listQuotes, newId, type Ctx } from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import { createRfq, prepareRfqEmails, setRecipients } from '@/freight/service/rfq';
import { approveEmail, sendEmail } from '@/freight/service/mail';
import { ingestMessage, reviewQuote } from '@/freight/service/inbox';
import {
  listQuoteSyncs,
  quoteKey,
  quoteSyncFor,
  syncQuotation,
  syncRfqQuotations,
} from '@/freight/service/erpQuotations';
import { SimulatedErp } from '@/freight/adapters/erpnext';
import type { Rfq, User } from '@/freight/types';

let manager: Ctx;
let companyId: string;

const QUOTE = (ref: string, freight: number) => `Quotation for ${ref}

Shipping line: Test Line
Base ocean freight: USD ${freight}.00 per 40HC
BAF: USD 100.00 per container
Transit time: 25 days
Valid until: 2099-12-31
`;

function linkFor(name: string): string {
  const found = listCompanyProviders(manager, companyId).find((p) => p.provider.name === name);
  if (!found) throw new Error(`no provider ${name}`);
  return found.link.id;
}

async function rfqWithQuote(freight = 1500): Promise<Rfq> {
  const rfq = createRfq(manager, {
    companyId,
    title: 'Sync test',
    originPort: 'CNSHA',
    destinationPort: 'EGALY',
    incoterm: 'FOB',
    containers: [{ type: '40HC', quantity: 3, grossWeightKg: null, commodity: 'Tyres' }],
    cargoNotes: null,
    targetShipFrom: '2099-01-10',
    targetShipTo: '2099-01-24',
    responseDeadline: '2099-01-05T17:00:00.000Z',
    instructions: null,
    requestedCurrency: 'USD',
  });
  setRecipients(manager, rfq.id, [linkFor('Alpha Lines')]);
  for (const e of prepareRfqEmails(manager, rfq.id)) {
    approveEmail(manager, e.id);
    await sendEmail(manager, e.id);
  }
  await ingestMessage(manager, {
    externalId: `m-${rfq.id}`,
    threadId: null,
    inReplyTo: null,
    fromEmail: 'ann@alpha.test',
    fromName: null,
    subject: `RE: ${rfq.reference}`,
    receivedAt: new Date().toISOString(),
    bodyText: QUOTE(rfq.reference, freight),
    attachments: [],
    simulated: true,
  });
  return rfq;
}

beforeEach(() => {
  useDb(openMemoryDb());
  SimulatedErp.reset();
  const boot: Ctx = {
    user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@test.test', role: 'logistics_manager', companyIds: [] },
  };
  companyId = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['L1'] }).id;

  const u: User = {
    id: newId('usr'), name: 'Hala', title: 'Logistics Operations Manager',
    email: 'hala@test.test', role: 'logistics_manager', companyIds: [companyId],
  };
  insertUser(u);
  manager = { user: u };

  upsertProvider(manager, companyId, {
    name: 'Alpha Lines', kind: 'Carrier', country: 'Egypt', website: null,
    generalEmail: 'ops@alpha.test', notes: null, status: 'active', restrictionReason: null,
    accountRef: null, lanes: [], contacts: [{ name: 'Ann', email: 'ann@alpha.test', role: null, isPrimary: true }],
  });
});

describe('only checked quotations are sent', () => {
  it('refuses one nobody has checked, and says why', async () => {
    const rfq = await rfqWithQuote();
    const quote = listQuotes(manager, rfq.id)[0];
    expect(quote.status).toBe('needs_review');

    const outcome = await syncQuotation(manager, quote.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toMatch(/have not been checked/i);
    expect(outcome.sync.status).toBe('pending');
  });

  it('sends it once it has been confirmed', async () => {
    const rfq = await rfqWithQuote();
    const quote = listQuotes(manager, rfq.id)[0];
    reviewQuote(manager, quote.id, { fields: [], confirm: true });

    const outcome = await syncQuotation(manager, quote.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.sync.status).toBe('success');
    expect(outcome.sync.adapter).toBe('simulated');
    expect(outcome.sync.remoteName).toBeTruthy();
  });
});

describe('retries and duplicates', () => {
  it('recovers on a retry without a second record', async () => {
    setSetting('demo.erpFailFirst', true);
    const rfq = await rfqWithQuote();
    const quote = listQuotes(manager, rfq.id)[0];
    reviewQuote(manager, quote.id, { fields: [], confirm: true });

    const first = await syncQuotation(manager, quote.id);
    expect(first.ok).toBe(false);
    expect(first.retryable).toBe(true);
    expect(first.sync.status).toBe('failed');

    const second = await syncQuotation(manager, quote.id);
    expect(second.ok).toBe(true);
    expect(second.sync.attempts).toBe(2);
    // Same key across both attempts is what makes the retry safe.
    expect(second.sync.idempotencyKey).toBe(first.sync.idempotencyKey);
    expect(listQuoteSyncs(manager)).toHaveLength(1);
  });

  it('does not send a quotation that has already been recorded', async () => {
    const rfq = await rfqWithQuote();
    const quote = listQuotes(manager, rfq.id)[0];
    reviewQuote(manager, quote.id, { fields: [], confirm: true });

    const first = await syncQuotation(manager, quote.id);
    const again = await syncQuotation(manager, quote.id);
    expect(again.ok).toBe(true);
    expect(again.sync.attempts).toBe(first.sync.attempts);
  });

  it('keys each quotation separately', async () => {
    expect(quoteKey('q1')).not.toBe(quoteKey('q2'));
    expect(quoteKey('q1')).toBe(quoteKey('q1'));
  });
});

describe('revisions', () => {
  it('records a revision as its own row, leaving the first alone', async () => {
    const rfq = await rfqWithQuote(1500);
    const v1 = listQuotes(manager, rfq.id)[0];
    reviewQuote(manager, v1.id, { fields: [], confirm: true });
    await syncQuotation(manager, v1.id);

    // A revised quotation from the same provider.
    await ingestMessage(manager, {
      externalId: 'revised-1',
      threadId: null,
      inReplyTo: null,
      fromEmail: 'ann@alpha.test',
      fromName: null,
      subject: `REVISED: ${rfq.reference}`,
      receivedAt: new Date().toISOString(),
      bodyText: QUOTE(rfq.reference, 1400),
      attachments: [],
      simulated: true,
    });

    const v2 = listQuotes(manager, rfq.id).find((q) => q.version === 2)!;
    reviewQuote(manager, v2.id, { fields: [], confirm: true });
    await syncQuotation(manager, v2.id);

    const syncs = listQuoteSyncs(manager);
    expect(syncs).toHaveLength(2);
    // The first record is untouched: a revision adds, it does not overwrite.
    expect(quoteSyncFor(v1.id)?.status).toBe('success');
    expect(quoteSyncFor(v2.id)?.status).toBe('success');
    expect(quoteSyncFor(v1.id)?.remoteName).not.toBe(quoteSyncFor(v2.id)?.remoteName);
  });

  it('will not send a superseded version that was never recorded', async () => {
    const rfq = await rfqWithQuote(1500);
    await ingestMessage(manager, {
      externalId: 'revised-2',
      threadId: null,
      inReplyTo: null,
      fromEmail: 'ann@alpha.test',
      fromName: null,
      subject: `REVISED: ${rfq.reference}`,
      receivedAt: new Date().toISOString(),
      bodyText: QUOTE(rfq.reference, 1400),
      attachments: [],
      simulated: true,
    });
    const v1 = listQuotes(manager, rfq.id).find((q) => q.version === 1)!;
    expect(v1.status).toBe('superseded');

    const outcome = await syncQuotation(manager, v1.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toMatch(/replaced by a later/i);
  });
});

describe('syncing a whole request', () => {
  it('reports what went, what failed and what was not eligible', async () => {
    const rfq = await rfqWithQuote();
    const summary = await syncRfqQuotations(manager, rfq.id);

    // Nothing confirmed yet, so nothing goes.
    expect(summary.recorded).toBe(0);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].providerName).toBe('Alpha Lines');
    expect(summary.skipped[0].reason).toMatch(/have not been checked/i);

    for (const q of listQuotes(manager, rfq.id)) {
      reviewQuote(manager, q.id, { fields: [], confirm: true });
    }
    const after = await syncRfqQuotations(manager, rfq.id);
    expect(after.recorded).toBe(1);
    expect(after.skipped).toHaveLength(0);
    expect(after.failed).toBe(0);
  });

  it('refuses a request with no quotations rather than reporting success', async () => {
    const rfq = createRfq(manager, {
      companyId, title: 'Empty', originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB',
      containers: [{ type: '40HC', quantity: 1, grossWeightKg: null, commodity: 'x' }],
      cargoNotes: null, targetShipFrom: '2099-01-10', targetShipTo: '2099-01-24',
      responseDeadline: '2099-01-05T17:00:00.000Z', instructions: null, requestedCurrency: 'USD',
    });
    await expect(syncRfqQuotations(manager, rfq.id)).rejects.toThrow(/No quotations/i);
  });
});

describe('company isolation', () => {
  it('does not list another company’s records', async () => {
    const rfq = await rfqWithQuote();
    const quote = listQuotes(manager, rfq.id)[0];
    reviewQuote(manager, quote.id, { fields: [], confirm: true });
    await syncQuotation(manager, quote.id);

    const outsider: Ctx = {
      user: {
        id: newId('usr'), name: 'Outsider', title: 'x', email: 'o@test.test',
        role: 'logistics_manager', companyIds: ['co_other'],
      },
    };
    expect(listQuoteSyncs(outsider)).toHaveLength(0);
    expect(listQuoteSyncs(manager)).toHaveLength(1);
  });
});
