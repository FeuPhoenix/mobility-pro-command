/**
 * Starting an RFQ from an email (W5).
 *
 * The parsers get a test per format people actually write, as the handover
 * asks: the quotation parsers were bitten by a format the fixtures never used.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb } from '@/freight/db';
import { insertUser, listAudit, listEmails, listRecipients, listRfqRequests, listRfqs, newId, type Ctx } from '@/freight/repo';
import { createCompany } from '@/freight/service/providers';
import { collectInbox } from '@/freight/service/collect';
import { dismissRfqRequest, isRfqRequest } from '@/freight/service/intake';
import { SimulatedMailbox } from '@/freight/adapters/mailbox';
import { readCells } from '@/freight/parsers/excel';
import { buildRfqTemplate } from '@/freight/excel/workbook';
import { dayFrom, deadlineFrom, looksLikeRfqTemplate, parseContainerLine, parseRequestSheet, parseRequestText } from '@/freight/parsers/rfqRequest';
import type { IncomingMail } from '@/freight/service/inbox';
import type { User } from '@/freight/types';

const EMAIL = `Hi team,

Please raise an RFQ for this one.

Title: Tyre import, North China to Alexandria
Origin port: CNSHA
Destination port: EGALY
Incoterm: FOB
Containers: 6 x 40HC, Passenger car tyres, 21,500 kg
Containers: 2 × 20GP, Truck tyres
Ship from: 2099-11-10
Ship to: 2099-11-24
Reply by: 2099-10-06
Currency: usd
Cargo notes: Stackable, no hazardous classification.

Thanks,
Ann`;

/* --------------------------------- Parsers ----------------------------------- */

describe('reading a requirement from an email', () => {
  it('reads the documented format', () => {
    const p = parseRequestText(EMAIL);
    expect(p.problems).toEqual([]);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]).toMatchObject({
      title: 'Tyre import, North China to Alexandria',
      originPort: 'CNSHA',
      destinationPort: 'EGALY',
      incoterm: 'FOB',
      targetShipFrom: '2099-11-10',
      targetShipTo: '2099-11-24',
      responseDeadline: '2099-10-06T15:00:00.000Z',
      requestedCurrency: 'USD',
      cargoNotes: 'Stackable, no hazardous classification.',
      instructions: null,
    });
    expect(p.requests[0].containers).toEqual([
      { type: '40HC', quantity: 6, grossWeightKg: 21500, commodity: 'Passenger car tyres' },
      { type: '20GP', quantity: 2, grossWeightKg: null, commodity: 'Truck tyres' },
    ]);
  });

  it.each([
    ['6 x 40HC, tyres, 21500 kg', { type: '40HC', quantity: 6, grossWeightKg: 21500, commodity: 'tyres' }],
    ['6x40hc, tyres', { type: '40HC', quantity: 6, grossWeightKg: null, commodity: 'tyres' }],
    ['40HC x 3, rims, 18 t', { type: '40HC', quantity: 3, grossWeightKg: 18000, commodity: 'rims' }],
    ['1 * 20RF, frozen, 1,200.5 kg', { type: '20RF', quantity: 1, grossWeightKg: 1200.5, commodity: 'frozen' }],
    ['12 x 20GP, tyres, rims, 9000 kgs', { type: '20GP', quantity: 12, grossWeightKg: 9000, commodity: 'tyres, rims' }],
  ])('reads the container line "%s"', (line, expected) => {
    expect(parseContainerLine(line)).toEqual(expected);
  });

  it('explains a container line it cannot read', () => {
    expect(parseContainerLine('six forty-footers')).toMatch(/not a container line/);
  });

  it('accepts the usual label synonyms and day-first dates', () => {
    const p = parseRequestText(`Company: mpd
Requirement: Rims
POL: cnsha
POD: egaly
Incoterms: cfr
Equipment: 2 x 40HC, rims
Target ship from: 10/11/2099
Target ship to: 24.11.2099
Respond by: 2099-10-06T12:00:00Z`);
    expect(p.problems).toEqual([]);
    expect(p.companyCode).toBe('MPD');
    expect(p.requests[0]).toMatchObject({
      originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'CFR',
      targetShipFrom: '2099-11-10', targetShipTo: '2099-11-24', responseDeadline: '2099-10-06T12:00:00.000Z',
    });
  });

  it('lists every missing line instead of guessing', () => {
    const p = parseRequestText('Title: Something\nOrigin port: CNSHA');
    expect(p.requests).toEqual([]);
    const all = p.problems.join('\n');
    for (const label of ['Destination port', 'Incoterm', 'Containers', 'Ship from', 'Ship to', 'Reply by']) {
      expect(all).toContain(label);
    }
  });

  it('ignores quoted text below a forwarded message', () => {
    const p = parseRequestText(`${EMAIL}\n> Origin port: XXXXX\n> Containers: 99 x 45HC, junk`);
    expect(p.requests[0].originPort).toBe('CNSHA');
    expect(p.requests[0].containers).toHaveLength(2);
  });

  it('reads dates the ways people write them, and rejects the ambiguous', () => {
    expect(dayFrom('2099-01-05')).toBe('2099-01-05');
    expect(dayFrom('5/1/2099')).toBe('2099-01-05');
    expect(dayFrom('13/13/2099')).toBeNull();
    expect(dayFrom('next Tuesday')).toBeNull();
    expect(deadlineFrom('2099-01-05')).toBe('2099-01-05T15:00:00.000Z');
  });
});

