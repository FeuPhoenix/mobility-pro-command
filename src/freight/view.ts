/**
 * Read models.
 *
 * The screens ask operational questions, so the server answers them directly
 * rather than shipping raw tables for the browser to reassemble:
 *
 *   - What needs my approval?
 *   - Which RFQs are waiting for responses?
 *   - Which quotes need checking?
 *   - Which comparisons are ready?
 *   - Which ERPNext records need attention?
 */

import type {
  Comparison,
  EmailDraft,
  ErpSync,
  Id,
  InboundMessage,
  Quote,
  Rfq,
  RfqRecipient,
} from './types';
import { RFQ_STATUS_LABEL } from './types';
import {
  getCompanyProvider,
  getRfqUnscoped,
  latestComparison,
  listAudit,
  listCompanies,
  listComparisons,
  listEmails,
  listInbound,
  listQuotes,
  listRecipients,
  listRfqs,
  listSyncs,
  getSyncByComparison,
  type Ctx,
} from './repo';
import { approvalIsCurrent } from './domain/email';
import { uncertainFields } from './domain/extraction';
import { mailStatusForDisplay } from './adapters/mail';
import { mailboxStatusForDisplay } from './adapters/mailbox';
import { withLastCheck } from './service/connections';
import { lastCollectionRun, type CollectionRun } from './service/collect';
import { pollSeconds } from './schedule';
import { erpStatusForDisplay } from './adapters/erpnext';
import { aiStatusForDisplay } from './adapters/ai';
import { getSetting } from './db';

/**
 * Everything a workflow may call, shown in Settings so the seam is visible
 * rather than buried in documentation. Nothing here sends or approves.
 */
export interface AutomationEndpoint {
  method: 'GET' | 'POST';
  path: string;
  purpose: string;
  /** False for a pure read. True never means "may send an email". */
  writes: boolean;
}

export const AUTOMATION_ENDPOINTS: readonly AutomationEndpoint[] = [
  { method: 'POST', path: '/api/freight/collect', purpose: 'Collect replies from the shared mailbox.', writes: true },
  { method: 'GET', path: '/api/freight/automation/summary', purpose: 'One-call summary for a briefing.', writes: false },
  { method: 'GET', path: '/api/freight/automation/approvals', purpose: 'What is waiting for the manager to approve.', writes: false },
  { method: 'GET', path: '/api/freight/automation/reminders', purpose: 'Which providers are due a chase, and why.', writes: false },
  { method: 'POST', path: '/api/freight/automation/reminders', purpose: 'Prepare draft reminders. They still need approval.', writes: true },
  { method: 'GET', path: '/api/freight/automation/erpnext', purpose: 'Records that have not reached ERPNext.', writes: false },
  { method: 'POST', path: '/api/freight/automation/erpnext', purpose: 'Retry the records that can safely be retried.', writes: true },
];

export interface ApprovalItem {
  emailId: Id;
  rfqId: Id;
  rfqReference: string;
  companyName: string;
  kind: EmailDraft['kind'];
  kindLabel: string;
  recipientLabel: string;
  subject: string;
  status: EmailDraft['status'];
  /** True when it was approved and then edited. */
  stale: boolean;
  attachments: number;
  createdAt: string;
}

export interface AttentionCounts {
  awaitingApproval: number;
  approvedNotSent: number;
  awaitingResponses: number;
  quotesToCheck: number;
  repliesToMatch: number;
  comparisonsReady: number;
  erpNeedsAttention: number;
  sendFailures: number;
}

export interface RfqSummary {
  id: Id;
  reference: string;
  companyId: Id;
  companyName: string;
  title: string;
  route: string;
  status: Rfq['status'];
  statusLabel: string;
  responseDeadline: string;
  /** Negative once the deadline has passed. */
  hoursToDeadline: number;
  recipients: number;
  responded: number;
  quotesToCheck: number;
  comparisonReady: boolean;
  createdAt: string;
}

