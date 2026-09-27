/**
 * Scheduled mailbox collection (W1).
 *
 * Runs against an in-memory database and the real services. Graph is faked at
 * the `fetch` boundary, so the adapter's own URL building, paging and mapping
 * are what is under test - nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSetting, openMemoryDb, setSetting, useDb } from '@/freight/db';
import {
  assertCanApprove,
  assertCanEdit,
  getUser,
  insertUser,
  listAudit,
  listCompanyProviders,
  listInbound,
  listQuotes,
  listUsers,
  newId,
  type Ctx,
} from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import { createRfq, prepareRfqEmails, setRecipients } from '@/freight/service/rfq';
import { approveEmail, sendEmail } from '@/freight/service/mail';
import { collectInbox } from '@/freight/service/collect';
import { checkConnection, withLastCheck } from '@/freight/service/connections';
import { applyFreightAction } from '@/freight/actions';
import { GraphMailbox, SimulatedMailbox, mailboxStatusForDisplay, type MailboxSource } from '@/freight/adapters/mailbox';
import { SimulatedErp } from '@/freight/adapters/erpnext';
import { MAILBOX_COLLECTOR_ID, mailboxCollectorCtx } from '@/freight/system';
import type { IncomingMail } from '@/freight/service/inbox';
import type { Rfq, User } from '@/freight/types';

/* --------------------------------- Harness ---------------------------------- */

let manager: Ctx;
let viewer: Ctx;
let companyA: string;
let companyB: string;

function user(name: string, role: User['role'], companyIds: string[]): Ctx {
  const u: User = { id: newId('usr'), name, title: role, email: `${name.replace(/\s+/g, '.')}@test.test`, role, companyIds };
  insertUser(u);
  return { user: u };
}

function provider(ctx: Ctx, companyId: string, name: string, email: string) {
  upsertProvider(ctx, companyId, {
    name, kind: 'Carrier', country: 'Egypt', website: null, generalEmail: null, notes: null,
    status: 'active', restrictionReason: null, accountRef: null,
    lanes: [{ originPort: 'CNSHA', destinationPort: 'EGALY' }],
    contacts: [{ name, email, role: null, isPrimary: true }],
  });
}

function linkId(ctx: Ctx, companyId: string, name: string): string {
  const found = listCompanyProviders(ctx, companyId).find((p) => p.provider.name === name);
  if (!found) throw new Error(`no provider ${name}`);
  return found.link.id;
}

async function sentRfq(ctx: Ctx, companyId: string, providers: string[]): Promise<Rfq> {
  const rfq = createRfq(ctx, {
    companyId, title: 'Test shipment', originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB',
    containers: [{ type: '40HC', quantity: 2, grossWeightKg: 20_000, commodity: 'Tyres' }],
    cargoNotes: null, targetShipFrom: '2099-01-10', targetShipTo: '2099-01-24',
    responseDeadline: '2099-01-05T17:00:00.000Z', instructions: null, requestedCurrency: 'USD',
  });
  setRecipients(ctx, rfq.id, providers.map((p) => linkId(ctx, companyId, p)));
  for (const e of prepareRfqEmails(ctx, rfq.id)) {
    approveEmail(ctx, e.id);
    await sendEmail(ctx, e.id);
  }
  return rfq;
}

const QUOTE = (ref: string) => `Quotation for ${ref}.

Shipping line: Test Line
Base ocean freight: USD 1200.00 per 40HC
BAF: USD 100.00 per container
Transit time: 30 days
Free days at destination: 7
Valid until: 2099-12-31`;

function mail(over: Partial<IncomingMail> & { externalId: string; fromEmail: string }): Omit<IncomingMail, 'simulated'> {
  return {
    threadId: null, inReplyTo: null, fromName: null, subject: 'Quotation',
    receivedAt: new Date().toISOString(), bodyText: '', attachments: [],
    ...over,
  };
}

const ENV_KEYS = ['MAILBOX_ADAPTER', 'MAIL_ADAPTER', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_MAILBOX'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  useDb(openMemoryDb());
  SimulatedErp.reset();
  SimulatedMailbox.reset();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  const boot: Ctx = { user: { id: 'boot', name: 'Boot', title: 'boot', email: 'b@test.test', role: 'logistics_manager', companyIds: [] } };
  companyA = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['1'] }).id;
  companyB = createCompany(boot, { code: 'BBB', name: 'Company B', country: 'Egypt', addressLines: ['1'] }).id;
  manager = user('Manager One', 'logistics_manager', [companyA]);
  viewer = user('Viewer One', 'viewer', [companyA]);
  provider(manager, companyA, 'Alpha Lines', 'ann@alpha.test');
  provider(manager, companyA, 'Beta Freight', 'ben@beta.test');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/* ------------------------------ The identity -------------------------------- */

