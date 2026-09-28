/**
 * The surface scheduled automation (n8n, cron) is allowed to reach.
 *
 * THE DIVISION OF LABOUR
 * ----------------------
 * The same split the operations module already documents, applied here:
 *
 *   the application decides   |   the workflow does the I/O
 *   --------------------------|---------------------------------
 *   who is due a chase        |   runs on a schedule
 *   what the reminder says    |   tells the manager it is waiting
 *   whether a retry is safe   |   retries on a timer
 *   whether anything may send |   delivers the notification to Slack/email
 *
 * Every endpoint here either *reads* a judgement the application has made, or
 * *prepares* work that a person must still approve. None of them sends an email
 * to a provider, and none of them approves anything. That is not a convention -
 * it is enforced by the `system_automation` identity these run as, which
 * `assertCanApprove` and `assertCanSend` both refuse.
 *
 * If a workflow could send, the approval guarantee would be worth nothing: the
 * whole point is that a person sees the recipients and the body first.
 */

import type { Id } from '../types';
import {
  audit,
  getRfq,
  getCompanyProvider,
  listAllCompanyIds,
  listComparisons,
  listEmails,
  listRecipients,
  listRfqs,
  listSyncs,
  type Ctx,
} from '../repo';
import { getSetting } from '../db';
import { dueOnRfq, DEFAULT_CHASE, type ChaseSettings, type DueProvider } from '../domain/chasing';
import { prepareReminders } from './rfq';
import { runSync } from './erp';
import { approvalIsCurrent } from '../domain/email';
import { buildOverview } from '../view';

export const AUTOMATION_ID = 'system_automation';
export const AUTOMATION_NAME = 'Scheduled automation';

/**
 * The identity automation runs as.
 *
 * Built fresh per run so a company added since the last run is covered, and
 * never written to the users table, so it cannot be picked in "Acting as".
 */
export function automationCtx(): Ctx {
  return {
    user: {
      id: AUTOMATION_ID,
      name: AUTOMATION_NAME,
      title: 'System account - prepares work for a person to approve',
      email: 'automation@system.invalid',
      role: 'system_automation',
      companyIds: listAllCompanyIds(),
    },
  };
}

function chaseSettings(): ChaseSettings {
  return {
    afterDays: getSetting<number>('reminders.afterDays', DEFAULT_CHASE.afterDays),
    maxRounds: getSetting<number>('reminders.maxRounds', DEFAULT_CHASE.maxRounds),
  };
}

/* ------------------------------- Who is due ---------------------------------- */

export interface DueOnRfq {
  rfqId: Id;
  reference: string;
  companyId: Id;
  title: string;
  route: string;
  responseDeadline: string;
  hoursToDeadline: number;
  providers: DueProvider[];
}

/**
 * Providers due a chase, across every request.
 *
 * Read-only. A workflow calls this, and may then call `prepareDueReminders` to
 * turn the answer into drafts.
 */
export function dueReminders(ctx: Ctx, at = new Date().toISOString()): DueOnRfq[] {
  const settings = chaseSettings();
  const out: DueOnRfq[] = [];

  for (const rfq of listRfqs(ctx)) {
    if (rfq.status !== 'collecting' && rfq.status !== 'sent') continue;

    const candidates = listRecipients(rfq.id).map((recipient) => ({
      recipient,
      providerName: safeProviderName(ctx, recipient.companyProviderId),
    }));

    const providers = dueOnRfq(candidates, {
      rfqStatus: rfq.status,
      responseDeadline: rfq.responseDeadline,
      settings,
      now: at,
    });
    if (providers.length === 0) continue;

    out.push({
      rfqId: rfq.id,
      reference: rfq.reference,
      companyId: rfq.companyId,
      title: rfq.title,
      route: `${rfq.originPort} to ${rfq.destinationPort}`,
      responseDeadline: rfq.responseDeadline,
      hoursToDeadline: Math.round((Date.parse(rfq.responseDeadline) - Date.parse(at)) / 3_600_000),
      providers,
    });
  }
  return out;
}

function safeProviderName(ctx: Ctx, linkId: Id): string {
  try {
    return getCompanyProvider(ctx, linkId).provider.name;
  } catch {
    return 'Unknown provider';
  }
}