export interface Overview {
  counts: AttentionCounts;
  approvals: ApprovalItem[];
  waiting: RfqSummary[];
  quotesToCheck: { rfqId: Id; rfqReference: string; quoteId: Id; providerName: string; issues: string[] }[];
  repliesToMatch: { messageId: Id; fromEmail: string; subject: string; receivedAt: string; basis: string }[];
  comparisonsReady: { rfqId: Id; rfqReference: string; comparisonId: Id; recommended: string | null; emailPrepared: boolean }[];
  erp: { syncId: Id; comparisonId: Id; rfqReference: string; status: ErpSync['status']; attempts: number; error: string | null; simulated: boolean }[];
  rfqs: RfqSummary[];
}

function companyNameMap(ctx: Ctx): Map<Id, string> {
  return new Map(listCompanies(ctx).map((c) => [c.id, c.name]));
}

function providerNameSafe(ctx: Ctx, linkId: Id): string {
  try {
    return getCompanyProvider(ctx, linkId).provider.name;
  } catch {
    return 'Unknown provider';
  }
}

const KIND_LABEL: Record<EmailDraft['kind'], string> = {
  rfq: 'RFQ',
  reminder: 'Reminder',
  comparison: 'Comparison',
};

export function buildOverview(ctx: Ctx, companyId?: Id): Overview {
  const companies = companyNameMap(ctx);
  const rfqs = listRfqs(ctx).filter((r) => (companyId ? r.companyId === companyId : true));
  const rfqById = new Map(rfqs.map((r) => [r.id, r]));

  const summaries: RfqSummary[] = rfqs.map((rfq) => {
    const recipients = listRecipients(rfq.id);
    const quotes = listQuotes(ctx, rfq.id);
    const comparison = latestComparison(ctx, rfq.id);
    return {
      id: rfq.id,
      reference: rfq.reference,
      companyId: rfq.companyId,
      companyName: companies.get(rfq.companyId) ?? 'Unknown company',
      title: rfq.title,
      route: `${rfq.originPort} to ${rfq.destinationPort}`,
      status: rfq.status,
      statusLabel: RFQ_STATUS_LABEL[rfq.status],
      responseDeadline: rfq.responseDeadline,
      hoursToDeadline: Math.round((Date.parse(rfq.responseDeadline) - Date.now()) / 3_600_000),
      recipients: recipients.length,
      responded: recipients.filter((r) => r.status === 'responded' || r.status === 'declined').length,
      quotesToCheck: quotes.filter((q) => q.status === 'needs_review' || q.status === 'unreadable').length,
      comparisonReady: comparison !== null,
      createdAt: rfq.createdAt,
    };
  });

  /* ------------------------------ Approvals -------------------------------- */

  const approvals: ApprovalItem[] = [];
  let approvedNotSent = 0;
  let sendFailures = 0;

  for (const email of listEmails(ctx)) {
    const rfq = rfqById.get(email.rfqId);
    if (!rfq) continue;
    if (email.status === 'sent') continue;
    if (email.status === 'approved') approvedNotSent += 1;
    if (email.status === 'failed') sendFailures += 1;

    const needsApproval =
      email.status === 'awaiting_approval' ||
      email.status === 'approval_stale' ||
      (email.status === 'draft' && email.kind === 'comparison');

    if (!needsApproval && email.status !== 'approved' && email.status !== 'failed') continue;

    approvals.push({
      emailId: email.id,
      rfqId: email.rfqId,
      rfqReference: rfq.reference,
      companyName: companies.get(email.companyId) ?? 'Unknown company',
      kind: email.kind,
      kindLabel: KIND_LABEL[email.kind],
      recipientLabel: email.companyProviderId
        ? providerNameSafe(ctx, email.companyProviderId)
        : email.to.map((t) => t.name ?? t.email).join(', '),
      subject: email.subject,
      status: email.status,
      stale: email.approvedHash !== null && !approvalIsCurrent(email),
      attachments: email.attachments.length,
      createdAt: email.createdAt,
    });
  }

  approvals.sort((a, b) => {
    const rank = (x: ApprovalItem) =>
      x.status === 'approval_stale' ? 0 : x.status === 'awaiting_approval' ? 1 : x.status === 'failed' ? 2 : 3;
    return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt);
  });

  /* ----------------------------- Quotes to check ---------------------------- */

  const quotesToCheck: Overview['quotesToCheck'] = [];
  for (const rfq of rfqs) {
    for (const q of listQuotes(ctx, rfq.id)) {
      if (q.status !== 'needs_review' && q.status !== 'unreadable') continue;
      quotesToCheck.push({
        rfqId: rfq.id,
        rfqReference: rfq.reference,
        quoteId: q.id,
        providerName: providerNameSafe(ctx, q.companyProviderId),
        issues: q.status === 'unreadable' ? [q.unreadableReason ?? 'Could not be read.'] : uncertainFields(q),
      });
    }
  }

  /* ----------------------------- Replies to match --------------------------- */

  const repliesToMatch = listInbound(ctx)
    .filter((m) => m.matchStatus !== 'matched')
    .map((m) => ({
      messageId: m.id,
      fromEmail: m.fromEmail,
      subject: m.subject,
      receivedAt: m.receivedAt,
      basis: m.matchBasis,
    }));

  /* ---------------------------- Comparisons ready --------------------------- */

  const emailsByRfq = new Map<Id, EmailDraft[]>();
  for (const e of listEmails(ctx)) {
    emailsByRfq.set(e.rfqId, [...(emailsByRfq.get(e.rfqId) ?? []), e]);
  }

  const comparisonsReady: Overview['comparisonsReady'] = [];
  for (const rfq of rfqs) {
    const comparison = latestComparison(ctx, rfq.id);
    if (!comparison) continue;
    const emailSent = (emailsByRfq.get(rfq.id) ?? []).some(
      (e) => e.kind === 'comparison' && e.status === 'sent',
    );
    if (emailSent) continue;
    comparisonsReady.push({
      rfqId: rfq.id,
      rfqReference: rfq.reference,
      comparisonId: comparison.id,
      recommended:
        comparison.lines.find((l) => l.quoteId === comparison.recommendedQuoteId)?.providerName ?? null,
      emailPrepared: (emailsByRfq.get(rfq.id) ?? []).some((e) => e.kind === 'comparison'),
    });
  }

  /* --------------------------------- ERPNext -------------------------------- */

  const erp = listSyncs(ctx)
    .filter((s) => (companyId ? s.companyId === companyId : true))
    .map((s) => {
      const comparison = listComparisons(ctx).find((c) => c.id === s.comparisonId);
      const rfq = comparison ? rfqById.get(comparison.rfqId) ?? getRfqUnscoped(comparison.rfqId) : null;
      return {
        syncId: s.id,
        comparisonId: s.comparisonId,
        rfqReference: rfq?.reference ?? 'unknown',
        status: s.status,
        attempts: s.attempts,
        error: s.lastError,
        simulated: s.adapter === 'simulated',
      };
    });

  const counts: AttentionCounts = {
    awaitingApproval: approvals.filter(
      (a) => a.status === 'awaiting_approval' || a.status === 'approval_stale',
    ).length,
    approvedNotSent,
    awaitingResponses: summaries.filter((s) => s.status === 'collecting' || s.status === 'sent').length,
    quotesToCheck: quotesToCheck.length,
    repliesToMatch: repliesToMatch.length,
    comparisonsReady: comparisonsReady.length,
    erpNeedsAttention: erp.filter((e) => e.status === 'failed' || e.status === 'blocked' || e.status === 'pending')
      .length,
    sendFailures,
  };

  return {
    counts,
    approvals,
    waiting: summaries.filter((s) => s.status === 'collecting' || s.status === 'sent'),
    quotesToCheck,
    repliesToMatch,
    comparisonsReady,
    erp,
    rfqs: summaries,
  };
}