describe('the Mailbox Collector identity', () => {
  it('is not a person anyone can act as', () => {
    expect(listUsers().some((u) => u.id === MAILBOX_COLLECTOR_ID)).toBe(false);
    expect(getUser(MAILBOX_COLLECTOR_ID)).toBeNull();
  });

  it('may not edit or approve anything', () => {
    const ctx = mailboxCollectorCtx();
    expect(() => assertCanEdit(ctx)).toThrow(/only files incoming replies/i);
    expect(() => assertCanApprove(ctx)).toThrow();
    expect(() => approveEmail(ctx, 'anything')).toThrow();
  });

  it('covers every company, including one added after it was first used', () => {
    expect(mailboxCollectorCtx().user.companyIds.sort()).toEqual([companyA, companyB].sort());
    const boot: Ctx = { user: { ...manager.user, companyIds: [] } };
    const c = createCompany(boot, { code: 'CCC', name: 'Company C', country: 'Egypt', addressLines: ['1'] }).id;
    expect(mailboxCollectorCtx().user.companyIds).toContain(c);
  });
});

/* ---------------------------- Simulated collection --------------------------- */

describe('collecting from the mailbox', () => {
  it('files a reply, matches it and extracts the quotation, as the Mailbox Collector', async () => {
    const rfq = await sentRfq(manager, companyA, ['Alpha Lines']);
    SimulatedMailbox.deliver(mail({ externalId: '<m1@alpha.test>', fromEmail: 'ann@alpha.test', subject: `RE: ${rfq.reference}`, bodyText: QUOTE(rfq.reference) }));

    const run = await collectInbox({ trigger: 'schedule' });
    expect(run.outcome).toBe('ok');
    expect(run).toMatchObject({ fetched: 1, filed: 1, matched: 1, needsReview: 0, duplicates: 0 });

    const quotes = listQuotes(manager, rfq.id);
    expect(quotes.length).toBe(1);
    expect(quotes[0].baseFreight.value).toBe(1200);
    expect(quotes[0].status).toBe('needs_review'); // collected is not the same as checked

    const received = listAudit(manager).find((e) => e.action === 'inbox.received');
    expect(received?.actorName).toBe('Mailbox Collector');
    expect(received?.actorId).toBe(MAILBOX_COLLECTOR_ID);
  });

  it('creates no duplicates when collection runs again, even from scratch', async () => {
    const rfq = await sentRfq(manager, companyA, ['Alpha Lines']);
    SimulatedMailbox.deliver(mail({ externalId: '<d1@alpha.test>', fromEmail: 'ann@alpha.test', subject: `RE: ${rfq.reference}`, bodyText: QUOTE(rfq.reference) }));

    await collectInbox({ trigger: 'schedule' });
    const again = await collectInbox({ trigger: 'schedule' });
    expect(again).toMatchObject({ fetched: 0, filed: 0 });

    // Losing the saved position re-reads the mailbox; the message id still stops a second copy.
    setSetting('mailbox.state', null);
    const fromScratch = await collectInbox({ trigger: 'schedule' });
    expect(fromScratch).toMatchObject({ fetched: 1, filed: 0, duplicates: 1 });
    expect(listInbound(manager).length).toBe(1);
    expect(listQuotes(manager, rfq.id).length).toBe(1);
  });

  it('puts an ambiguous reply in the review queue instead of guessing', async () => {
    await sentRfq(manager, companyA, ['Alpha Lines']);
    await sentRfq(manager, companyA, ['Alpha Lines']);
    SimulatedMailbox.deliver(mail({ externalId: '<amb@alpha.test>', fromEmail: 'ann@alpha.test', subject: 'Our rate', bodyText: 'Please see our rate, no reference.' }));

    const run = await collectInbox({ trigger: 'schedule' });
    expect(run).toMatchObject({ filed: 1, matched: 0, needsReview: 1 });
    const queued = listInbound(manager).filter((m) => m.matchStatus !== 'matched');
    expect(queued.length).toBe(1);
    expect(queued[0].rfqId).toBeNull();
  });

  it('on the first run, ignores mail older than the look-back window', async () => {
    const rfq = await sentRfq(manager, companyA, ['Alpha Lines']);
    const old = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    SimulatedMailbox.deliver(mail({ externalId: '<old@alpha.test>', fromEmail: 'ann@alpha.test', subject: `RE: ${rfq.reference}`, receivedAt: old }));
    SimulatedMailbox.deliver(mail({ externalId: '<new@alpha.test>', fromEmail: 'ann@alpha.test', subject: `RE: ${rfq.reference}`, bodyText: QUOTE(rfq.reference) }));

    const run = await collectInbox({ trigger: 'schedule' });
    expect(run.filed).toBe(1);
    expect(listInbound(manager).map((m) => m.externalId)).toEqual(['<new@alpha.test>']);
  });

  it('never runs twice at once', async () => {
    await sentRfq(manager, companyA, ['Alpha Lines']);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: MailboxSource = {
      key: 'slow', kind: 'simulated',
      status: () => new SimulatedMailbox().status(),
      probe: () => new SimulatedMailbox().probe(),
      fetchPage: async () => {
        await gate;
        return { messages: [], cursor: '0', more: false, notes: [] };
      },
    };
    const first = collectInbox({ trigger: 'schedule', source: slow });
    const second = await collectInbox({ trigger: 'schedule', source: slow });
    expect(second.outcome).toBe('skipped');
    expect(second.error).toMatch(/already in progress/i);
    release();
    expect((await first).outcome).toBe('ok');
    // The lease is released afterwards, so the next run proceeds.
    expect((await collectInbox({ trigger: 'schedule', source: slow })).outcome).toBe('ok');
  });

  it('retries a message that fails to file, then sets it aside without losing the rest', async () => {
    const rfq = await sentRfq(manager, companyA, ['Alpha Lines']);
    const poison = {
      ...mail({ externalId: '<poison@alpha.test>', fromEmail: 'ann@alpha.test', subject: 'Broken' }),
      attachments: { [Symbol.iterator]: () => { throw new Error('storage unavailable'); } } as unknown as IncomingMail['attachments'],
    };
    SimulatedMailbox.deliver(poison);
    SimulatedMailbox.deliver(mail({ externalId: '<good@alpha.test>', fromEmail: 'ann@alpha.test', subject: `RE: ${rfq.reference}`, bodyText: QUOTE(rfq.reference) }));

    const one = await collectInbox({ trigger: 'schedule' });
    expect(one.outcome).toBe('failed');
    expect(one.error).toMatch(/attempt 1 of 3/);
    const two = await collectInbox({ trigger: 'schedule' });
    expect(two.error).toMatch(/attempt 2 of 3/);
    expect(listInbound(manager).length).toBe(0); // the good one waits behind it, not skipped

    const three = await collectInbox({ trigger: 'schedule' });
    expect(three.outcome).toBe('ok');
    expect(three.quarantined.map((q) => q.externalId)).toEqual(['<poison@alpha.test>']);
    expect(three.filed).toBe(1);
    expect(listInbound(manager).map((m) => m.externalId)).toEqual(['<good@alpha.test>']);
    expect(listAudit(manager).some((e) => e.action === 'inbox.collect_set_aside' && /Broken/.test(e.summary))).toBe(true);
  });

  it('keeps a quiet schedule out of the activity log', async () => {
    await collectInbox({ trigger: 'schedule' });
    await collectInbox({ trigger: 'schedule' });
    expect(listAudit(manager).some((e) => e.action.startsWith('inbox.collect'))).toBe(false);
  });

  it('lets a person ask for a run, but not a read-only one', async () => {
    const result = await applyFreightAction(manager, { type: 'mailbox.collect' });
    expect(result.message).toMatch(/no new replies in the simulated mailbox/i);
    expect(getSetting<{ requestedBy: string } | null>('mailbox.lastRun', null)?.requestedBy).toBe('Manager One');
    await expect(applyFreightAction(viewer, { type: 'mailbox.collect' })).rejects.toThrow(/read-only/i);
  });
});

