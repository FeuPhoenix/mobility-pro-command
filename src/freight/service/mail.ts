/**
 * Approving and sending prepared email.
 *
 * Sending is the only place in this module that can affect the outside world,
 * so the order here is deliberate:
 *
 *   1. re-read the email from the database (not from the request),
 *   2. re-check the approval against the current content,
 *   3. hand it to the transport,
 *   4. record the outcome, success or failure, exactly as it happened.
 *
 * Step 1 matters: an approval check against a body supplied by the caller would
 * be no check at all.
 */

import type { EmailDraft, Id, Recipient } from '../types';
import {
  assertCanApprove,
  assertCanEdit,
  audit,
  findRecipient,
  getEmail,
  getRfq,
  getCompanyProvider,
  updateEmail,
  updateRecipient,
  updateRfq,
  now,
  FreightError,
  type Ctx,
} from '../repo';
import {
  applyEdit,
  approve as approveDraft,
  assertSendable,
  markFailed,
  markSent,
  submitForApproval,
  withdrawApproval,
} from '../domain/email';
import { resolveMailTransport, SendFailure } from '../adapters/mail';
import { readFile, fileExists } from '../files';

export function editEmail(
  ctx: Ctx,
  emailId: Id,
  patch: { to?: Recipient[]; cc?: Recipient[]; subject?: string; bodyText?: string },
): EmailDraft {
  assertCanEdit(ctx);
  const email = getEmail(ctx, emailId);
  const clean: typeof patch = {};
  if (patch.to) clean.to = normalise(patch.to);
  if (patch.cc) clean.cc = normalise(patch.cc);
  if (patch.subject !== undefined) clean.subject = patch.subject;
  if (patch.bodyText !== undefined) clean.bodyText = patch.bodyText;

  const next = applyEdit(email, clean, now());
  updateEmail(next);

  if (email.approvedHash !== null && next.status === 'approval_stale') {
    audit(ctx, {
      companyId: email.companyId,
      action: 'email.approval_invalidated',
      subject: `email:${email.id}`,
      summary:
        'The email was changed after it had been approved, so the approval no longer applies. It must be approved again before it can be sent.',
    });
  }
  return next;
}

function normalise(list: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of list) {
    const email = r.email.trim().toLowerCase();
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new FreightError(`"${r.email}" is not a valid email address.`);
    }
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ name: r.name?.trim() || null, email });
  }
  return out;
}

export function requestApproval(ctx: Ctx, emailId: Id): EmailDraft {
  assertCanEdit(ctx);
  const email = getEmail(ctx, emailId);
  const next = submitForApproval(email, now());
  updateEmail(next);
  audit(ctx, {
    companyId: email.companyId,
    action: 'email.approval_requested',
    subject: `email:${email.id}`,
    summary: `Sent the ${kindLabel(email)} to the Logistics Operations Manager for approval.`,
  });
  return next;
}

export function approveEmail(ctx: Ctx, emailId: Id): EmailDraft {
  assertCanApprove(ctx);
  const email = getEmail(ctx, emailId);
  const next = approveDraft(email, ctx.user.id, now());
  updateEmail(next);
  audit(ctx, {
    companyId: email.companyId,
    action: 'email.approved',
    subject: `email:${email.id}`,
    summary: `${ctx.user.name} approved the ${kindLabel(email)} to ${email.to.map((t) => t.email).join(', ')}.`,
    detail: { contentHash: next.approvedHash, subject: email.subject, recipients: email.to.map((t) => t.email) },
  });
  return next;
}

export function unapproveEmail(ctx: Ctx, emailId: Id): EmailDraft {
  assertCanApprove(ctx);
  const email = getEmail(ctx, emailId);
  const next = withdrawApproval(email, now());
  updateEmail(next);
  audit(ctx, {
    companyId: email.companyId,
    action: 'email.approval_withdrawn',
    subject: `email:${email.id}`,
    summary: `${ctx.user.name} withdrew approval for the ${kindLabel(email)}.`,
  });
  return next;
}

export interface SendOutcome {
  email: EmailDraft;
  ok: boolean;
  error: string | null;
  retryable: boolean;
}

/**
 * Sends one approved email.
 *
 * Failure is recorded on the email and reported honestly - the caller is never
 * told a send succeeded when the transport refused it.
 */