/* ------------------------------- RFQ detail ---------------------------------- */

export interface RecipientView {
  recipient: RfqRecipient;
  providerName: string;
  contacts: { name: string; email: string; isPrimary: boolean }[];
  email: EmailDraft | null;
  quoteId: Id | null;
}

export interface QuoteView {
  quote: Quote;
  providerName: string;
  uncertain: string[];
  /** Earlier versions from the same provider, newest first. */
  history: { id: Id; version: number; createdAt: string; status: Quote['status'] }[];
  message: InboundMessage | null;
}

export interface RfqDetail {
  rfq: Rfq;
  companyName: string;
  recipients: RecipientView[];
  quotes: QuoteView[];
  emails: EmailDraft[];
  comparison: Comparison | null;
  sync: ErpSync | null;
  timeline: { at: string; summary: string; actor: string; action: string }[];
}

export function buildRfqDetail(ctx: Ctx, rfq: Rfq): RfqDetail {
  const companies = companyNameMap(ctx);
  const allQuotes = listQuotes(ctx, rfq.id);
  const inbound = listInbound(ctx, { rfqId: rfq.id });
  const emails = listEmails(ctx, { rfqId: rfq.id });

  const recipients: RecipientView[] = listRecipients(rfq.id).map((r) => {
    let contacts: RecipientView['contacts'] = [];
    try {
      contacts = getCompanyProvider(ctx, r.companyProviderId).contacts.map((c) => ({
        name: c.name,
        email: c.email,
        isPrimary: c.isPrimary,
      }));
    } catch {
      contacts = [];
    }
    const current = allQuotes
      .filter((q) => q.companyProviderId === r.companyProviderId && q.status !== 'superseded')
      .sort((a, b) => b.version - a.version)[0];
    return {
      recipient: r,
      providerName: providerNameSafe(ctx, r.companyProviderId),
      contacts,
      email: emails.find((e) => e.kind === 'rfq' && e.companyProviderId === r.companyProviderId) ?? null,
      quoteId: current?.id ?? null,
    };
  });

  const quotes: QuoteView[] = allQuotes
    .filter((q) => q.status !== 'superseded')
    .map((q) => ({
      quote: q,
      providerName: providerNameSafe(ctx, q.companyProviderId),
      uncertain: uncertainFields(q),
      history: allQuotes
        .filter((x) => x.companyProviderId === q.companyProviderId)
        .sort((a, b) => b.version - a.version)
        .map((x) => ({ id: x.id, version: x.version, createdAt: x.createdAt, status: x.status })),
      message: q.sourceMessageId ? (inbound.find((m) => m.id === q.sourceMessageId) ?? null) : null,
    }));

  const comparison = latestComparison(ctx, rfq.id);
  const sync = comparison ? getSyncByComparison(comparison.id) : null;

  const timeline = listAudit(ctx, { subject: `rfq:${rfq.id}`, limit: 200 }).map((e) => ({
    at: e.at,
    summary: e.summary,
    actor: e.actorName,
    action: e.action,
  }));

  return {
    rfq,
    companyName: companies.get(rfq.companyId) ?? 'Unknown company',
    recipients,
    quotes,
    emails,
    comparison,
    sync,
    timeline,
  };
}

