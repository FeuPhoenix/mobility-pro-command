/**
 * Filing a reply is all-or-nothing.
 *
 * Before, the message row was written first and the quotation afterwards, so a
 * crash in between left a reply that every later collection run skipped as
 * "already collected", with no quotation ever created.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ failNext: 0 }));

vi.mock('@/freight/domain/extraction', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/freight/domain/extraction')>();
  return {
    ...real,
    extractQuote: (...args: Parameters<typeof real.extractQuote>) => {
      if (control.failNext > 0) {
        control.failNext -= 1;
        return Promise.reject(new Error('parser crashed'));
      }
      return real.extractQuote(...args);
    },
  };
});

import { openMemoryDb, useDb } from '@/freight/db';
import { insertUser, listAudit, listCompanyProviders, listInbound, listQuotes, newId, type Ctx } from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import { createRfq, prepareRfqEmails, setRecipients } from '@/freight/service/rfq';
import { approveEmail, sendEmail } from '@/freight/service/mail';
import { assignMessage, ingestMessage } from '@/freight/service/inbox';
import { collectInbox } from '@/freight/service/collect';
import { SimulatedMailbox } from '@/freight/adapters/mailbox';
import type { Rfq, User } from '@/freight/types';

let manager: Ctx;
let company: string;

async function sentRfq(): Promise<Rfq> {
  const rfq = createRfq(manager, {
    companyId: company, title: 'Test', originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB',
    containers: [{ type: '40HC', quantity: 1, grossWeightKg: 20_000, commodity: 'Tyres' }],
    cargoNotes: null, targetShipFrom: '2099-01-10', targetShipTo: '2099-01-24',
    responseDeadline: '2099-01-05T17:00:00.000Z', instructions: null, requestedCurrency: 'USD',
  });
  setRecipients(manager, rfq.id, [listCompanyProviders(manager, company)[0].link.id]);
  for (const e of prepareRfqEmails(manager, rfq.id)) {
    approveEmail(manager, e.id);
    await sendEmail(manager, e.id);
  }
  return rfq;
}

const BODY = 'Base ocean freight: USD 1200.00 per 40HC\nTransit time: 30 days';

beforeEach(() => {
  useDb(openMemoryDb());
  SimulatedMailbox.reset();
  control.failNext = 0;
  const boot: Ctx = { user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@x.test', role: 'logistics_manager', companyIds: [] } };
  company = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['1'] }).id;
  const u: User = { id: newId('usr'), name: 'Manager', title: 'm', email: 'm@x.test', role: 'logistics_manager', companyIds: [company] };
  insertUser(u);
  manager = { user: u };
  upsertProvider(manager, company, {
    name: 'Alpha Lines', kind: 'Carrier', country: 'Egypt', website: null, generalEmail: null, notes: null,
    status: 'active', restrictionReason: null, accountRef: null, lanes: [],
    contacts: [{ name: 'Ann', email: 'ann@alpha.test', role: null, isPrimary: true }],
  });
});

describe('filing a reply', () => {
  it('leaves nothing behind when reading the quotation fails, so the next run files it properly', async () => {
    const rfq = await sentRfq();
    SimulatedMailbox.deliver({
      externalId: '<crash@alpha.test>', threadId: null, inReplyTo: null, fromEmail: 'ann@alpha.test', fromName: null,
      subject: `RE: ${rfq.reference}`, receivedAt: new Date().toISOString(), bodyText: BODY, attachments: [],
    });

    control.failNext = 1;
    const first = await collectInbox({ trigger: 'schedule' });
    expect(first.outcome).toBe('failed');
    expect(first.error).toMatch(/parser crashed/);
    expect(listInbound(manager)).toEqual([]);
    expect(listAudit(manager).some((e) => e.action === 'inbox.received')).toBe(false);

    const second = await collectInbox({ trigger: 'schedule' });
    expect(second).toMatchObject({ outcome: 'ok', filed: 1, matched: 1, duplicates: 0 });
    expect(listInbound(manager).length).toBe(1);
    const quotes = listQuotes(manager, rfq.id);
    expect(quotes.length).toBe(1);
    expect(quotes[0].baseFreight.value).toBe(1200);
  });

  it('keeps a reply in the review queue when attaching it fails, so a person can try again', async () => {
    const a = await sentRfq();
    await sentRfq(); // a second open request makes the reference-less reply ambiguous
    const { message } = await ingestMessage(manager, {
      externalId: '<amb@alpha.test>', threadId: null, inReplyTo: null, fromEmail: 'ann@alpha.test', fromName: null,
      subject: 'Our rate', receivedAt: new Date().toISOString(), bodyText: BODY, attachments: [], simulated: true,
    });
    expect(message.matchStatus).toBe('ambiguous');
    const providerId = listCompanyProviders(manager, company)[0].link.id;

    control.failNext = 1;
    await expect(assignMessage(manager, message.id, a.id, providerId)).rejects.toThrow(/parser crashed/);
    expect(listInbound(manager)[0].matchStatus).toBe('ambiguous');
    expect(listQuotes(manager, a.id)).toEqual([]);

    const retry = await assignMessage(manager, message.id, a.id, providerId);
    expect(retry.quote?.baseFreight.value).toBe(1200);
    expect(listInbound(manager)[0].matchStatus).toBe('matched');
  });
});
