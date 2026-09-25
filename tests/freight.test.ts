/**
 * Business-rule tests for the freight RFQ module.
 *
 * These run against an in-memory SQLite database and the real services, so they
 * exercise the same code paths the application does. The emphasis is on the
 * rules that must *refuse* something: an unapproved send, a duplicate, a
 * cross-company read, a missing charge quietly becoming zero.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb, setSetting } from '@/freight/db';
import {
  FreightError,
  getQuote,
  insertUser,
  listEmails,
  listCompanyProviders,
  listQuotes,
  listRfqs,
  getRfq,
  newId,
  type Ctx,
} from '@/freight/repo';
import { createCompany, upsertProvider, analyseProviderImport, commitProviderImport } from '@/freight/service/providers';
import { closeRfq, createRfq, prepareRfqEmails, setRecipients } from '@/freight/service/rfq';
import { approveEmail, editEmail, sendEmail } from '@/freight/service/mail';
import { ingestMessage, reviewQuote } from '@/freight/service/inbox';
import { createComparison, prepareComparisonEmail } from '@/freight/service/compare';
import { runSync } from '@/freight/service/erp';
import { SimulatedErp } from '@/freight/adapters/erpnext';
import { contentHash, approvalIsCurrent } from '@/freight/domain/email';
import { buildComparison, costOffer, currentQuotes } from '@/freight/domain/comparison';
import { matchMessage } from '@/freight/domain/matching';
import { extractFromText, parseAmount, parseDays, parseDate, parseSurcharges } from '@/freight/parsers/text';
import { DEFAULT_CRITERIA, type Quote, type Rfq, type User } from '@/freight/types';
import ExcelJS from 'exceljs';

/* --------------------------------- Harness ---------------------------------- */

let manager: Ctx;
let coordinator: Ctx;
let other: Ctx;
let companyA: string;
let companyB: string;