/* ------------------------------ Integrations --------------------------------- */

export interface IntegrationStatus {
  mail: ReturnType<typeof mailStatusForDisplay>;
  mailbox: ReturnType<typeof mailboxStatusForDisplay>;
  collection: {
    /** Seconds between scheduled runs, or null when no schedule is running. */
    pollSeconds: number | null;
    externalTrigger: boolean;
    lastRun: CollectionRun | null;
  };
  erp: ReturnType<typeof erpStatusForDisplay>;
  ai: ReturnType<typeof aiStatusForDisplay>;
  /** The surface scheduled automation (n8n, cron) may reach. */
  automation: {
    enabled: boolean;
    /** Paths a workflow may call, with what each one is allowed to do. */
    endpoints: readonly AutomationEndpoint[];
  };
  demoMode: boolean;
}

export function integrationStatus(): IntegrationStatus {
  return {
    mail: withLastCheck('mail', mailStatusForDisplay()),
    mailbox: withLastCheck('mailbox', mailboxStatusForDisplay()),
    collection: {
      pollSeconds: pollSeconds(),
      externalTrigger: Boolean(process.env.MAILBOX_COLLECT_TOKEN),
      lastRun: lastCollectionRun(),
    },
    erp: erpStatusForDisplay(),
    ai: aiStatusForDisplay(),
    automation: {
      enabled: Boolean(process.env.FREIGHT_AUTOMATION_TOKEN),
      endpoints: AUTOMATION_ENDPOINTS,
    },
    demoMode: getSetting<boolean>('demo.mode', false),
  };
}
