/**
 * Tests for the freight automation seam.
 *
 * Two things matter here. First that the chasing policy is right, because it
 * decides when a provider gets emailed. Second, and more important, that
 * automation **cannot** send or approve anything — that guarantee is the reason
 * the approval workflow is worth having, and it has to hold against a caller
 * that is trying.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb, setSetting } from '@/freight/db';
import {
  assertCanApprove,
  assertCanEdit,
  assertCanSend,
  getEmail,
  insertUser,
  listAudit,
  listCompanyProviders,
  listEmails,
  listQuotes,
  listUsers,
  newId,
  updateRecipient,
  findRecipient,
  type Ctx,
} from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import { createRfq, prepareRfqEmails, setRecipients, closeRfq } from '@/freight/service/rfq';
import { approveEmail, editEmail, sendEmail } from '@/freight/service/mail';
import { ingestMessage, reviewQuote } from '@/freight/service/inbox';
import { createComparison } from '@/freight/service/compare';
import { runSync } from '@/freight/service/erp';
import { SimulatedErp } from '@/freight/adapters/erpnext';
import {
  automationCtx,
  dueReminders,
  prepareDueReminders,
  retryableSyncs,
  retryFailedSyncs,
  waitingApprovals,
  automationSummary,
} from '@/freight/service/automation';
import { chaseVerdict, DEFAULT_CHASE, type ChaseCandidate, type ChaseInput } from '@/freight/domain/chasing';
import type { RecipientStatus, Rfq, User } from '@/freight/types';

let manager: Ctx;
let companyA: string;

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

function makeRfq(ctx: Ctx, companyId: string, deadlineDaysAhead = 10): Rfq {
  const deadline = new Date();
  deadline.setUTCDate(deadline.getUTCDate() + deadlineDaysAhead);
  const from = new Date();
  from.setUTCDate(from.getUTCDate() + deadlineDaysAhead + 5);
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + deadlineDaysAhead + 20);
  return createRfq(ctx, {
    companyId,
    title: 'Automation test shipment',
    originPort: 'CNSHA',
    destinationPort: 'EGALY',
    incoterm: 'FOB',
    containers: [{ type: '40HC', quantity: 4, grossWeightKg: 20_000, commodity: 'Tyres' }],
    cargoNotes: null,
    targetShipFrom: from.toISOString().slice(0, 10),
    targetShipTo: to.toISOString().slice(0, 10),
    responseDeadline: deadline.toISOString(),
    instructions: null,
    requestedCurrency: 'USD',
  });
}

function linkFor(ctx: Ctx, companyId: string, name: string): string {
  const found = listCompanyProviders(ctx, companyId).find((p) => p.provider.name === name);
  if (!found) throw new Error(`no provider ${name}`);
  return found.link.id;
}

/** Moves a recipient's "sent" timestamp back, to simulate the passage of time. */
function sentDaysAgo(rfqId: string, linkId: string, days: number) {
  const r = findRecipient(rfqId, linkId);
  if (!r) throw new Error('no recipient');
  const when = new Date();
  when.setUTCDate(when.getUTCDate() - days);
  updateRecipient({ ...r, status: 'sent', sentAt: when.toISOString() });
}

beforeEach(() => {
  useDb(openMemoryDb());
  SimulatedErp.reset();
  const boot: Ctx = {
    user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@test.test', role: 'logistics_manager', companyIds: [] },
  };
  companyA = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['L1'] }).id;
  manager = user('Manager One', 'logistics_manager', [companyA]);

  for (const name of ['Alpha Lines', 'Beta Freight']) {
    upsertProvider(manager, companyA, {
      name,
      kind: 'Carrier',
      country: 'Egypt',
      website: null,
      generalEmail: `ops@${name.split(' ')[0].toLowerCase()}.test`,
      notes: null,
      status: 'active',
      restrictionReason: null,
      accountRef: null,
      lanes: [{ originPort: 'CNSHA', destinationPort: 'EGALY' }],
      contacts: [
        {
          name: `${name} desk`,
          email: `${name.split(' ')[0].toLowerCase()}@test.test`,
          role: null,
          isPrimary: true,
        },
      ],
    });
  }
  setSetting('reminders.afterDays', 3);
  setSetting('reminders.maxRounds', 2);
});

/* ------------------------------ The chase policy ------------------------------ */