function user(name: string, role: User['role'], companyIds: string[]): Ctx {
  const u: User = {
    id: newId('usr'),
    name,
    title: role,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.test`,
    role,
    companyIds,
  };
  insertUser(u);
  return { user: u };
}

function seedProviders(ctx: Ctx, companyId: string) {
  upsertProvider(ctx, companyId, {
    name: 'Alpha Lines', kind: 'Carrier', country: 'Egypt', website: null,
    generalEmail: 'ops@alpha.test', notes: null, status: 'active', restrictionReason: null,
    accountRef: null, lanes: [{ originPort: 'CNSHA', destinationPort: 'EGALY' }],
    contacts: [{ name: 'Ann Alpha', email: 'ann@alpha.test', role: 'Sales', isPrimary: true }],
  });
  upsertProvider(ctx, companyId, {
    name: 'Beta Freight', kind: 'NVOCC', country: 'Egypt', website: null,
    generalEmail: 'ops@beta.test', notes: null, status: 'active', restrictionReason: null,
    accountRef: null, lanes: [{ originPort: 'CNSHA', destinationPort: 'EGALY' }],
    contacts: [{ name: 'Ben Beta', email: 'ben@beta.test', role: 'Sales', isPrimary: true }],
  });
  upsertProvider(ctx, companyId, {
    name: 'Gamma Contracted', kind: 'Carrier', country: 'Egypt', website: null,
    generalEmail: 'ops@gamma.test', notes: null, status: 'contracted',
    restrictionReason: 'Annual agreement in force until March 2027.',
    accountRef: null, lanes: [], contacts: [{ name: 'Gil', email: 'gil@gamma.test', role: null, isPrimary: true }],
  });
  upsertProvider(ctx, companyId, {
    name: 'Delta Excluded', kind: 'Carrier', country: 'Egypt', website: null,
    generalEmail: 'ops@delta.test', notes: null, status: 'excluded',
    restrictionReason: 'Excluded after repeated missed sailings.',
    accountRef: null, lanes: [], contacts: [{ name: 'Dee', email: 'dee@delta.test', role: null, isPrimary: true }],
  });
}

function makeRfq(ctx: Ctx, companyId: string, quantity = 6): Rfq {
  return createRfq(ctx, {
    companyId,
    title: 'Test shipment',
    originPort: 'CNSHA',
    destinationPort: 'EGALY',
    incoterm: 'FOB',
    containers: [{ type: '40HC', quantity, grossWeightKg: 20_000, commodity: 'Tyres' }],
    cargoNotes: null,
    targetShipFrom: '2099-01-10',
    targetShipTo: '2099-01-24',
    responseDeadline: '2099-01-05T17:00:00.000Z',
    instructions: null,
    requestedCurrency: 'USD',
  });
}

function linkId(ctx: Ctx, companyId: string, name: string): string {
  const found = listCompanyProviders(ctx, companyId).find((p) => p.provider.name === name);
  if (!found) throw new Error(`no provider ${name}`);
  return found.link.id;
}

const QUOTE_BODY = (ref: string, freight: number, transit: number, free: number) => `Dear team,

Quotation for ${ref}.

Shipping line: Test Line
Base ocean freight: USD ${freight}.00 per 40HC
BAF: USD 100.00 per container
Origin THC: USD 50.00 per container
Documentation fee: USD 40.00 per B/L
Transit time: ${transit} days
Free days at destination: ${free}
Valid until: 2099-12-31
Payment terms: 30 days

Regards`;

beforeEach(() => {
  useDb(openMemoryDb());
  SimulatedErp.reset();
  const bootstrap: Ctx = {
    user: { id: 'boot', name: 'Boot', title: 'boot', email: 'b@test.test', role: 'logistics_manager', companyIds: [] },
  };
  companyA = createCompany(bootstrap, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['Line 1'] }).id;
  companyB = createCompany(bootstrap, { code: 'BBB', name: 'Company B', country: 'Egypt', addressLines: ['Line 1'] }).id;

  manager = user('Manager One', 'logistics_manager', [companyA]);
  coordinator = user('Coord One', 'logistics_coordinator', [companyA]);
  other = user('Other Manager', 'logistics_manager', [companyB]);

  seedProviders(manager, companyA);
  seedProviders(other, companyB);
});

/* ------------------------------- Deterministic ------------------------------- */

describe('parsing', () => {
  it('reads amounts, days and dates in the formats providers actually use', () => {
    expect(parseAmount('USD 1,250.00 per container')).toEqual({ amount: 1250, currency: 'USD' });
    expect(parseAmount('$980')).toEqual({ amount: 980, currency: 'USD' });
    // Regression: a four-digit amount with no thousands separator.
    expect(parseAmount('USD 1200.00 per 40HC')).toEqual({ amount: 1200, currency: 'USD' });
    expect(parseAmount('EUR 12345.67')).toEqual({ amount: 12345.67, currency: 'EUR' });
    expect(parseDays('18-22 days')).toBe(22); // the longer figure, never the flattering one
    expect(parseDays('21 days')).toBe(21);
    expect(parseDate('05/11/2026')).toBe('2026-11-05'); // day first
    expect(parseDate('5 November 2026')).toBe('2026-11-05');
  });

  it('returns null rather than zero when a charge has no amount', () => {
    const s = parseSurcharges({ label: 'email body', text: 'BAF: TBA\nISPS: USD 14.00' });
    const baf = s.find((x) => x.code === 'BAF');
    expect(baf?.amount).toBeNull();
    expect(baf?.confidence).toBe('missing');
    expect(s.find((x) => x.code === 'ISPS')?.amount).toBe(14);
  });

  it('does not read an "excludes" list as a set of charges', () => {
    const s = parseSurcharges({
      label: 'email body',
      text: 'Base freight: USD 1000\nExcludes: destination THC, customs clearance, delivery',
    });
    expect(s.find((x) => x.code === 'THC-DEST')).toBeUndefined();
    expect(s.find((x) => x.code === 'CUSTOMS')).toBeUndefined();
  });

  it('does not count "Origin THC" twice', () => {
    const s = parseSurcharges({ label: 'email body', text: 'Origin THC: USD 120.00 per container' });
    expect(s.filter((x) => x.code.startsWith('THC')).length).toBe(1);
    expect(s[0].code).toBe('THC-ORIGIN');
  });

  it('records where every value came from', () => {
    const f = extractFromText({ label: 'email body', text: QUOTE_BODY('RFQ-AAA-2026-0001', 1500, 20, 7) });
    expect(f.baseFreight.value).toBe(1500);
    expect(f.baseFreight.sourceRef).toMatch(/email body, line \d+/);
    expect(f.baseFreight.sourceText).toContain('1500');
    expect(f.transitDays.value).toBe(20);
  });
});

/* -------------------------------- Comparison --------------------------------- */

function quoteFixture(over: Partial<Quote>): Quote {
  const field = <T,>(value: T | null, confidence: 'high' | 'missing' = 'high') => ({
    value, confidence, sourceRef: 'test', sourceText: null, correctedBy: null, correctedAt: null, note: null,
  });
  return {
    id: newId('q'), companyId: companyA, rfqId: 'rfq', companyProviderId: 'cp', version: 1,
    supersedesQuoteId: null, status: 'confirmed', sourceKind: 'email_body', sourceMessageId: null,
    sourceAttachment: null, unreadableReason: null,
    shippingLine: field('Line'), originPort: field('CNSHA'), destinationPort: field('EGALY'),
    currency: field('USD'), containerBasis: field('40HC' as const), baseFreight: field(1000),
    surcharges: [], totalQuoted: field(null, 'missing'), transitDays: field(20),
    freeDaysDestination: field(7), validUntil: field('2099-12-31'), sailingDate: field('2099-01-15'),
    paymentTerms: field('30 days'), inclusions: field([]), exclusions: field([]), conditions: field([]),
    extractorId: 'test', extractedAt: new Date().toISOString(), reviewedBy: 'u', reviewedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), ...over,
  } as Quote;
}

const testRfq = (): Rfq => ({
  id: 'rfq', reference: 'RFQ-AAA-2026-0001', companyId: companyA, title: 't',
  originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB',
  containers: [{ type: '40HC', quantity: 5, grossWeightKg: null, commodity: 'x' }],
  cargoNotes: null, targetShipFrom: '2099-01-01', targetShipTo: '2099-01-10',
  responseDeadline: '2098-12-20T00:00:00.000Z', instructions: null, requestedCurrency: 'USD',
  status: 'closed', createdBy: 'u', createdAt: '2098-01-01T00:00:00.000Z', closedAt: null, closedBy: null,
});

describe('comparison rules', () => {
  it('multiplies per-container charges by the container count', () => {
    const q = quoteFixture({
      surcharges: [
        { code: 'BAF', label: 'BAF', amount: 100, currency: 'USD', basis: 'per_container', sourceRef: 't', confidence: 'high' },
        { code: 'DOC', label: 'Doc', amount: 40, currency: 'USD', basis: 'per_bl', sourceRef: 't', confidence: 'high' },
      ],
    });
    const r = costOffer(q, testRfq(), DEFAULT_CRITERIA, []);
    // (1000 + 100) x 5 containers, plus one 40 per bill of lading
    expect(r.totalInQuoteCurrency).toBe(5540);
    expect(r.comparable).toBe(true);
  });

  it('refuses to treat a missing surcharge as zero', () => {
    const q = quoteFixture({
      surcharges: [
        { code: 'THC-DEST', label: 'Destination THC', amount: null, currency: null, basis: 'per_container', sourceRef: 't', confidence: 'missing' },
      ],
    });
    const r = costOffer(q, testRfq(), DEFAULT_CRITERIA, []);
    expect(r.totalInQuoteCurrency).toBeNull();
    expect(r.comparable).toBe(false);
    expect(r.issues.some((i) => i.kind === 'missing_surcharge')).toBe(true);
  });

  it('will not rank a different currency without a recorded rate', () => {
    const q = quoteFixture({ currency: { value: 'EUR', confidence: 'high', sourceRef: 't', sourceText: null, correctedBy: null, correctedAt: null, note: null } });
    const without = costOffer(q, testRfq(), DEFAULT_CRITERIA, []);
    expect(without.comparable).toBe(false);
    expect(without.issues.some((i) => i.kind === 'no_fx_rate')).toBe(true);

    const fx = { from: 'EUR', to: 'USD', rate: 1.08, source: 'ECB', asOf: '2026-09-01' };
    const withRate = costOffer(q, testRfq(), DEFAULT_CRITERIA, [fx]);
    expect(withRate.comparable).toBe(true);
    expect(withRate.fxApplied).toEqual(fx);
    expect(withRate.totalInBaseCurrency).toBe(5400);
  });

  it('will not rank a different container basis against the request', () => {
    const q = quoteFixture({ containerBasis: { value: '20GP', confidence: 'high', sourceRef: 't', sourceText: null, correctedBy: null, correctedAt: null, note: null } });
    const r = costOffer(q, testRfq(), DEFAULT_CRITERIA, []);
    expect(r.comparable).toBe(false);
    expect(r.issues.some((i) => i.kind === 'container_basis_mismatch')).toBe(true);
  });

  it('flags a provider total that disagrees with the charges listed', () => {
    const q = quoteFixture({
      totalQuoted: { value: 9999, confidence: 'high', sourceRef: 't', sourceText: null, correctedBy: null, correctedAt: null, note: null },
    });
    const r = costOffer(q, testRfq(), DEFAULT_CRITERIA, []);
    expect(r.totalDiscrepancy).toEqual({ stated: 9999, computed: 5000 });
  });

  it('separates the cheapest offer from the recommended one', () => {
    // Three offers, because min-max normalisation over only two always puts the
    // cheaper one first at any cost weight above half. A real shortlist has more.
    const num = (v: number) => ({ value: v, confidence: 'high' as const, sourceRef: 't', sourceText: null, correctedBy: null, correctedAt: null, note: null });
    const cheapSlow = quoteFixture({ id: 'q-cheap', companyProviderId: 'cp1', baseFreight: num(1000), transitDays: num(40), freeDaysDestination: num(2) });
    const balanced = quoteFixture({ id: 'q-mid', companyProviderId: 'cp2', baseFreight: num(1060), transitDays: num(24), freeDaysDestination: num(10) });
    const dearFast = quoteFixture({ id: 'q-fast', companyProviderId: 'cp3', baseFreight: num(1200), transitDays: num(22), freeDaysDestination: num(14) });

    const names: Record<string, string> = { cp1: 'Cheap Slow', cp2: 'Balanced', cp3: 'Dear Fast' };
    const c = buildComparison({
      id: 'cmp', rfq: testRfq(), quotes: [cheapSlow, balanced, dearFast],
      criteria: DEFAULT_CRITERIA, fxRates: [],
      providerName: (id) => names[id] ?? id,
      createdBy: 'u', createdAt: new Date().toISOString(),
    });

    expect(c.cheapestQuoteId).toBe('q-cheap');
    expect(c.recommendedQuoteId).toBe('q-mid');
    expect(c.recommendedQuoteId).not.toBe(c.cheapestQuoteId);
    expect(c.recommendationReasons.join(' ')).toMatch(/not the cheapest/i);
    expect(c.recommendationTradeoffs.join(' ')).toMatch(/costs USD/i);
  });

  it('keeps only the newest version of each provider quote', () => {
    const v1 = quoteFixture({ id: 'v1', companyProviderId: 'cp1', version: 1, status: 'superseded' });
    const v2 = quoteFixture({ id: 'v2', companyProviderId: 'cp1', version: 2 });
    expect(currentQuotes([v1, v2]).map((q) => q.id)).toEqual(['v2']);
  });

  it('never recommends anything when nothing is comparable', () => {
    const broken = quoteFixture({ baseFreight: { value: null, confidence: 'missing', sourceRef: null, sourceText: null, correctedBy: null, correctedAt: null, note: null } });
    const c = buildComparison({
      id: 'cmp', rfq: testRfq(), quotes: [broken], criteria: DEFAULT_CRITERIA, fxRates: [],
      providerName: () => 'Broken', createdBy: 'u', createdAt: new Date().toISOString(),
    });
    expect(c.recommendedQuoteId).toBeNull();
    expect(c.blockedNotes.length).toBeGreaterThan(0);
  });
});

/* --------------------------------- Matching ---------------------------------- */

describe('reply matching', () => {
  const ctxFor = (rfqs: Rfq[], recipients: Map<string, string[]>, links: { id: string; companyId: string }[]) => ({
    rfqs,
    recipientsByRfq: recipients,
    linksForSender: links.map((l) => ({ ...l, providerId: 'p', status: 'active' as const, restrictionReason: null, accountRef: null, lanes: [], notes: null, createdAt: '' })),
    providerName: () => 'Provider',
    threadIndex: new Map(),
  });

  it('matches on the RFQ reference plus a known sender', () => {
    const rfq = testRfq();
    const out = matchMessage(
      { fromEmail: 'a@p.test', subject: `RE: ${rfq.reference}`, bodyText: '', threadId: null, inReplyTo: null },
      ctxFor([rfq], new Map([[rfq.id, ['cp1']]]), [{ id: 'cp1', companyId: companyA }]),
    );
    expect(out.status).toBe('matched');
    expect(out.companyProviderId).toBe('cp1');
  });

  it('asks a person when the sender has two open requests and quotes no reference', () => {
    const a = { ...testRfq(), id: 'r1', reference: 'RFQ-AAA-2026-0001' };
    const b = { ...testRfq(), id: 'r2', reference: 'RFQ-AAA-2026-0002' };
    const out = matchMessage(
      { fromEmail: 'a@p.test', subject: 'Our rate', bodyText: 'no reference here', threadId: null, inReplyTo: null },
      ctxFor([a, b], new Map([['r1', ['cp1']], ['r2', ['cp1']]]), [{ id: 'cp1', companyId: companyA }]),
    );
    expect(out.status).toBe('ambiguous');
    expect(out.candidates.length).toBe(2);
    expect(out.rfqId).toBeNull();
  });

  it('reports an unknown sender rather than guessing', () => {
    const out = matchMessage(
      { fromEmail: 'stranger@nowhere.test', subject: 'hello', bodyText: '', threadId: null, inReplyTo: null },
      ctxFor([testRfq()], new Map(), []),
    );
    expect(out.status).toBe('unmatched');
  });
});

/* ------------------------------- Approval gate -------------------------------- */

describe('email approval', () => {
  it('binds the approval to the reviewed content', () => {
    const base = { to: [{ name: null, email: 'a@b.test' }], cc: [], subject: 'S', bodyText: 'B', attachments: [] };
    const h1 = contentHash(base);
    expect(contentHash({ ...base, subject: 'S ' })).toBe(h1); // trimmed, cosmetic
    expect(contentHash({ ...base, subject: 'Different' })).not.toBe(h1);
    expect(contentHash({ ...base, to: [{ name: null, email: 'other@b.test' }] })).not.toBe(h1);
    // Reordering recipients is not a material change.
    const two = { ...base, to: [{ name: null, email: 'a@b.test' }, { name: null, email: 'c@b.test' }] };
    const flipped = { ...base, to: [{ name: null, email: 'c@b.test' }, { name: null, email: 'a@b.test' }] };
    expect(contentHash(two)).toBe(contentHash(flipped));
  });

  it('refuses an unapproved send, then allows it, then refuses a duplicate', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    const [email] = prepareRfqEmails(manager, rfq.id);

    await expect(sendEmail(manager, email.id)).rejects.toThrow(/not been approved/i);

    approveEmail(manager, email.id);
    const sent = await sendEmail(manager, email.id);
    expect(sent.ok).toBe(true);
    expect(sent.email.simulated).toBe(true);

    await expect(sendEmail(manager, email.id)).rejects.toThrow(/already been sent/i);
  });

  it('invalidates the approval when the content changes afterwards', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    const [email] = prepareRfqEmails(manager, rfq.id);
    approveEmail(manager, email.id);

    const edited = editEmail(manager, email.id, { subject: 'Changed' });
    expect(edited.status).toBe('approval_stale');
    expect(approvalIsCurrent(edited)).toBe(false);
    await expect(sendEmail(manager, email.id)).rejects.toThrow(/approval no longer applies/i);
  });

  it('only lets a manager approve', () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    const [email] = prepareRfqEmails(manager, rfq.id);
    expect(() => approveEmail(coordinator, email.id)).toThrow(/Only the Logistics Operations Manager/i);
  });

  it('addresses one provider per email so none sees another', () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [
      linkId(manager, companyA, 'Alpha Lines'),
      linkId(manager, companyA, 'Beta Freight'),
    ]);
    const emails = prepareRfqEmails(manager, rfq.id);
    expect(emails.length).toBe(2);
    for (const e of emails) {
      const all = [...e.to, ...e.cc].map((r) => r.email).join(' ');
      const others = e.companyProviderId === linkId(manager, companyA, 'Alpha Lines') ? 'beta.test' : 'alpha.test';
      expect(all).not.toContain(others);
    }
  });

  it('does not prepare a second email for the same provider', () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    prepareRfqEmails(manager, rfq.id);
    prepareRfqEmails(manager, rfq.id);
    expect(listEmails(manager, { rfqId: rfq.id }).length).toBe(1);
  });
});

/* ------------------------------ Outreach control ------------------------------ */

describe('outreach restrictions', () => {
  it('refuses a contracted provider and says why', () => {
    const rfq = makeRfq(manager, companyA);
    expect(() => setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Gamma Contracted')])).toThrow(
      /Annual agreement in force/i,
    );
  });

  it('refuses an excluded provider', () => {
    const rfq = makeRfq(manager, companyA);
    expect(() => setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Delta Excluded')])).toThrow(
      /missed sailings|cannot be sent/i,
    );
  });

  it('refuses a provider belonging to another company', () => {
    const rfq = makeRfq(manager, companyA);
    const foreign = linkId(other, companyB, 'Alpha Lines');
    expect(() => setRecipients(manager, rfq.id, [foreign])).toThrow(FreightError);
  });
});

/* ------------------------------ Company isolation ------------------------------ */

describe('company isolation', () => {
  it('hides other companies requests', () => {
    makeRfq(manager, companyA);
    expect(listRfqs(other).length).toBe(0);
    expect(listRfqs(manager).length).toBe(1);
  });

  it('refuses a direct read of another companys request', () => {
    const rfq = makeRfq(manager, companyA);
    expect(() => getRfq(other, rfq.id)).toThrow(/do not have access/i);
  });

  it('refuses to create a request on a company the user cannot reach', () => {
    expect(() => makeRfq(other, companyA)).toThrow(/do not have access/i);
  });
});

/* -------------------------------- Whole journey -------------------------------- */

async function deliver(ctx: Ctx, rfq: Rfq, from: string, body: string, externalId: string) {
  return ingestMessage(ctx, {
    externalId, threadId: null, inReplyTo: null, fromEmail: from, fromName: null,
    subject: `RE: ${rfq.reference}`, receivedAt: new Date().toISOString(), bodyText: body,
    attachments: [], simulated: true,
  });
}

describe('the whole journey', () => {
  it('runs from requirement to recorded outcome', async () => {
    const rfq = makeRfq(manager, companyA);
    upsertProvider(manager, companyA, {
      name: 'Mid Carrier', kind: 'Carrier', country: 'Egypt', website: null,
      generalEmail: 'ops@mid.test', notes: null, status: 'active', restrictionReason: null,
      accountRef: null, lanes: [], contacts: [{ name: 'Mo', email: 'mo@mid.test', role: null, isPrimary: true }],
    });
    setRecipients(manager, rfq.id, [
      linkId(manager, companyA, 'Alpha Lines'),
      linkId(manager, companyA, 'Beta Freight'),
      linkId(manager, companyA, 'Mid Carrier'),
    ]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      expect((await sendEmail(manager, e.id)).ok).toBe(true);
    }

    await deliver(manager, rfq, 'ann@alpha.test', QUOTE_BODY(rfq.reference, 1000, 40, 2), 'm1');
    await deliver(manager, rfq, 'ben@beta.test', QUOTE_BODY(rfq.reference, 1200, 22, 14), 'm2');
    await deliver(manager, rfq, 'mo@mid.test', QUOTE_BODY(rfq.reference, 1060, 24, 10), 'm3');

    const quotes = listQuotes(manager, rfq.id);
    expect(quotes.length).toBe(3);
    expect(quotes.every((q) => q.status === 'needs_review')).toBe(true);

    // Unchecked offers must not be ranked.
    const premature = await createComparison(manager, rfq.id);
    expect(premature.lines.every((l) => !l.comparable)).toBe(true);
    expect(premature.recommendedQuoteId).toBeNull();

    for (const q of quotes) reviewQuote(manager, q.id, { fields: [], confirm: true });
    closeRfq(manager, rfq.id);

    const comparison = await createComparison(manager, rfq.id);
    expect(comparison.lines.filter((l) => l.comparable).length).toBe(3);
    expect(comparison.cheapestQuoteId).toBeTruthy();
    expect(comparison.recommendedQuoteId).toBeTruthy();
    // The balanced offer wins on the default weights, not the cheapest one.
    expect(comparison.cheapestQuoteId).not.toBe(comparison.recommendedQuoteId);
    expect(comparison.workbookKey).toBeTruthy();

    const email = prepareComparisonEmail(manager, comparison.id);
    expect(email.status).toBe('awaiting_approval');
    expect(email.attachments.length).toBe(1);
    await expect(sendEmail(manager, email.id)).rejects.toThrow(/not been approved/i);
    approveEmail(manager, email.id);
    expect((await sendEmail(manager, email.id)).ok).toBe(true);

    const first = await runSync(manager, comparison.id);
    expect(first.ok).toBe(true); // failFirst is off outside the demo dataset
    expect(first.sync.adapter).toBe('simulated');
    expect(first.sync.status).toBe('success');

    const repeat = await runSync(manager, comparison.id);
    expect(repeat.sync.attempts).toBe(first.sync.attempts); // not attempted again
  });

  it('keeps an earlier quotation when a revision arrives', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      await sendEmail(manager, e.id);
    }

    await deliver(manager, rfq, 'ann@alpha.test', QUOTE_BODY(rfq.reference, 1200, 30, 5), 'r1');
    await deliver(manager, rfq, 'ann@alpha.test', QUOTE_BODY(rfq.reference, 1100, 28, 8), 'r2');

    const quotes = listQuotes(manager, rfq.id).sort((a, b) => a.version - b.version);
    expect(quotes.length).toBe(2);
    expect(quotes[0].status).toBe('superseded');
    expect(quotes[0].baseFreight.value).toBe(1200);
    expect(quotes[1].version).toBe(2);
    expect(quotes[1].supersedesQuoteId).toBe(quotes[0].id);
    expect(currentQuotes(quotes).map((q) => q.id)).toEqual([quotes[1].id]);
  });

  it('carries a reviewer correction into the comparison', async () => {
    const rfq = makeRfq(manager, companyA, 1);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      await sendEmail(manager, e.id);
    }
    await deliver(manager, rfq, 'ann@alpha.test', QUOTE_BODY(rfq.reference, 1000, 20, 5), 'c1');

    const q = listQuotes(manager, rfq.id)[0];
    reviewQuote(manager, q.id, { fields: [{ field: 'baseFreight', value: 1234 }], confirm: true });

    const updated = getQuote(manager, q.id);
    expect(updated.baseFreight.value).toBe(1234);
    expect(updated.baseFreight.correctedBy).toBe(manager.user.id);
    expect(updated.baseFreight.confidence).toBe('high');

    closeRfq(manager, rfq.id);
    const c = await createComparison(manager, rfq.id);
    // 1234 + BAF 100 + THC 50, all per container x1, plus 40 per B/L
    expect(c.lines[0].totalInQuoteCurrency).toBe(1424);
  });

  it('ingests the same message only once', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      await sendEmail(manager, e.id);
    }
    await deliver(manager, rfq, 'ann@alpha.test', QUOTE_BODY(rfq.reference, 1000, 20, 5), 'dup');
    const second = await deliver(manager, rfq, 'ann@alpha.test', QUOTE_BODY(rfq.reference, 1000, 20, 5), 'dup');
    expect(second.quote).toBeNull();
    expect(listQuotes(manager, rfq.id).length).toBe(1);
  });

  it('retries a failed ERPNext write without creating a second record', async () => {
    setSetting('demo.erpFailFirst', true);
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkId(manager, companyA, 'Alpha Lines')]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      await sendEmail(manager, e.id);
    }
    await deliver(manager, rfq, 'ann@alpha.test', QUOTE_BODY(rfq.reference, 1000, 20, 5), 'e1');
    for (const q of listQuotes(manager, rfq.id)) reviewQuote(manager, q.id, { fields: [], confirm: true });
    closeRfq(manager, rfq.id);
    const c = await createComparison(manager, rfq.id);

    const first = await runSync(manager, c.id);
    expect(first.ok).toBe(false);
    expect(first.retryable).toBe(true);
    expect(first.sync.status).toBe('failed');

    const second = await runSync(manager, c.id);
    expect(second.ok).toBe(true);
    expect(second.sync.attempts).toBe(2);
    expect(second.sync.idempotencyKey).toBe(first.sync.idempotencyKey);

    const third = await runSync(manager, c.id);
    expect(third.sync.attempts).toBe(2);
  });
});

/* ------------------------------ Spreadsheet import ----------------------------- */

async function importSheet(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Providers');
  for (const r of rows) sheet.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('provider import', () => {
  const HEAD = ['Provider name', 'Type', 'Country', 'General email', 'Relationship status', 'Restriction reason', 'Lanes', 'Contact name', 'Contact email', 'Primary contact'];

  it('validates before writing anything and reports bad rows by number', async () => {
    const buffer = await importSheet([
      HEAD,
      ['Epsilon Lines', 'Carrier', 'Egypt', 'ops@epsilon.test', 'active', '', 'CNSHA>EGALY', 'Eve', 'eve@epsilon.test', 'yes'],
      ['Zeta Lines', 'Carrier', 'Egypt', 'ops@zeta.test', 'excluded', '', 'CNSHA>EGALY', 'Zed', 'zed@zeta.test', 'yes'],
      ['Eta Lines', 'Carrier', 'Egypt', 'not-an-email', 'active', '', '', 'Eta', 'bad-address', 'yes'],
    ]);
    const report = await analyseProviderImport(manager, companyA, buffer, 'list.xlsx');

    expect(report.valid).toBe(1);
    expect(report.invalid).toBe(2);
    const zeta = report.rows.find((r) => r.input?.name === 'Zeta Lines');
    expect(zeta?.errors.join(' ')).toMatch(/needs a reason/i);
    const eta = report.rows.find((r) => r.input?.name === 'Eta Lines');
    expect(eta?.errors.join(' ')).toMatch(/not a valid email/i);

    // Nothing was written by the analysis itself.
    expect(listCompanyProviders(manager, companyA).some((p) => p.provider.name === 'Epsilon Lines')).toBe(false);

    const result = commitProviderImport(manager, companyA, report);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it('detects a duplicate and updates instead of creating a second entry', async () => {
    const buffer = await importSheet([
      HEAD,
      ['Alpha Lines', 'Carrier', 'Egypt', 'ops@alpha.test', 'active', '', 'CNSHA>EGALY', 'Ann', 'ann@alpha.test', 'yes'],
    ]);
    const report = await analyseProviderImport(manager, companyA, buffer, 'list.xlsx');
    expect(report.duplicates).toBe(1);
    expect(report.rows[0].action).toBe('update');

    const before = listCompanyProviders(manager, companyA).length;
    commitProviderImport(manager, companyA, report);
    const after = listCompanyProviders(manager, companyA).length;
    expect(after).toBe(before);
  });

  it('rejects a file with no provider name column', async () => {
    const buffer = await importSheet([['Something', 'Else'], ['a', 'b']]);
    const report = await analyseProviderImport(manager, companyA, buffer, 'wrong.xlsx');
    expect(report.fatal).toMatch(/Provider name/i);
  });
});