describe('reading the Excel template', () => {
  it('reads the template as downloaded, combining rows into one request', async () => {
    const cells = await readCells(await buildRfqTemplate(), 'rfq.xlsx');
    expect(looksLikeRfqTemplate(cells)).toBe(true);
    const p = parseRequestSheet(cells, 'rfq.xlsx');
    expect(p.problems).toEqual([]);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0].containers.map((c) => `${c.quantity}x${c.type}`)).toEqual(['6x40HC', '2x20GP']);
    expect(p.requests[0].responseDeadline).toBe('2026-10-06T15:00:00.000Z');
  });

  it('names the row that is wrong', () => {
    const cell = (row: number, col: number, text: string) => ({ sheet: 'S', row, col, text, numeric: null, date: null });
    const heads = ['Title', 'Origin port', 'Destination port', 'Incoterm', 'Container type', 'Quantity', 'Commodity', 'Target ship from', 'Target ship to', 'Response deadline', 'Quote currency'];
    const cells = [
      ...heads.map((h, i) => cell(1, i + 1, h)),
      ...['T', 'CNSHA', 'EGALY', 'FOB', '40HC', 'six', 'tyres', '2099-01-10', '2099-01-20', '2099-01-05', 'USD'].map((v, i) => cell(2, i + 1, v)),
    ];
    expect(parseRequestSheet(cells, 'x.xlsx').problems).toEqual(['x.xlsx row 2: the quantity is not a number.']);
  });
});

/* ----------------------------- Through collection ---------------------------- */

let companyA: string;
let companyB: string;
let ann: Ctx;

function person(name: string, role: User['role'], companyIds: string[]): Ctx {
  const u: User = { id: newId('usr'), name, title: role, email: `${name.split(' ')[0].toLowerCase()}@mp-real.com`, role, companyIds };
  insertUser(u);
  return { user: u };
}

function mail(over: Partial<IncomingMail> & { externalId: string }): Omit<IncomingMail, 'simulated'> {
  return {
    threadId: null, inReplyTo: null, fromEmail: 'ann@mp-real.com', fromName: null, subject: 'New RFQ - tyres',
    receivedAt: new Date().toISOString(), bodyText: EMAIL, attachments: [], ...over,
  };
}

beforeEach(() => {
  useDb(openMemoryDb());
  SimulatedMailbox.reset();
  process.env.RFQ_EMAIL_INTAKE = 'on';
  const boot: Ctx = { user: { id: 'boot', name: 'Boot', title: 'b', email: 'boot@x.test', role: 'logistics_manager', companyIds: [] } };
  companyA = createCompany(boot, { code: 'MPD', name: 'Distribution', country: 'Egypt', addressLines: ['1'] }).id;
  companyB = createCompany(boot, { code: 'MPI', name: 'Industrial', country: 'Egypt', addressLines: ['1'] }).id;
  ann = person('Ann Manager', 'logistics_manager', [companyA]);
});

afterEach(() => {
  delete process.env.RFQ_EMAIL_INTAKE;
});