export async function sendEmail(ctx: Ctx, emailId: Id): Promise<SendOutcome> {
  assertCanEdit(ctx);
  // Read from storage: the approval gate must not trust anything from the caller.
  const email = getEmail(ctx, emailId);
  assertSendable(email);

  const transport = resolveMailTransport();
  const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
  for (const a of email.attachments) {
    if (!fileExists(a.storageKey)) {
      const failed = markFailed(
        email,
        `The attachment ${a.filename} is no longer stored on this server, so the email was not sent.`,
        now(),
      );
      updateEmail(failed);
      return { email: failed, ok: false, error: failed.failureReason, retryable: false };
    }
    attachments.push({ filename: a.filename, contentType: a.contentType, content: readFile(a.storageKey) });
  }

  try {
    const result = await transport.send({
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      bodyText: email.bodyText,
      attachments,
    });

    const at = now();
    // Re-check inside the write: a concurrent send must not land twice.
    const fresh = getEmail(ctx, emailId);
    if (fresh.status === 'sent') {
      return { email: fresh, ok: true, error: null, retryable: false };
    }
    const sent = markSent(fresh, result, at);
    updateEmail(sent);
    afterSend(ctx, sent);

    audit(ctx, {
      companyId: email.companyId,
      action: 'email.sent',
      subject: `email:${email.id}`,
      summary: `${result.simulated ? 'Simulated send of' : 'Sent'} the ${kindLabel(email)} to ${email.to.map((t) => t.email).join(', ')}.`,
      detail: { simulated: result.simulated, transportMessageId: result.messageId },
    });
    return { email: sent, ok: true, error: null, retryable: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The email could not be sent.';
    const retryable = err instanceof SendFailure ? err.retryable : true;
    const failed = markFailed(email, message, now());
    updateEmail(failed);

    if (email.kind === 'rfq' && email.companyProviderId) {
      const r = findRecipient(email.rfqId, email.companyProviderId);
      if (r) updateRecipient({ ...r, status: 'send_failed' });
    }
    audit(ctx, {
      companyId: email.companyId,
      action: 'email.send_failed',
      subject: `email:${email.id}`,
      summary: `The ${kindLabel(email)} to ${email.to.map((t) => t.email).join(', ')} could not be sent: ${message}`,
    });
    return { email: failed, ok: false, error: message, retryable };
  }
}

/** Moves the RFQ and recipient state along after a successful send. */
function afterSend(ctx: Ctx, email: EmailDraft): void {
  const at = email.sentAt ?? now();
  if (email.kind === 'rfq' && email.companyProviderId) {
    const r = findRecipient(email.rfqId, email.companyProviderId);
    if (r) updateRecipient({ ...r, status: 'sent', sentAt: at });
    const rfq = getRfq(ctx, email.rfqId);
    if (rfq.status === 'draft' || rfq.status === 'awaiting_approval' || rfq.status === 'sent') {
      updateRfq({ ...rfq, status: 'collecting' });
    }
  }
  if (email.kind === 'reminder' && email.companyProviderId) {
    const r = findRecipient(email.rfqId, email.companyProviderId);
    if (r) updateRecipient({ ...r, remindersSent: r.remindersSent + 1, lastReminderAt: at });
  }
  if (email.kind === 'comparison') {
    const rfq = getRfq(ctx, email.rfqId);
    if (rfq.status !== 'completed') updateRfq({ ...rfq, status: 'completed' });
  }
}

/** Sends every approved email on an RFQ, reporting each result separately. */
export async function sendApproved(ctx: Ctx, rfqId: Id, emailIds: Id[]): Promise<SendOutcome[]> {
  const out: SendOutcome[] = [];
  for (const id of emailIds) {
    const email = getEmail(ctx, id);
    if (email.rfqId !== rfqId) {
      throw new FreightError('One of those emails does not belong to this RFQ.');
    }
    if (email.status === 'sent') {
      out.push({ email, ok: true, error: null, retryable: false });
      continue;
    }
    try {
      out.push(await sendEmail(ctx, id));
    } catch (err) {
      // An unapproved email in a batch must not stop the approved ones.
      out.push({
        email,
        ok: false,
        error: err instanceof Error ? err.message : 'The email could not be sent.',
        retryable: false,
      });
    }
  }
  return out;
}

function kindLabel(email: EmailDraft): string {
  switch (email.kind) {
    case 'rfq':
      return 'RFQ email';
    case 'reminder':
      return 'reminder';
    case 'comparison':
      return 'comparison email';
  }
}

/** A short description of who an email is going to, for the approval queue. */
export function describeRecipient(ctx: Ctx, email: EmailDraft): string {
  if (email.companyProviderId) {
    try {
      return getCompanyProvider(ctx, email.companyProviderId).provider.name;
    } catch {
      return email.to[0]?.email ?? 'unknown recipient';
    }
  }
  return email.to.map((t) => t.name ?? t.email).join(', ');
}
