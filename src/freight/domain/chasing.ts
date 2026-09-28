/**
 * When a provider is due a reminder.
 *
 * WHY THIS IS HERE AND NOT IN A WORKFLOW
 * --------------------------------------
 * "Chase after three days, at most twice, and stop once the deadline has
 * passed" is a policy. Policies belong in the application: they are
 * deterministic, versioned with the code, and covered by tests. If the same
 * rule lived inside an n8n node, changing it would be invisible to the people
 * who own it and untestable by anyone.
 *
 * So n8n asks "who is due?" and this decides. The workflow supplies the clock
 * and the delivery; it never supplies the judgement.
 *
 * WHAT IT WILL NEVER DO
 * ---------------------
 * Decide to *send* anything. It marks a provider as due; a reminder is then
 * prepared as a draft and still needs a person to approve it.
 */

import type { Id, Instant, RfqRecipient, RfqStatus } from '../types';

export interface ChaseSettings {
  /** Chase only once this many days have passed since the RFQ was sent. */
  afterDays: number;
  /** Never chase a provider more than this many times. 0 disables chasing. */
  maxRounds: number;
}

export const DEFAULT_CHASE: ChaseSettings = { afterDays: 3, maxRounds: 2 };

/** Why a provider is, or is not, due a chase. Surfaced verbatim to the caller. */
export type ChaseVerdict =
  | { due: true; round: number; reason: string }
  | { due: false; reason: string };

export interface ChaseCandidate {
  recipient: RfqRecipient;
  providerName: string;
}

export interface ChaseInput {
  rfqStatus: RfqStatus;
  responseDeadline: Instant;
  settings: ChaseSettings;
  /** Evaluated against this instant, so the rule is testable without mocking. */
  now: Instant;
}

const DAY_MS = 86_400_000;

function daysSince(from: string | null, now: string): number | null {
  if (!from) return null;
  const a = Date.parse(from);
  const b = Date.parse(now);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / DAY_MS;
}

/**
 * Decides one provider.
 *
 * The order of these checks matters: the cheapest and most definitive
 * disqualifications come first, so the reason given is the most useful one.
 */
export function chaseVerdict(candidate: ChaseCandidate, input: ChaseInput): ChaseVerdict {
  const { recipient, providerName } = candidate;
  const { settings, now } = input;

  // A request that is finished, closed or not yet out is never chased.
  if (input.rfqStatus !== 'collecting' && input.rfqStatus !== 'sent') {
    return { due: false, reason: `The request is no longer collecting responses.` };
  }

  if (recipient.status === 'responded') {
    return { due: false, reason: `${providerName} has already replied.` };
  }
  if (recipient.status === 'declined') {
    return { due: false, reason: `${providerName} declined to quote, so chasing them would be wrong.` };
  }
  if (recipient.status === 'selected') {
    return { due: false, reason: `The RFQ has not been sent to ${providerName} yet.` };
  }
  if (recipient.status === 'send_failed') {
    return {
      due: false,
      reason: `The RFQ to ${providerName} never went out. Fix the send rather than chasing a message they never received.`,
    };
  }

  if (settings.maxRounds <= 0) {
    return { due: false, reason: 'Automatic chasing is switched off.' };
  }
  if (recipient.remindersSent >= settings.maxRounds) {
    return {
      due: false,
      reason: `${providerName} has already been reminded ${recipient.remindersSent} time${recipient.remindersSent === 1 ? '' : 's'}, which is the limit.`,
    };
  }

  // Past the deadline there is nothing useful to chase for; the manager closes
  // collection instead. Chasing after the fact only annoys the provider.
  if (Date.parse(input.responseDeadline) < Date.parse(now)) {
    return {
      due: false,
      reason: 'The response deadline has passed. Close collection and compare what arrived.',
    };
  }

  // Count from the last contact, whichever is more recent: the original send or
  // the previous reminder. Otherwise the second chase would fire immediately
  // after the first.
  const lastContact = recipient.lastReminderAt && recipient.remindersSent > 0
    ? recipient.lastReminderAt
    : recipient.sentAt;
  const waited = daysSince(lastContact, now);

  if (waited === null) {
    return { due: false, reason: `There is no record of when ${providerName} was last contacted.` };
  }
  if (waited < settings.afterDays) {
    const remaining = settings.afterDays - waited;
    return {
      due: false,
      reason: `${providerName} was contacted ${formatDays(waited)} ago. The policy waits ${settings.afterDays} days, so they are due in ${formatDays(remaining)}.`,
    };
  }

  const round = recipient.remindersSent + 1;
  return {
    due: true,
    round,
    reason:
      recipient.remindersSent === 0
        ? `${providerName} was sent the RFQ ${formatDays(waited)} ago and has not replied.`
        : `${providerName} was last reminded ${formatDays(waited)} ago and still has not replied.`,
  };
}

function formatDays(days: number): string {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const whole = Math.floor(days);
  return `${whole} day${whole === 1 ? '' : 's'}`;
}

export interface DueProvider {
  companyProviderId: Id;
  providerName: string;
  round: number;
  reason: string;
}

/** Everyone on one request who is due a chase right now. */
export function dueOnRfq(candidates: ChaseCandidate[], input: ChaseInput): DueProvider[] {
  const out: DueProvider[] = [];
  for (const c of candidates) {
    const verdict = chaseVerdict(c, input);
    if (!verdict.due) continue;
    out.push({
      companyProviderId: c.recipient.companyProviderId,
      providerName: c.providerName,
      round: verdict.round,
      reason: verdict.reason,
    });
  }
  return out;
}