describe('an emailed request', () => {
  it('is off unless switched on', () => {
    delete process.env.RFQ_EMAIL_INTAKE;
    expect(isRfqRequest({ ...mail({ externalId: 'x' }), simulated: true })).toBe(false);
  });

  it('is recognised only from a workspace person, with the subject asking for one, and not in a reply', () => {
    const m = (over: Partial<IncomingMail>) => ({ ...mail({ externalId: 'x', ...over }), simulated: true });
    expect(isRfqRequest(m({}))).toBe(true);
    expect(isRfqRequest(m({ fromEmail: 'sales@provider.com' }))).toBe(false);
    expect(isRfqRequest(m({ subject: 'Re: New RFQ - tyres' }))).toBe(false);
    expect(isRfqRequest(m({ subject: 'New RFQ RFQ-MPD-2026-0001 revised' }))).toBe(false);
    expect(isRfqRequest(m({ subject: 'Lunch?' }))).toBe(false);
  });

  it('becomes a draft RFQ in the sender\'s name, with no providers chosen and nothing sent', async () => {
    SimulatedMailbox.deliver(mail({ externalId: '<req-1@mp-real.com>' }));
    const run = await collectInbox({ trigger: 'schedule' });
    expect(run).toMatchObject({ outcome: 'ok', rfqRequests: 1, filed: 0 });

    const [rfq] = listRfqs(ann);
    expect(rfq).toMatchObject({ status: 'draft', companyId: companyA, createdBy: ann.user.id, originPort: 'CNSHA' });
    expect(rfq.reference).toMatch(/^RFQ-MPD-/);
    expect(listRecipients(rfq.id)).toEqual([]);
    expect(listEmails(ann, { rfqId: rfq.id })).toEqual([]);

    const [request] = listRfqRequests(ann);
    expect(request).toMatchObject({ status: 'created', rfqIds: [rfq.id], problems: [] });
    expect(listAudit(ann).some((e) => e.action === 'rfq.requested_by_email' && e.actorName === 'Ann Manager')).toBe(true);
  });

  it('is not processed twice', async () => {
    SimulatedMailbox.deliver(mail({ externalId: '<req-2@mp-real.com>' }));
    await collectInbox({ trigger: 'schedule' });
    SimulatedMailbox.deliver(mail({ externalId: '<req-2@mp-real.com>' }));
    const again = await collectInbox({ trigger: 'schedule' });
    expect(again).toMatchObject({ rfqRequests: 0, duplicates: 1 });
    expect(listRfqs(ann)).toHaveLength(1);
  });

  it('creates nothing when it cannot be read, and says why', async () => {
    SimulatedMailbox.deliver(mail({ externalId: '<req-3@mp-real.com>', bodyText: 'Title: Rims\nOrigin port: CNSHA' }));
    await collectInbox({ trigger: 'schedule' });
    expect(listRfqs(ann)).toEqual([]);
    const [request] = listRfqRequests(ann);
    expect(request.status).toBe('needs_attention');
    expect(request.problems.join(' ')).toMatch(/Destination port/);
  });

  it('asks which company when the sender has several and did not say', async () => {
    const both = person('Bea Both', 'logistics_coordinator', [companyA, companyB]);
    SimulatedMailbox.deliver(mail({ externalId: '<req-4@mp-real.com>', fromEmail: both.user.email }));
    await collectInbox({ trigger: 'schedule' });
    const [request] = listRfqRequests(both);
    expect(request.status).toBe('needs_attention');
    expect(request.problems.join(' ')).toMatch(/Add a "Company:" line.*MPD, MPI/);

    SimulatedMailbox.deliver(mail({ externalId: '<req-5@mp-real.com>', fromEmail: both.user.email, bodyText: `Company: MPI\n${EMAIL}` }));
    await collectInbox({ trigger: 'schedule' });
    expect(listRfqs(both).map((r) => r.companyId)).toEqual([companyB]);
  });

  it('refuses a company the sender cannot reach', async () => {
    SimulatedMailbox.deliver(mail({ externalId: '<req-6@mp-real.com>', bodyText: `Company: MPI\n${EMAIL}` }));
    await collectInbox({ trigger: 'schedule' });
    expect(listRfqs(ann)).toEqual([]);
    expect(listRfqRequests(ann)[0].problems.join(' ')).toMatch(/not a company you can raise requests for/);
  });

  it('does not raise an RFQ in a read-only person\'s name', async () => {
    const viewer = person('Vic Viewer', 'viewer', [companyA]);
    SimulatedMailbox.deliver(mail({ externalId: '<req-7@mp-real.com>', fromEmail: viewer.user.email }));
    await collectInbox({ trigger: 'schedule' });
    expect(listRfqs(ann)).toEqual([]);
    expect(listRfqRequests(ann)[0].problems.join(' ')).toMatch(/read-only/);
  });

  it('reads the Excel template when it is attached', async () => {
    SimulatedMailbox.deliver(
      mail({
        externalId: '<req-8@mp-real.com>',
        bodyText: 'See attached.',
        attachments: [{ filename: 'requirement.xlsx', content: await buildRfqTemplate() }],
      }),
    );
    await collectInbox({ trigger: 'schedule' });
    const [request] = listRfqRequests(ann);
    expect(request).toMatchObject({ status: 'created', problems: [] });
    const [rfq] = listRfqs(ann);
    expect(rfq.containers.map((c) => `${c.quantity}x${c.type}`)).toEqual(['6x40HC', '2x20GP']);
  });

  it('can be dismissed once dealt with, by someone who can see it', async () => {
    SimulatedMailbox.deliver(mail({ externalId: '<req-9@mp-real.com>', bodyText: 'nothing useful' }));
    await collectInbox({ trigger: 'schedule' });
    const [request] = listRfqRequests(ann);
    const outsider = person('Omar Other', 'logistics_manager', [companyB]);
    expect(() => dismissRfqRequest(outsider, request.id)).toThrow(/not found/);
    expect(dismissRfqRequest(ann, request.id).status).toBe('dismissed');
  });
});
