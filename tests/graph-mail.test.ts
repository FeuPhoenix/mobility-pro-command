/**
 * Sending through Microsoft Graph (W2), against a faked Graph.
 *
 * Nothing here touches the network. What is under test is the adapter's own
 * request building and failure handling, and the round trip that motivated
 * the draft-then-send design: the Message-ID of a sent RFQ is stored, so a
 * reply that quotes no reference is still matched by its In-Reply-To.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMemoryDb, useDb } from '@/freight/db';
import { insertUser, listCompanyProviders, listEmails, listInbound, listQuotes, newId, type Ctx } from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import { createRfq, prepareRfqEmails, setRecipients } from '@/freight/service/rfq';
import { approveEmail, sendEmail } from '@/freight/service/mail';
import { collectInbox } from '@/freight/service/collect';
import { GraphTransport, SendFailure, type OutboundMessage } from '@/freight/adapters/mail';
import { GraphMailbox } from '@/freight/adapters/mailbox';
import { matchMessage } from '@/freight/domain/matching';
import type { User } from '@/freight/types';

const CFG = { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret', mailbox: 'freight@mp-real.com' };
const token = async () => 'tok';
const BOX = 'https://graph.microsoft.com/v1.0/users/freight%40mp-real.com';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeGraph(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    for (const [pattern, handler] of Object.entries(routes)) {
      const [method, path] = pattern.split(' ');
      if (call.method === method && call.url.includes(path)) return handler(call);
    }
    return new Response(JSON.stringify({ error: { code: 'NotFound', message: `no route for ${call.method} ${call.url}` } }), { status: 404 });
  }) as typeof fetch;
  return { http, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const accepted = () => new Response(null, { status: 202 });

const MSG: OutboundMessage = {
  to: [{ name: 'Ann', email: 'ann@alpha-lines.com' }],
  cc: [{ name: null, email: 'ops@alpha-lines.com' }],
  subject: 'RFQ-AAA-2026-0001 - Request for quotation',
  bodyText: 'Please quote.',
  attachments: [{ filename: 'spec.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') }],
};

describe('sending through Graph', () => {
  it('creates a draft, sends it, and returns the real Message-ID', async () => {
    const { http, calls } = fakeGraph({
      'POST /messages': (c) =>
        c.url.endsWith('/messages') ? json({ id: 'AAMk1', internetMessageId: '<abc@mp-real.com>' }, 201) : accepted(),
    });
    const result = await new GraphTransport(CFG, http, token).send(MSG);

    expect(result).toEqual({ messageId: '<abc@mp-real.com>', simulated: false });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BOX}/messages`,
      `POST ${BOX}/messages/AAMk1/send`,
    ]);
    const draft = calls[0].body as Record<string, any>;
    expect(draft.subject).toBe(MSG.subject);
    expect(draft.body).toEqual({ contentType: 'Text', content: 'Please quote.' });
    expect(draft.toRecipients).toEqual([{ emailAddress: { address: 'ann@alpha-lines.com', name: 'Ann' } }]);
    expect(draft.ccRecipients[0].emailAddress.address).toBe('ops@alpha-lines.com');
    expect(draft.attachments[0]).toMatchObject({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'spec.pdf',
      contentBytes: Buffer.from('%PDF-1.4').toString('base64'),
    });
  });

  it('refuses reserved demonstration addresses before calling Graph', async () => {
    const { http, calls } = fakeGraph({});
    const transport = new GraphTransport(CFG, http, token);
    for (const email of ['a@alpha.test', 'b@bounce.invalid', 'c@example.com', 'd@x.example']) {
      const err = await transport.send({ ...MSG, to: [{ name: null, email }], cc: [] }).catch((e) => e);
      expect(err).toBeInstanceOf(SendFailure);
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/cannot receive email.*Nothing was sent/);
    }
    expect(calls.length).toBe(0);
  });

  it('refuses attachments over the inline limit before calling Graph', async () => {
    const { http, calls } = fakeGraph({});
    const big = { filename: 'big.pdf', contentType: 'application/pdf', content: Buffer.alloc(3 * 1024 * 1024 + 1) };
    const err = await new GraphTransport(CFG, http, token).send({ ...MSG, attachments: [big] }).catch((e) => e);
    expect(err.message).toMatch(/3 MB.*Nothing was sent/);
    expect(calls.length).toBe(0);
  });

  it('removes the draft when Graph refuses the send, so nothing half-done is left', async () => {
    const { http, calls } = fakeGraph({
      'POST /messages': (c) =>
        c.url.endsWith('/messages')
          ? json({ id: 'AAMk2', internetMessageId: '<x@mp-real.com>' }, 201)
          : json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403),
      'DELETE /messages/AAMk2': () => new Response(null, { status: 204 }),
    });
    const err = await new GraphTransport(CFG, http, token).send(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(SendFailure);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/403 ErrorAccessDenied/);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: `${BOX}/messages/AAMk2` });
  });

  it('does not invite a blind retry when the connection drops mid-send', async () => {
    const { http, calls } = fakeGraph({
      'POST /messages': (c) => {
        if (c.url.endsWith('/messages')) return json({ id: 'AAMk3', internetMessageId: '<y@mp-real.com>' }, 201);
        throw new Error('socket hang up');
      },
    });
    const err = await new GraphTransport(CFG, http, token).send(MSG).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/not known whether Graph sent.*Check Sent Items in freight@mp-real.com/);
    // The draft is evidence, so it is kept.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('treats throttling on create as retryable', async () => {
    const { http } = fakeGraph({ 'POST /messages': () => json({ error: { code: 'TooManyRequests' } }, 429) });
    const err = await new GraphTransport(CFG, http, token).send(MSG).catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/429/);
  });

  it('checks the connection against Sent Items, which Mail.ReadWrite covers', async () => {
    const { http, calls } = fakeGraph({ 'GET /mailFolders/sentitems': () => json({ id: 'sent' }) });
    const status = await new GraphTransport(CFG, http, token).probe();
    expect(status.connected).toBe(true);
    expect(calls[0].url).toBe(`${BOX}/mailFolders/sentitems?$select=id`);
  });
});

describe('thread matching', () => {
  it('uses In-Reply-To even when the transport also supplies a conversation id', () => {
    const out = matchMessage(
      { fromEmail: 'ann@alpha-lines.com', subject: 'Our rate', bodyText: 'no reference', threadId: 'conv-123', inReplyTo: '<abc@mp-real.com>' },
      {
        rfqs: [],
        recipientsByRfq: new Map(),
        linksForSender: [],
        providerName: () => 'Alpha',
        threadIndex: new Map([['<abc@mp-real.com>', { rfqId: 'rfq1', companyProviderId: 'cp1' }]]),
      },
    );
    expect(out.status).toBe('matched');
    expect(out.rfqId).toBe('rfq1');
    expect(out.basis).toMatch(/same email conversation/i);
  });
});

/* ------------------------------ The round trip ------------------------------- */