/* ------------------------------- Graph adapter ------------------------------- */

const CFG = { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret', mailbox: 'freight@mp.test' };
const token = async () => 'tok';

function fakeGraph(routes: Record<string, (url: string) => Response | Promise<Response>>) {
  const calls: string[] = [];
  const http = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler(url);
    }
    return new Response(JSON.stringify({ error: { code: 'NotFound', message: `no route for ${url}` } }), { status: 404 });
  }) as typeof fetch;
  return { http, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function graphMessage(id: string, from: string, subject: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject,
    from: { emailAddress: { address: from, name: 'Ann' } },
    receivedDateTime: new Date().toISOString(),
    body: { contentType: 'text', content: body },
    hasAttachments: false,
    isDraft: false,
    ...extra,
  };
}

describe('the Microsoft Graph mailbox', () => {
  it('reads new mail by delta query and maps it faithfully', async () => {
    const pdf = Buffer.from('%PDF-1.4 small');
    const big = Buffer.from('%PDF-1.4 large attachment bytes');
    const { http, calls } = fakeGraph({
      '/messages/delta?': () =>
        json({
          value: [
            graphMessage('a1', 'Ann@Alpha.test', 'RE: quote', 'Body one'),
            { id: 'gone', '@removed': { reason: 'deleted' } },
            graphMessage('draft', 'ann@alpha.test', 'draft', '', { isDraft: true }),
            graphMessage('self', 'freight@mp.test', 'copy', ''),
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page-1',
        }),
      'next-page-1': () =>
        json({ value: [graphMessage('a2', 'ben@beta.test', 'Rates', 'Body two')], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-token-1' }),
      '/messages/a1?': () =>
        json({
          internetMessageHeaders: [{ name: 'In-Reply-To', value: ' <rfq-sent@mp.test> ' }],
          attachments: [
            { id: 'att1', '@odata.type': '#microsoft.graph.fileAttachment', name: 'quote.pdf', contentBytes: pdf.toString('base64') },
            { id: 'att2', '@odata.type': '#microsoft.graph.fileAttachment', name: 'big.pdf' },
            { id: 'att3', '@odata.type': '#microsoft.graph.referenceAttachment', name: 'rates.xlsx' },
          ],
        }),
      '/attachments/att2/$value': () => new Response(big),
      '/messages/a2?': () => json({ attachments: [] }),
    });

    const box = new GraphMailbox(CFG, http, token);
    const first = await box.fetchPage(null, '2026-09-20T00:00:00.000Z');

    expect(calls[0]).toContain('/users/freight%40mp.test/mailFolders/inbox/messages/delta?');
    expect(decodeURIComponent(calls[0])).toContain('receivedDateTime ge 2026-09-20T00:00:00.000Z');
    expect(first.more).toBe(true);
    expect(first.cursor).toBe('https://graph.microsoft.com/v1.0/next-page-1');
    // Removed items, drafts and our own mail are not replies.
    expect(first.messages.length).toBe(1);

    const m = first.messages[0];
    expect(m).toMatchObject({
      externalId: '<a1@mail.test>',
      threadId: 'conv-a1',
      inReplyTo: '<rfq-sent@mp.test>',
      fromEmail: 'ann@alpha.test',
      simulated: false,
    });
    expect(m.attachments.map((a) => a.filename)).toEqual(['quote.pdf', 'big.pdf']);
    expect(m.attachments[0].content.equals(pdf)).toBe(true);
    expect(m.attachments[1].content.equals(big)).toBe(true);
    // A linked file is recorded, not silently dropped.
    expect(m.bodyText).toContain('Attachments not collected: rates.xlsx');
    expect(first.notes.join(' ')).toContain('rates.xlsx');

    const second = await box.fetchPage(first.cursor, 'ignored');
    expect(second.more).toBe(false);
    expect(second.cursor).toBe('https://graph.microsoft.com/v1.0/delta-token-1');
    expect(second.messages[0].externalId).toBe('<a2@mail.test>');
  });

  it('files Graph mail end to end and resumes from the delta link next time', async () => {
    const rfq = await sentRfq(manager, companyA, ['Alpha Lines']);
    let deltaCalls = 0;
    const { http, calls } = fakeGraph({
      '/messages/delta?': () =>
        json({ value: [graphMessage('g1', 'ann@alpha.test', `RE: ${rfq.reference}`, QUOTE(rfq.reference))], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-1' }),
      'delta-1': () => {
        deltaCalls += 1;
        return json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-2' });
      },
      '/messages/g1?': () => json({ attachments: [] }),
    });
    const source = new GraphMailbox(CFG, http, token);

    const run = await collectInbox({ trigger: 'schedule', source });
    expect(run).toMatchObject({ adapter: 'graph', filed: 1, matched: 1 });
    expect(listInbound(manager)[0].simulated).toBe(false);

    const next = await collectInbox({ trigger: 'schedule', source });
    expect(next).toMatchObject({ fetched: 0, filed: 0 });
    expect(deltaCalls).toBe(1);
    expect(calls.filter((c) => c.includes('/messages/delta?')).length).toBe(1);
  });

  it('starts again when the saved position expires, without duplicating anything', async () => {
    const rfq = await sentRfq(manager, companyA, ['Alpha Lines']);
    const reply = graphMessage('e1', 'ann@alpha.test', `RE: ${rfq.reference}`, QUOTE(rfq.reference));
    const { http } = fakeGraph({
      '/messages/delta?': () => json({ value: [reply], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/stale-delta' }),
      'stale-delta': () => json({ error: { code: 'SyncStateNotFound', message: 'expired' } }, 410),
      '/messages/e1?': () => json({ attachments: [] }),
    });
    const source = new GraphMailbox(CFG, http, token);

    await collectInbox({ trigger: 'schedule', source });
    const after = await collectInbox({ trigger: 'schedule', source });
    expect(after.outcome).toBe('ok');
    expect(after.notes.join(' ')).toMatch(/expired/i);
    expect(after.duplicates).toBe(1);
    expect(listInbound(manager).length).toBe(1);
  });

  it('reports throttling as a failed run and keeps its place', async () => {
    const { http } = fakeGraph({
      '/messages/delta?': () => json({ error: { code: 'TooManyRequests', message: 'slow down' } }, 429, { 'retry-after': '30' }),
    });
    const run = await collectInbox({ trigger: 'schedule', source: new GraphMailbox(CFG, http, token) });
    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/429.*Retry after 30s/);
    expect(getSetting<{ cursor: string | null } | null>('mailbox.state', null)).toBeNull();
    expect(listAudit(manager).some((e) => e.action === 'inbox.collect_failed')).toBe(true);
  });

  it('only says connected after a successful probe', async () => {
    const ok = new GraphMailbox(CFG, fakeGraph({ '/mailFolders/inbox?': () => json({ id: 'inbox', totalItemCount: 12 }) }).http, token);
    expect(ok.status().connected).toBe(false);
    expect((await ok.probe()).connected).toBe(true);

    const denied = new GraphMailbox(CFG, fakeGraph({ '/mailFolders/inbox?': () => json({ error: { code: 'ErrorAccessDenied' } }, 403) }).http, token);
    const s = await denied.probe();
    expect(s.connected).toBe(false);
    expect(s.detail).toMatch(/403 ErrorAccessDenied/);
  });
});

/* ----------------------------- Connection checks ----------------------------- */

describe('connection checks', () => {
  it('stays simulated until Graph is requested and fully configured', () => {
    delete process.env.MAILBOX_ADAPTER;
    expect(mailboxStatusForDisplay().kind).toBe('simulated');
    process.env.MAILBOX_ADAPTER = 'graph';
    delete process.env.GRAPH_CLIENT_SECRET;
    const s = mailboxStatusForDisplay();
    expect(s.kind).toBe('simulated');
    expect(s.setupRequirements.join(' ')).toContain('GRAPH_CLIENT_SECRET');
  });

  it('remembers a check only for the configuration it was made against', async () => {
    Object.assign(process.env, {
      MAILBOX_ADAPTER: 'graph', GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', GRAPH_MAILBOX: 'freight@mp.test',
    });
    // Store a passing check as if it had been made.
    setSetting('probe.mailbox', {
      fingerprint: ['graph', 't', 'c', 'freight@mp.test'].join('|'),
      status: { label: 'Microsoft 365 mailbox connected', kind: 'graph', connected: true, detail: '', setupRequirements: [] },
    });
    expect(withLastCheck('mailbox', mailboxStatusForDisplay()).connected).toBe(true);

    process.env.GRAPH_MAILBOX = 'other@mp.test';
    expect(withLastCheck('mailbox', mailboxStatusForDisplay()).connected).toBe(false);
  });

  it('is refused for a read-only person', async () => {
    await expect(checkConnection(viewer, 'mailbox')).rejects.toThrow(/read-only/i);
  });
});