describe('chasing policy', () => {
  const at = '2026-10-10T09:00:00.000Z';
  const base = (over: Partial<ChaseCandidate['recipient']> = {}): ChaseCandidate => ({
    providerName: 'Alpha Lines',
    recipient: {
      id: 'r1',
      rfqId: 'rfq',
      companyProviderId: 'cp1',
      status: 'sent' as RecipientStatus,
      sentAt: '2026-10-05T09:00:00.000Z', // five days before `at`
      firstResponseAt: null,
      remindersSent: 0,
      lastReminderAt: null,
      ...over,
    },
  });
  const input = (over: Partial<ChaseInput> = {}): ChaseInput => ({
    rfqStatus: 'collecting',
    responseDeadline: '2026-10-20T17:00:00.000Z',
    settings: DEFAULT_CHASE,
    now: at,
    ...over,
  });

  it('chases a provider that has been silent past the waiting period', () => {
    const v = chaseVerdict(base(), input());
    expect(v.due).toBe(true);
    if (v.due) {
      expect(v.round).toBe(1);
      expect(v.reason).toMatch(/has not replied/i);
    }
  });

  it('does not chase before the waiting period is up', () => {
    const v = chaseVerdict(base({ sentAt: '2026-10-09T09:00:00.000Z' }), input());
    expect(v.due).toBe(false);
    expect(v.reason).toMatch(/due in/i);
  });

  it('never chases a provider that already replied or declined', () => {
    expect(chaseVerdict(base({ status: 'responded' }), input()).due).toBe(false);
    const declined = chaseVerdict(base({ status: 'declined' }), input());
    expect(declined.due).toBe(false);
    expect(declined.reason).toMatch(/declined/i);
  });

  it('never chases a provider whose RFQ never went out', () => {
    expect(chaseVerdict(base({ status: 'selected' }), input()).due).toBe(false);
    const failed = chaseVerdict(base({ status: 'send_failed' }), input());
    expect(failed.due).toBe(false);
    expect(failed.reason).toMatch(/never went out/i);
  });

  it('stops at the configured number of rounds', () => {
    const v = chaseVerdict(
      base({ remindersSent: 2, lastReminderAt: '2026-10-01T09:00:00.000Z' }),
      input(),
    );
    expect(v.due).toBe(false);
    expect(v.reason).toMatch(/limit/i);
  });

  it('counts from the last reminder, not the original send', () => {
    // Sent long ago, but reminded yesterday: not due again yet.
    const v = chaseVerdict(
      base({ remindersSent: 1, lastReminderAt: '2026-10-09T09:00:00.000Z' }),
      input(),
    );
    expect(v.due).toBe(false);
    expect(v.reason).toMatch(/due in/i);
  });

  it('stops once the deadline has passed', () => {
    const v = chaseVerdict(base(), input({ responseDeadline: '2026-10-09T17:00:00.000Z' }));
    expect(v.due).toBe(false);
    expect(v.reason).toMatch(/deadline has passed/i);
  });

  it('does not chase on a request that is no longer collecting', () => {
    expect(chaseVerdict(base(), input({ rfqStatus: 'closed' })).due).toBe(false);
    expect(chaseVerdict(base(), input({ rfqStatus: 'completed' })).due).toBe(false);
  });

  it('is switched off entirely when maxRounds is zero', () => {
    const v = chaseVerdict(base(), input({ settings: { afterDays: 3, maxRounds: 0 } }));
    expect(v.due).toBe(false);
    expect(v.reason).toMatch(/switched off/i);
  });
});

/* --------------------------- The guarantees that matter ------------------------ */

describe('automation cannot act for a person', () => {
  it('is refused by the approval guard', () => {
    expect(() => assertCanApprove(automationCtx())).toThrow(/Only the Logistics Operations Manager/i);
  });

  it('is refused by the send guard', () => {
    expect(() => assertCanSend(automationCtx())).toThrow(/never send one/i);
  });

  it('may still prepare work', () => {
    expect(() => assertCanEdit(automationCtx())).not.toThrow();
  });

  it('cannot send an email even when a person has already approved it', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkFor(manager, companyA, 'Alpha Lines')]);
    const [email] = prepareRfqEmails(manager, rfq.id);
    approveEmail(manager, email.id);

    // The content is approved and would send for a person. It must not for automation.
    await expect(sendEmail(automationCtx(), email.id)).rejects.toThrow(/never send one/i);
    expect(getEmail(manager, email.id).status).toBe('approved');
  });

  it('is never selectable as a person', () => {
    expect(listUsers().some((u) => u.role === 'system_automation')).toBe(false);
  });
});

/* ------------------------------ Preparing reminders ---------------------------- */