export interface PreparedReminders {
  rfqId: Id;
  reference: string;
  prepared: { emailId: Id; providerName: string; round: number }[];
  /** Providers that were due but could not be drafted, and why. */
  skipped: { providerName: string; reason: string }[];
}

/**
 * Turns "due" into draft reminders awaiting approval.
 *
 * It does not send them. Each draft lands in the manager's approval queue with
 * its recipients and body visible, exactly as if a person had prepared it.
 *
 * Re-running is safe: `prepareReminders` refuses a duplicate for the same
 * provider and round, and that refusal is reported as a skip rather than
 * failing the whole run.
 */
export function prepareDueReminders(
  ctx: Ctx,
  opts: { rfqId?: Id; at?: string } = {},
): PreparedReminders[] {
  const at = opts.at ?? new Date().toISOString();
  const due = dueReminders(ctx, at).filter((d) => (opts.rfqId ? d.rfqId === opts.rfqId : true));
  const results: PreparedReminders[] = [];

  for (const group of due) {
    const prepared: PreparedReminders['prepared'] = [];
    const skipped: PreparedReminders['skipped'] = [];

    // One at a time: a single provider that cannot be drafted must not stop the
    // rest of the run.
    for (const p of group.providers) {
      try {
        const [draft] = prepareReminders(ctx, group.rfqId, [p.companyProviderId]);
        if (draft) prepared.push({ emailId: draft.id, providerName: p.providerName, round: p.round });
      } catch (err) {
        skipped.push({
          providerName: p.providerName,
          reason: err instanceof Error ? err.message : 'The reminder could not be prepared.',
        });
      }
    }

    if (prepared.length > 0) {
      audit(ctx, {
        companyId: getRfq(ctx, group.rfqId).companyId,
        action: 'automation.reminders_prepared',
        subject: `rfq:${group.rfqId}`,
        summary: `Scheduled automation prepared ${prepared.length} reminder${prepared.length === 1 ? '' : 's'} on ${group.reference}. ${prepared.length === 1 ? 'It needs' : 'They need'} approval before anything is sent.`,
        detail: { prepared: prepared.map((x) => x.providerName), skipped },
      });
    }

    results.push({ rfqId: group.rfqId, reference: group.reference, prepared, skipped });
  }
  return results;
}

/* ------------------------------ What is waiting ------------------------------- */

export interface WaitingApproval {
  emailId: Id;
  rfqId: Id;
  reference: string;
  kind: string;
  recipient: string;
  subject: string;
  /** True when it was approved and then edited, so approval lapsed. */
  stale: boolean;
  waitingSinceHours: number;
}

/**
 * Emails sitting in the approval queue.
 *
 * A workflow reads this to nudge the manager somewhere they actually look.
 * It is the notification that is automated, never the approval.
 */
export function waitingApprovals(ctx: Ctx, at = new Date().toISOString()): WaitingApproval[] {
  const out: WaitingApproval[] = [];
  for (const email of listEmails(ctx)) {
    const stale = email.approvedHash !== null && !approvalIsCurrent(email);
    if (email.status !== 'awaiting_approval' && !stale) continue;

    let reference = 'unknown';
    try {
      reference = getRfq(ctx, email.rfqId).reference;
    } catch {
      continue;
    }

    out.push({
      emailId: email.id,
      rfqId: email.rfqId,
      reference,
      kind: email.kind,
      recipient: email.companyProviderId
        ? safeProviderName(ctx, email.companyProviderId)
        : email.to.map((t) => t.name ?? t.email).join(', '),
      subject: email.subject,
      stale,
      waitingSinceHours: Math.round((Date.parse(at) - Date.parse(email.updatedAt)) / 3_600_000),
    });
  }
  // Longest wait first: that is the one a nudge should lead with.
  return out.sort((a, b) => b.waitingSinceHours - a.waitingSinceHours);
}

/* ------------------------------ ERPNext retries -------------------------------- */

export interface RetryableSync {
  syncId: Id;
  comparisonId: Id;
  reference: string;
  status: string;
  attempts: number;
  lastError: string | null;
  /** False when the failure needs a human, e.g. missing configuration. */
  retryable: boolean;
  reason: string;
}

/**
 * Records that did not reach ERPNext.
 *
 * A `blocked` sync is deliberately excluded: it failed because setup is
 * incomplete, and retrying it on a timer would just fail forever while burying
 * the real message. Those are reported so a workflow can raise them instead.
 */