describe('send through Graph, then collect the reply', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['MAIL_ADAPTER', 'GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'GRAPH_MAILBOX'];

  beforeEach(() => {
    useDb(openMemoryDb());
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      MAIL_ADAPTER: 'graph',
      GRAPH_TENANT_ID: CFG.tenantId,
      GRAPH_CLIENT_ID: CFG.clientId,
      GRAPH_CLIENT_SECRET: CFG.clientSecret,
      GRAPH_MAILBOX: CFG.mailbox,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('matches a reply that quotes no reference, by the Message-ID of the RFQ email', async () => {
    const boot: Ctx = { user: { id: 'boot', name: 'Boot', title: 'boot', email: 'b@x.com', role: 'logistics_manager', companyIds: [] } };
    const company = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['1'] }).id;
    const u: User = { id: newId('usr'), name: 'Manager', title: 'm', email: 'm@x.com', role: 'logistics_manager', companyIds: [company] };
    insertUser(u);
    const manager: Ctx = { user: u };
    upsertProvider(manager, company, {
      name: 'Alpha Lines', kind: 'Carrier', country: 'Egypt', website: null, generalEmail: null, notes: null,
      status: 'active', restrictionReason: null, accountRef: null, lanes: [],
      contacts: [{ name: 'Ann', email: 'ann@alpha-lines.com', role: null, isPrimary: true }],
    });
    const link = listCompanyProviders(manager, company)[0].link.id;
    const rfq = createRfq(manager, {
      companyId: company, title: 'Test', originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB',
      containers: [{ type: '40HC', quantity: 1, grossWeightKg: 20_000, commodity: 'Tyres' }],
      cargoNotes: null, targetShipFrom: '2099-01-10', targetShipTo: '2099-01-24',
      responseDeadline: '2099-01-05T17:00:00.000Z', instructions: null, requestedCurrency: 'USD',
    });
    setRecipients(manager, rfq.id, [link]);

    // The real service resolves the transport from the environment, so Graph
    // is faked at the global fetch, token endpoint included.
    const { http } = fakeGraph({
      'POST login.microsoftonline.com': () => json({ access_token: 'tok', expires_in: 3600 }),
      'POST /messages': (c) =>
        c.url.endsWith('/messages') ? json({ id: 'SENT1', internetMessageId: '<rfq-1@mp-real.com>' }, 201) : accepted(),
    });
    vi.stubGlobal('fetch', http);

    const [email] = prepareRfqEmails(manager, rfq.id);
    approveEmail(manager, email.id);
    const sent = await sendEmail(manager, email.id);
    expect(sent.ok).toBe(true);
    expect(listEmails(manager, { rfqId: rfq.id })[0]).toMatchObject({
      status: 'sent',
      simulated: false,
      transportMessageId: '<rfq-1@mp-real.com>',
    });

    // The provider replies from their mail client: no reference, but the
    // client sets In-Reply-To to the Message-ID it is answering.
    const inbound = fakeGraph({
      'GET /messages/delta': () =>
        json({
          value: [{
            id: 'R1', internetMessageId: '<reply-1@alpha-lines.com>', conversationId: 'conv-R',
            subject: 'Re: our offer', from: { emailAddress: { address: 'ann@alpha-lines.com' } },
            receivedDateTime: new Date().toISOString(),
            body: { contentType: 'text', content: 'Base ocean freight: USD 1450.00 per 40HC\nTransit time: 28 days' },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta-next',
        }),
      'GET /messages/R1': () => json({ internetMessageHeaders: [{ name: 'In-Reply-To', value: '<rfq-1@mp-real.com>' }], attachments: [] }),
    });
    const run = await collectInbox({ trigger: 'schedule', source: new GraphMailbox(CFG, inbound.http, token) });

    expect(run).toMatchObject({ filed: 1, matched: 1, needsReview: 0 });
    const [message] = listInbound(manager);
    expect(message.rfqId).toBe(rfq.id);
    expect(message.matchBasis).toMatch(/same email conversation/i);
    expect(listQuotes(manager, rfq.id)[0].baseFreight.value).toBe(1450);
  });
});