describe('preparing due reminders', () => {
  async function rfqWithSilentProvider(daysAgo = 5) {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [
      linkFor(manager, companyA, 'Alpha Lines'),
      linkFor(manager, companyA, 'Beta Freight'),
    ]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      await sendEmail(manager, e.id);
    }
    sentDaysAgo(rfq.id, linkFor(manager, companyA, 'Alpha Lines'), daysAgo);
    sentDaysAgo(rfq.id, linkFor(manager, companyA, 'Beta Freight'), daysAgo);
    return rfq;
  }

  it('finds the providers that are due, with a reason for each', async () => {
    const rfq = await rfqWithSilentProvider();
    const due = dueReminders(automationCtx());
    expect(due.length).toBe(1);
    expect(due[0].reference).toBe(rfq.reference);
    expect(due[0].providers.length).toBe(2);
    expect(due[0].providers[0].reason).toBeTruthy();
  });

  it('prepares drafts that await approval and sends nothing', async () => {
    await rfqWithSilentProvider();
    const results = prepareDueReminders(automationCtx());
    const prepared = results.flatMap((r) => r.prepared);
    expect(prepared.length).toBe(2);

    const reminders = listEmails(manager).filter((e) => e.kind === 'reminder');
    expect(reminders.length).toBe(2);
    for (const r of reminders) {
      expect(r.status).toBe('awaiting_approval');
      expect(r.sentAt).toBeNull();
      expect(r.approvedHash).toBeNull();
    }
  });

  it('is safe to run twice: the second run prepares nothing new', async () => {
    await rfqWithSilentProvider();
    prepareDueReminders(automationCtx());
    const second = prepareDueReminders(automationCtx());

    expect(second.flatMap((r) => r.prepared).length).toBe(0);
    expect(second.flatMap((r) => r.skipped).length).toBe(2);
    expect(listEmails(manager).filter((e) => e.kind === 'reminder').length).toBe(2);
  });

  it('stops chasing a provider that replied in the meantime', async () => {
    const rfq = await rfqWithSilentProvider();
    const alpha = linkFor(manager, companyA, 'Alpha Lines');
    await ingestMessage(manager, {
      externalId: 'reply-1',
      threadId: null,
      inReplyTo: null,
      fromEmail: 'alpha@test.test',
      fromName: null,
      subject: `RE: ${rfq.reference}`,
      receivedAt: new Date().toISOString(),
      bodyText: `Quotation for ${rfq.reference}\nBase ocean freight: USD 1500.00 per 40HC\nTransit time: 25 days`,
      attachments: [],
      simulated: true,
    });

    const due = dueReminders(automationCtx());
    const names = due.flatMap((d) => d.providers.map((p) => p.companyProviderId));
    expect(names).not.toContain(alpha);
    expect(names.length).toBe(1);
  });

  it('records what it did under its own name, not a manager’s', async () => {
    await rfqWithSilentProvider();
    prepareDueReminders(automationCtx());
    const entry = listAudit(manager, { limit: 50 }).find((e) => e.action === 'automation.reminders_prepared');
    expect(entry).toBeTruthy();
    expect(entry?.actorName).toBe('Scheduled automation');
    expect(entry?.summary).toMatch(/needs? approval before anything is sent/i);
  });
});

/* -------------------------------- Read surfaces -------------------------------- */

describe('what automation can read', () => {
  it('reports what is waiting for approval, longest wait first', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkFor(manager, companyA, 'Alpha Lines')]);
    prepareRfqEmails(manager, rfq.id);

    const waiting = waitingApprovals(automationCtx());
    expect(waiting.length).toBe(1);
    expect(waiting[0].reference).toBe(rfq.reference);
    expect(waiting[0].stale).toBe(false);
  });

  it('flags an approval that lapsed because the email was edited', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkFor(manager, companyA, 'Alpha Lines')]);
    const [email] = prepareRfqEmails(manager, rfq.id);
    approveEmail(manager, email.id);

    editEmail(manager, email.id, { subject: 'Changed after approval' });

    const waiting = waitingApprovals(automationCtx());
    expect(waiting.length).toBe(1);
    expect(waiting[0].stale).toBe(true);
  });

  it('separates retryable ERPNext records from ones needing a person', async () => {
    setSetting('demo.erpFailFirst', true);
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkFor(manager, companyA, 'Alpha Lines')]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      await sendEmail(manager, e.id);
    }
    await ingestMessage(manager, {
      externalId: 'q1',
      threadId: null,
      inReplyTo: null,
      fromEmail: 'alpha@test.test',
      fromName: null,
      subject: `RE: ${rfq.reference}`,
      receivedAt: new Date().toISOString(),
      bodyText: `Quotation ${rfq.reference}\nBase ocean freight: USD 1500.00 per 40HC\nTransit time: 25 days\nValid until: 2099-01-01`,
      attachments: [],
      simulated: true,
    });
    for (const q of listQuotes(manager, rfq.id)) reviewQuote(manager, q.id, { fields: [], confirm: true });
    closeRfq(manager, rfq.id);
    const comparison = await createComparison(manager, rfq.id);

    const failed = await runSync(manager, comparison.id);
    expect(failed.ok).toBe(false);

    const outstanding = retryableSyncs(automationCtx());
    expect(outstanding.length).toBe(1);
    expect(outstanding[0].retryable).toBe(true);
    expect(outstanding[0].reason).toMatch(/idempotency key/i);

    const retried = await retryFailedSyncs(automationCtx());
    expect(retried.length).toBe(1);
    expect(retried[0].ok).toBe(true);

    // Nothing left to retry, and a second sweep does not attempt it again.
    expect(retryableSyncs(automationCtx()).length).toBe(0);
    expect((await retryFailedSyncs(automationCtx())).length).toBe(0);
  });

  it('summarises in one call, agreeing with the screens', async () => {
    const rfq = makeRfq(manager, companyA);
    setRecipients(manager, rfq.id, [linkFor(manager, companyA, 'Alpha Lines')]);
    prepareRfqEmails(manager, rfq.id);

    const summary = automationSummary(automationCtx());
    expect(summary.awaitingApproval).toBe(1);
    expect(summary.staleApprovals).toBe(0);
    expect(summary.providersDueAChase).toBe(0);
    expect(Array.isArray(summary.deadlinesWithin24h)).toBe(true);
  });
});
