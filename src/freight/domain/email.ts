/**
 * Preparing, approving and sending email.
 *
 * FOUR RULES, ENFORCED HERE RATHER THAN IN THE UI
 * -----------------------------------------------
 * 1. Nothing is ever sent without an explicit approval. RFQs, reminders and the
 *    comparison email all go through the same gate.
 * 2. Approval is bound to content. The hash covers the recipients, subject, body
 *    and attachment identities. Editing any of them invalidates the approval and
 *    the draft returns to "changed since approval".
 * 3. A sent email cannot be sent again. The status check and the unique
 *    idempotency key both guard it, so a double click or a retry after a
 *    successful send cannot produce a duplicate.
 * 4. One provider per email. An RFQ or reminder is addressed to exactly one
 *    provider, so no provider can ever see another's identity or quote.
 */

import { createHash } from 'node:crypto';
import type { EmailDraft, Id, Recipient } from '../types';
import { FreightError } from '../repo';

/**
 * The approval fingerprint.
 *
 * Covers exactly what a reviewer is shown. Recipients are normalised and sorted
 * so a cosmetic reordering does not invalidate an approval, but adding,
 * removing or changing an address does.
 */
export function contentHash(input: {
  to: Recipient[];
  cc: Recipient[];
  subject: string;
  bodyText: string;
  attachments: { filename: string; storageKey: string }[];
}): string {
  const addresses = (list: Recipient[]) =>
    list
      .map((r) => r.email.trim().toLowerCase())
      .sort()
      .join(',');
  const canonical = JSON.stringify({
    to: addresses(input.to),
    cc: addresses(input.cc),
    subject: input.subject.trim(),
    body: input.bodyText.replace(/\r\n/g, '\n').trimEnd(),
    attachments: input.attachments
      .map((a) => `${a.filename}:${a.storageKey}`)
      .sort()
      .join('|'),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** True when the approval on record still matches the current content. */
export function approvalIsCurrent(email: EmailDraft): boolean {
  return (
    email.approvedHash !== null &&
    email.approvedAt !== null &&
    email.approvedHash === email.contentHash
  );
}

/**
 * Recomputes the hash after an edit and downgrades the status when a previously
 * granted approval no longer applies.
 */
export function applyEdit(
  email: EmailDraft,
  patch: Partial<Pick<EmailDraft, 'to' | 'cc' | 'subject' | 'bodyText' | 'attachments'>>,
  at: string,
): EmailDraft {
  if (email.status === 'sent') {
    throw new FreightError(
      'This email has already been sent and cannot be edited. Prepare a new one if something needs to change.',
      409,
      'already_sent',
    );
  }
  const next: EmailDraft = { ...email, ...patch, updatedAt: at };
  next.contentHash = contentHash(next);

  if (next.contentHash !== email.contentHash && email.approvedHash !== null) {
    // The approval was for different content, so it no longer counts. The
    // record of who approved what is kept for the audit trail.
    next.status = 'approval_stale';
  } else if (next.status === 'failed') {
    next.status = email.approvedHash === next.contentHash ? 'approved' : 'awaiting_approval';
  }
  return next;
}

export function submitForApproval(email: EmailDraft, at: string): EmailDraft {
  if (email.status === 'sent') {
    throw new FreightError('This email has already been sent.', 409, 'already_sent');
  }
  if (email.to.length === 0) {
    throw new FreightError('Add at least one recipient before asking for approval.');
  }
  if (!email.subject.trim()) {
    throw new FreightError('Add a subject before asking for approval.');
  }
  return { ...email, status: 'awaiting_approval', updatedAt: at };
}

export function approve(email: EmailDraft, approverId: Id, at: string): EmailDraft {
  if (email.status === 'sent') {
    throw new FreightError('This email has already been sent.', 409, 'already_sent');
  }
  if (email.to.length === 0) {
    throw new FreightError('This email has no recipient, so it cannot be approved.');
  }
  return {
    ...email,
    status: 'approved',
    approvedBy: approverId,
    approvedAt: at,
    // Bind the approval to exactly what was on screen.
    approvedHash: email.contentHash,
    failureReason: null,
    updatedAt: at,
  };
}

export function withdrawApproval(email: EmailDraft, at: string): EmailDraft {
  if (email.status === 'sent') {
    throw new FreightError('This email has already been sent; approval cannot be withdrawn.', 409, 'already_sent');
  }
  return {
    ...email,
    status: 'draft',
    approvedBy: null,
    approvedAt: null,
    approvedHash: null,
    updatedAt: at,
  };
}

/**
 * The gate every send passes through.
 *
 * Throws with a message written for the person in front of the screen. Called
 * by the send route before the transport is touched, and again inside the
 * transaction that marks the email sent.
 */
export function assertSendable(email: EmailDraft): void {
  if (email.status === 'sent') {
    throw new FreightError(
      'This email has already been sent. It will not be sent a second time.',
      409,
      'already_sent',
    );
  }
  if (email.approvedHash === null) {
    throw new FreightError(
      'This email has not been approved. It must be reviewed and approved before it can be sent.',
      403,
      'not_approved',
    );
  }
  if (!approvalIsCurrent(email)) {
    throw new FreightError(
      'The recipients, subject, body or attachments changed after this email was approved, so the approval no longer applies. Review the current version and approve it again.',
      409,
      'approval_stale',
    );
  }
  if (email.to.length === 0) {
    throw new FreightError('This email has no recipient.');
  }
}

export function markSent(
  email: EmailDraft,
  result: { messageId: string; simulated: boolean },
  at: string,
): EmailDraft {
  return {
    ...email,
    status: 'sent',
    sentAt: at,
    transportMessageId: result.messageId,
    simulated: result.simulated,
    failureReason: null,
    updatedAt: at,
  };
}

export function markFailed(email: EmailDraft, reason: string, at: string): EmailDraft {
  return { ...email, status: 'failed', failureReason: reason, updatedAt: at };
}

/* ------------------------------ Body composition ---------------------------- */

export interface RfqEmailInput {
  companyName: string;
  companyAddress: string[];
  managerName: string;
  managerEmail: string;
  providerName: string;
  contactName: string | null;
  reference: string;
  originPort: string;
  destinationPort: string;
  incoterm: string;
  containers: { type: string; quantity: number; commodity: string; grossWeightKg: number | null }[];
  cargoNotes: string | null;
  targetShipFrom: string;
  targetShipTo: string;
  responseDeadline: string;
  requestedCurrency: string;
  instructions: string | null;
}

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function rfqSubject(i: { reference: string; originPort: string; destinationPort: string }): string {
  return `Request for quotation ${i.reference} - ${i.originPort} to ${i.destinationPort}`;
}

/**
 * The RFQ body.
 *
 * Written as the operations team would write it: the requirement first, the
 * deadline stated plainly, and an explicit list of the fields we need back so
 * the reply is machine-readable without the provider having to use a template.
 */
export function rfqBody(i: RfqEmailInput): string {
  const lines: string[] = [];
  lines.push(`Dear ${i.contactName ?? i.providerName},`);
  lines.push('');
  lines.push(
    `${i.companyName} is requesting a freight quotation for the shipment below. Please quote under reference ${i.reference}.`,
  );
  lines.push('');
  lines.push('SHIPPING REQUIREMENT');
  lines.push(`  Reference          ${i.reference}`);
  lines.push(`  Route              ${i.originPort} to ${i.destinationPort}`);
  lines.push(`  Incoterm           ${i.incoterm}`);
  for (const c of i.containers) {
    const weight = c.grossWeightKg ? `, ${c.grossWeightKg.toLocaleString('en-GB')} kg gross each` : '';
    lines.push(`  Equipment          ${c.quantity} x ${c.type} - ${c.commodity}${weight}`);
  }
  lines.push(`  Target shipment    ${formatDay(i.targetShipFrom)} to ${formatDay(i.targetShipTo)}`);
  if (i.cargoNotes) lines.push(`  Cargo notes        ${i.cargoNotes}`);
  lines.push('');
  lines.push('PLEASE INCLUDE IN YOUR QUOTATION');
  lines.push('  - Shipping line and service');
  lines.push(`  - Base ocean freight per container, in ${i.requestedCurrency}`);
  lines.push('  - Every surcharge separately, with the amount and what it is charged on');
  lines.push('  - Total cost per container and for the shipment');
  lines.push('  - Transit time in days, and the proposed sailing date');
  lines.push('  - Free days at destination');
  lines.push('  - Validity of the rate');
  lines.push('  - Payment terms');
  lines.push('  - What is included and what is excluded');
  lines.push('');
  lines.push(
    `Please reply by ${formatDeadline(i.responseDeadline)}. Keep ${i.reference} in the subject line so your quotation is matched to this request automatically.`,
  );
  if (i.instructions) {
    lines.push('');
    lines.push(i.instructions);
  }
  lines.push('');
  lines.push('Kind regards,');
  lines.push(i.managerName);
  lines.push('Logistics Operations');
  lines.push(i.companyName);
  for (const l of i.companyAddress) lines.push(l);
  return lines.join('\n');
}

export function reminderSubject(i: { reference: string; originPort: string; destinationPort: string }): string {
  return `Reminder: quotation ${i.reference} - ${i.originPort} to ${i.destinationPort}`;
}

export function reminderBody(i: RfqEmailInput & { sentAt: string }): string {
  const lines: string[] = [];
  lines.push(`Dear ${i.contactName ?? i.providerName},`);
  lines.push('');
  lines.push(
    `We have not yet received your quotation for ${i.reference} (${i.originPort} to ${i.destinationPort}), sent on ${formatDay(i.sentAt.slice(0, 10))}.`,
  );
  lines.push('');
  lines.push(
    `The deadline for responses is ${formatDeadline(i.responseDeadline)}. If you are not able to quote on this lane, a short reply saying so is just as helpful - it means we stop chasing.`,
  );
  lines.push('');
  lines.push('Kind regards,');
  lines.push(i.managerName);
  lines.push('Logistics Operations');
  lines.push(i.companyName);
  return lines.join('\n');
}

export interface ComparisonEmailInput {
  companyName: string;
  managerName: string;
  reference: string;
  originPort: string;
  destinationPort: string;
  baseCurrency: string;
  offersReceived: number;
  offersComparable: number;
  recommended: { providerName: string; total: number; transitDays: number | null } | null;
  cheapest: { providerName: string; total: number } | null;
  reasons: string[];
  tradeoffs: string[];
  blockedNotes: string[];
  workbookName: string | null;
}

export function comparisonSubject(i: { reference: string; originPort: string; destinationPort: string }): string {
  return `Freight comparison ${i.reference} - ${i.originPort} to ${i.destinationPort}`;
}

/**
 * The completion email to the manager.
 *
 * Deliberately leads with the caveats a decision-maker needs, not with the
 * recommendation alone, and states plainly that nothing has been booked.
 */
export function comparisonBody(i: ComparisonEmailInput): string {
  const money = (n: number) => `${i.baseCurrency} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const lines: string[] = [];
  lines.push(`${i.managerName},`);
  lines.push('');
  lines.push(
    `The freight comparison for ${i.reference} (${i.originPort} to ${i.destinationPort}) is ready. ${i.offersReceived} ${i.offersReceived === 1 ? 'offer was' : 'offers were'} received and ${i.offersComparable} could be compared on a like-for-like basis.`,
  );
  lines.push('');

  if (i.recommended) {
    lines.push('RECOMMENDED OFFER');
    lines.push(
      `  ${i.recommended.providerName} at ${money(i.recommended.total)}${i.recommended.transitDays !== null ? `, ${i.recommended.transitDays} days transit` : ''}`,
    );
    lines.push('');
    if (i.cheapest && i.cheapest.providerName !== i.recommended.providerName) {
      lines.push('CHEAPEST COMPARABLE OFFER');
      lines.push(`  ${i.cheapest.providerName} at ${money(i.cheapest.total)}`);
      lines.push('');
    }
    if (i.reasons.length > 0) {
      lines.push('WHY');
      for (const r of i.reasons) lines.push(`  - ${r}`);
      lines.push('');
    }
    if (i.tradeoffs.length > 0) {
      lines.push('TRADEOFFS');
      for (const t of i.tradeoffs) lines.push(`  - ${t}`);
      lines.push('');
    }
  } else {
    lines.push(
      'No offer could be recommended: none of the responses received are comparable on a like-for-like basis yet.',
    );
    lines.push('');
  }

  if (i.blockedNotes.length > 0) {
    lines.push('NOT INCLUDED IN THE RANKING');
    for (const n of i.blockedNotes) lines.push(`  - ${n}`);
    lines.push('');
  }

  if (i.workbookName) {
    lines.push(`The full side-by-side comparison is attached as ${i.workbookName}.`);
    lines.push('');
  }

  lines.push(
    'This is a recommendation to support your decision. No provider has been selected, nothing has been negotiated and no booking has been made.',
  );
  lines.push('');
  lines.push('Mobility Pro Command');
  lines.push(i.companyName);
  return lines.join('\n');
}