export function retryableSyncs(ctx: Ctx): RetryableSync[] {
  const comparisons = new Map(listComparisons(ctx).map((c) => [c.id, c]));
  const out: RetryableSync[] = [];

  for (const sync of listSyncs(ctx)) {
    if (sync.status === 'success') continue;

    const comparison = comparisons.get(sync.comparisonId);
    let reference = 'unknown';
    if (comparison) {
      try {
        reference = getRfq(ctx, comparison.rfqId).reference;
      } catch {
        /* keep 'unknown' rather than leaking another company's reference */
      }
    }

    const blocked = sync.status === 'blocked';
    out.push({
      syncId: sync.id,
      comparisonId: sync.comparisonId,
      reference,
      status: sync.status,
      attempts: sync.attempts,
      lastError: sync.lastError,
      retryable: !blocked,
      reason: blocked
        ? 'Setup is incomplete, so a retry would fail the same way. This needs a person.'
        : sync.attempts === 0
          ? 'Not attempted yet.'
          : `Failed ${sync.attempts} time${sync.attempts === 1 ? '' : 's'}. A retry is safe: the record carries an idempotency key.`,
    });
  }
  return out;
}

export interface RetryOutcome {
  comparisonId: Id;
  reference: string;
  ok: boolean;
  attempts: number;
  error: string | null;
}

/** Retries the records that can be retried. Idempotent by construction. */
export async function retryFailedSyncs(ctx: Ctx, opts: { comparisonId?: Id } = {}): Promise<RetryOutcome[]> {
  const candidates = retryableSyncs(ctx)
    .filter((s) => s.retryable)
    .filter((s) => (opts.comparisonId ? s.comparisonId === opts.comparisonId : true));

  const out: RetryOutcome[] = [];
  for (const candidate of candidates) {
    const result = await runSync(ctx, candidate.comparisonId);
    out.push({
      comparisonId: candidate.comparisonId,
      reference: candidate.reference,
      ok: result.ok,
      attempts: result.sync.attempts,
      error: result.error,
    });
  }
  return out;
}

/* --------------------------------- Summary ------------------------------------- */

export interface AutomationSummary {
  at: string;
  awaitingApproval: number;
  staleApprovals: number;
  providersDueAChase: number;
  quotesToCheck: number;
  repliesToMatch: number;
  comparisonsReady: number;
  erpNeedsAttention: number;
  /** Deadlines inside the next 24 hours, for a daily briefing. */
  deadlinesWithin24h: { reference: string; hoursToDeadline: number; outstanding: number }[];
}

/** One read for a daily briefing workflow, so it does not make six calls. */
export function automationSummary(ctx: Ctx, at = new Date().toISOString()): AutomationSummary {
  const approvals = waitingApprovals(ctx, at);
  const due = dueReminders(ctx, at);
  const syncs = retryableSyncs(ctx);

  let quotesToCheck = 0;
  let comparisonsReady = 0;
  const deadlines: AutomationSummary['deadlinesWithin24h'] = [];

  for (const rfq of listRfqs(ctx)) {
    if (rfq.status === 'collecting' || rfq.status === 'sent') {
      const hours = Math.round((Date.parse(rfq.responseDeadline) - Date.parse(at)) / 3_600_000);
      if (hours <= 24) {
        const recipients = listRecipients(rfq.id);
        deadlines.push({
          reference: rfq.reference,
          hoursToDeadline: hours,
          outstanding: recipients.filter((r) => r.status === 'sent' || r.status === 'no_response').length,
        });
      }
    }
    if (rfq.status === 'comparison_ready') comparisonsReady += 1;
  }

  // Counted through the same read model the screens use, so a briefing and the
  // overview can never disagree.
  const overview = buildOverview(ctx);
  quotesToCheck = overview.counts.quotesToCheck;

  return {
    at,
    awaitingApproval: approvals.filter((a) => !a.stale).length,
    staleApprovals: approvals.filter((a) => a.stale).length,
    providersDueAChase: due.reduce((n, d) => n + d.providers.length, 0),
    quotesToCheck,
    repliesToMatch: overview.counts.repliesToMatch,
    comparisonsReady: overview.counts.comparisonsReady,
    erpNeedsAttention: syncs.length,
    deadlinesWithin24h: deadlines.sort((a, b) => a.hoursToDeadline - b.hoursToDeadline),
  };
}
