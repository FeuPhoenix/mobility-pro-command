/**
 * Shipping requirements, recipient selection and RFQ dispatch.
 *
 * THE OUTREACH RULE
 * -----------------
 * A provider may only be sent an RFQ when this company's relationship with it is
 * "active". Contracted, excluded and prospect providers are refused here, in the
 * service, not merely hidden in the UI - the restriction exists to stop an
 * accidental approach that cuts across a running contract, so it has to hold
 * even if a request is crafted by hand.
 */

import type {
  Company,
  EmailDraft,
  Id,
  Incoterm,
  Rfq,
  RfqRecipient,
} from '../types';
import { isContactable, RELATIONSHIP_LABEL, CONTAINER_TYPES, INCOTERMS } from '../types';
import {
  assertCanEdit,
  assertCompanyAccess,
  audit,
  deleteEmail,
  findRecipient,
  getCompany,
  getCompanyProvider,
  getRfq,
  insertRecipient,
  insertRfq,
  listCompanyProviders,
  listEmails,
  listRecipients,
  newId,
  nextRfqReference,
  now,
  updateRecipient,
  updateRfq,
  insertEmail,
  FreightError,
  tx,
  type Ctx,
} from '../repo';
import { contentHash, rfqBody, rfqSubject, reminderBody, reminderSubject } from '../domain/email';
import { getSetting } from '../db';
import { listRfqsPastDeadline } from '../repo';
import { deadlineCtx } from '../system';

export interface RfqInput {
  companyId: Id;
  title: string;
  originPort: string;
  destinationPort: string;
  incoterm: Incoterm;
  containers: { type: string; quantity: number; grossWeightKg: number | null; commodity: string }[];
  cargoNotes: string | null;
  targetShipFrom: string;
  targetShipTo: string;
  responseDeadline: string;
  instructions: string | null;
  requestedCurrency: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateRfqInput(input: RfqInput): string[] {
  const errors: string[] = [];
  if (!input.title.trim()) errors.push('Give the requirement a title so it can be recognised in a list.');
  if (!input.originPort.trim()) errors.push('An origin port is required.');
  if (!input.destinationPort.trim()) errors.push('A destination port is required.');
  if (input.originPort.trim().toUpperCase() === input.destinationPort.trim().toUpperCase()) {
    errors.push('The origin and destination ports are the same.');
  }
  if (!INCOTERMS.includes(input.incoterm)) errors.push(`"${input.incoterm}" is not a recognised Incoterm.`);
  if (input.containers.length === 0) errors.push('Add at least one container line.');
  for (const c of input.containers) {
    if (!CONTAINER_TYPES.includes(c.type as never)) {
      errors.push(`"${c.type}" is not a container type this system knows.`);
    }
    if (!Number.isInteger(c.quantity) || c.quantity < 1) {
      errors.push('Each container line needs a whole quantity of at least one.');
    }
    if (!c.commodity.trim()) errors.push('Each container line needs a commodity description.');
    if (c.grossWeightKg !== null && (c.grossWeightKg <= 0 || c.grossWeightKg > 60_000)) {
      errors.push('The gross weight per container looks wrong. Give a figure in kilograms.');
    }
  }
  if (!DAY_RE.test(input.targetShipFrom) || !DAY_RE.test(input.targetShipTo)) {
    errors.push('Target shipping dates must be given as YYYY-MM-DD.');
  } else if (input.targetShipTo < input.targetShipFrom) {
    errors.push('The end of the shipping window is before the start.');
  }
  const deadline = Date.parse(input.responseDeadline);
  if (!Number.isFinite(deadline)) {
    errors.push('A response deadline is required.');
  } else if (DAY_RE.test(input.targetShipFrom) && deadline > Date.parse(`${input.targetShipFrom}T23:59:59Z`)) {
    errors.push('The response deadline is after the shipment is due to leave. Providers would have no time to be booked.');
  }
  if (!/^[A-Z]{3}$/.test(input.requestedCurrency)) {
    errors.push('The quote currency should be a three-letter code such as USD.');
  }
  return errors;
}

export function createRfq(ctx: Ctx, input: RfqInput): Rfq {
  assertCanEdit(ctx);
  assertCompanyAccess(ctx, input.companyId);
  const errors = validateRfqInput(input);
  if (errors.length > 0) throw new FreightError(errors.join(' '));

  const company = getCompany(ctx, input.companyId);
  const at = now();
  const rfq: Rfq = {
    id: newId('rfq'),
    reference: nextRfqReference(company.code, new Date(at).getUTCFullYear()),
    companyId: input.companyId,
    title: input.title.trim(),
    originPort: input.originPort.trim().toUpperCase(),
    destinationPort: input.destinationPort.trim().toUpperCase(),
    incoterm: input.incoterm,
    containers: input.containers.map((c) => ({
      type: c.type as Rfq['containers'][number]['type'],
      quantity: c.quantity,
      grossWeightKg: c.grossWeightKg,
      commodity: c.commodity.trim(),
    })),
    cargoNotes: input.cargoNotes?.trim() || null,
    targetShipFrom: input.targetShipFrom,
    targetShipTo: input.targetShipTo,
    responseDeadline: new Date(input.responseDeadline).toISOString(),
    instructions: input.instructions?.trim() || null,
    requestedCurrency: input.requestedCurrency.toUpperCase(),
    status: 'draft',
    createdBy: ctx.user.id,
    createdAt: at,
    closedAt: null,
    closedBy: null,
  };
  insertRfq(rfq);
  audit(ctx, {
    companyId: rfq.companyId,
    action: 'rfq.created',
    subject: `rfq:${rfq.id}`,
    summary: `Created ${rfq.reference}: ${rfq.title}, ${rfq.originPort} to ${rfq.destinationPort}.`,
  });
  return rfq;
}

/* ----------------------------- Recipient selection --------------------------- */

export interface RecipientOption {
  linkId: Id;
  providerName: string;
  status: string;
  statusLabel: string;
  contactable: boolean;
  /** Why this provider cannot be contacted, when it cannot. */
  blockedReason: string | null;
  contacts: { name: string; email: string; isPrimary: boolean }[];
  /** True when the provider already covers this RFQ's lane. */
  servesLane: boolean;
  lanes: string[];
  selected: boolean;
}

/** The recipient picker: every provider, with the blocked ones visibly blocked. */
export function recipientOptions(ctx: Ctx, rfqId: Id): RecipientOption[] {
  const rfq = getRfq(ctx, rfqId);
  const chosen = new Set(listRecipients(rfq.id).map((r) => r.companyProviderId));
  return listCompanyProviders(ctx, rfq.companyId).map((p) => {
    const contactable = isContactable(p.link.status) && (p.contacts.length > 0 || p.provider.generalEmail !== null);
    let blockedReason: string | null = null;
    if (!isContactable(p.link.status)) {
      blockedReason =
        p.link.restrictionReason ??
        `This provider is marked ${RELATIONSHIP_LABEL[p.link.status]} for this company.`;
    } else if (p.contacts.length === 0 && !p.provider.generalEmail) {
      blockedReason = 'No email address is on file for this provider.';
    }
    return {
      linkId: p.link.id,
      providerName: p.provider.name,
      status: p.link.status,
      statusLabel: RELATIONSHIP_LABEL[p.link.status],
      contactable,
      blockedReason,
      contacts: p.contacts.map((c) => ({ name: c.name, email: c.email, isPrimary: c.isPrimary })),
      servesLane: p.link.lanes.some(
        (l) => l.originPort === rfq.originPort && l.destinationPort === rfq.destinationPort,
      ),
      lanes: p.link.lanes.map((l) => `${l.originPort} to ${l.destinationPort}`),
      selected: chosen.has(p.link.id),
    };
  });
}

/**
 * Sets the recipient list.
 *
 * Refuses outright if any chosen provider cannot be contacted, naming each one
 * and why, rather than quietly dropping it from the list.
 */
export function setRecipients(ctx: Ctx, rfqId: Id, linkIds: Id[]): RfqRecipient[] {
  assertCanEdit(ctx);
  const rfq = getRfq(ctx, rfqId);
  if (rfq.status !== 'draft' && rfq.status !== 'awaiting_approval') {
    throw new FreightError(
      `${rfq.reference} has already been sent, so its recipient list cannot be changed. Providers that were not included can be added to a follow-up RFQ.`,
      409,
      'already_sent',
    );
  }
  if (linkIds.length === 0) throw new FreightError('Choose at least one provider to send this RFQ to.');

  const blocked: string[] = [];
  const allowed: { linkId: Id; name: string }[] = [];
  for (const id of linkIds) {
    const view = getCompanyProvider(ctx, id);
    if (view.link.companyId !== rfq.companyId) {
      // Cross-company selection is a hard error, not a filter.
      throw new FreightError(
        'One of the selected providers belongs to a different company. Recipients must come from this company\'s own provider list.',
        403,
        'forbidden',
      );
    }
    if (!isContactable(view.link.status)) {
      blocked.push(
        `${view.provider.name} is marked ${RELATIONSHIP_LABEL[view.link.status]}${view.link.restrictionReason ? ` (${view.link.restrictionReason})` : ''}`,
      );
      continue;
    }
    if (view.contacts.length === 0 && !view.provider.generalEmail) {
      blocked.push(`${view.provider.name} has no email address on file`);
      continue;
    }
    allowed.push({ linkId: id, name: view.provider.name });
  }

  if (blocked.length > 0) {
    throw new FreightError(
      `These providers cannot be sent an RFQ: ${blocked.join('; ')}. Remove them from the selection, or change the restriction on the provider record first.`,
      409,
      'outreach_blocked',
    );
  }

  return tx(() => {
    // Removing a provider must also remove its unsent draft, or an approved
    // email could survive for someone no longer on the list.
    const current = listRecipients(rfq.id);
    const keep = new Set(allowed.map((a) => a.linkId));
    for (const r of current) {
      if (keep.has(r.companyProviderId)) continue;
      if (r.status !== 'selected') {
        throw new FreightError(
          'An RFQ has already gone out to one of the providers you are removing. It cannot be unsent.',
          409,
          'already_sent',
        );
      }
    }
    for (const email of listEmails(ctx, { rfqId: rfq.id })) {
      if (email.kind !== 'rfq' || email.status === 'sent') continue;
      if (email.companyProviderId && !keep.has(email.companyProviderId)) deleteEmail(email.id);
    }

    const at = now();
    for (const a of allowed) {
      if (findRecipient(rfq.id, a.linkId)) continue;
      insertRecipient({
        id: newId('rr'),
        rfqId: rfq.id,
        companyProviderId: a.linkId,
        status: 'selected',
        sentAt: null,
        firstResponseAt: null,
        remindersSent: 0,
        lastReminderAt: at,
      });
    }

    audit(ctx, {
      companyId: rfq.companyId,
      action: 'rfq.recipients_set',
      subject: `rfq:${rfq.id}`,
      summary: `Selected ${allowed.length} provider${allowed.length === 1 ? '' : 's'} for ${rfq.reference}: ${allowed.map((a) => a.name).join(', ')}.`,
    });
    return listRecipients(rfq.id);
  });
}

/* ------------------------------- Drafting email ------------------------------ */

function recipientsFor(ctx: Ctx, linkId: Id) {
  const view = getCompanyProvider(ctx, linkId);
  const primary = view.contacts.filter((c) => c.isPrimary);
  const secondary = view.contacts.filter((c) => !c.isPrimary);
  const to =
    primary.length > 0
      ? primary.map((c) => ({ name: c.name, email: c.email }))
      : secondary.length > 0
        ? [{ name: secondary[0].name, email: secondary[0].email }]
        : view.provider.generalEmail
          ? [{ name: view.provider.name, email: view.provider.generalEmail }]
          : [];
  const cc =
    primary.length > 0
      ? secondary.map((c) => ({ name: c.name, email: c.email }))
      : secondary.slice(1).map((c) => ({ name: c.name, email: c.email }));
  return { view, to, cc };
}

function emailInput(company: Company, rfq: Rfq, managerName: string, managerEmail: string, providerName: string, contactName: string | null) {
  return {
    companyName: company.name,
    companyAddress: company.addressLines,
    managerName,
    managerEmail,
    providerName,
    contactName,
    reference: rfq.reference,
    originPort: rfq.originPort,
    destinationPort: rfq.destinationPort,
    incoterm: rfq.incoterm,
    containers: rfq.containers.map((c) => ({
      type: c.type,
      quantity: c.quantity,
      commodity: c.commodity,
      grossWeightKg: c.grossWeightKg,
    })),
    cargoNotes: rfq.cargoNotes,
    targetShipFrom: rfq.targetShipFrom,
    targetShipTo: rfq.targetShipTo,
    responseDeadline: rfq.responseDeadline,
    requestedCurrency: rfq.requestedCurrency,
    instructions: rfq.instructions,
  };
}

/**
 * Prepares one RFQ email per selected provider.
 *
 * One email per provider is a privacy requirement, not a style choice: a single
 * email to everyone would disclose the whole provider list to each of them.
 */
export function prepareRfqEmails(ctx: Ctx, rfqId: Id): EmailDraft[] {
  assertCanEdit(ctx);
  const rfq = getRfq(ctx, rfqId);
  const company = getCompany(ctx, rfq.companyId);
  const recipients = listRecipients(rfq.id);
  if (recipients.length === 0) {
    throw new FreightError('Choose the providers to send this RFQ to before preparing the email.');
  }

  const existing = listEmails(ctx, { rfqId: rfq.id }).filter((e) => e.kind === 'rfq');
  const created: EmailDraft[] = [];
  const at = now();

  for (const r of recipients) {
    const already = existing.find((e) => e.companyProviderId === r.companyProviderId);
    if (already) {
      created.push(already);
      continue;
    }
    const { view, to, cc } = recipientsFor(ctx, r.companyProviderId);
    const input = emailInput(company, rfq, ctx.user.name, ctx.user.email, view.provider.name, to[0]?.name ?? null);
    const draft: EmailDraft = {
      id: newId('em'),
      companyId: rfq.companyId,
      rfqId: rfq.id,
      kind: 'rfq',
      companyProviderId: r.companyProviderId,
      to,
      cc,
      subject: rfqSubject(rfq),
      bodyText: rfqBody(input),
      attachments: [],
      contentHash: '',
      // Preparing an email is a request for approval: it must appear in the
      // manager's queue immediately rather than sitting invisibly as a draft.
      status: 'awaiting_approval',
      approvedBy: null,
      approvedAt: null,
      approvedHash: null,
      sentAt: null,
      transportMessageId: null,
      simulated: true,
      failureReason: null,
      // Stable per RFQ and provider, so preparing twice cannot create two sends.
      idempotencyKey: `rfq:${rfq.id}:${r.companyProviderId}`,
      createdAt: at,
      updatedAt: at,
    };
    draft.contentHash = contentHash(draft);
    insertEmail(draft);
    created.push(draft);
  }

  if (rfq.status === 'draft') {
    updateRfq({ ...rfq, status: 'awaiting_approval' });
  }
  audit(ctx, {
    companyId: rfq.companyId,
    action: 'rfq.email_prepared',
    subject: `rfq:${rfq.id}`,
    summary: `Prepared ${created.length} RFQ email${created.length === 1 ? '' : 's'} for ${rfq.reference}. Each one needs approval before it can be sent.`,
  });
  return created;
}

/** Providers on an RFQ that have not replied and are due a reminder. */
export function nonResponders(ctx: Ctx, rfqId: Id): { recipient: RfqRecipient; providerName: string }[] {
  const rfq = getRfq(ctx, rfqId);
  return listRecipients(rfq.id)
    .filter((r) => r.status === 'sent' || r.status === 'no_response')
    .map((r) => ({ recipient: r, providerName: getCompanyProvider(ctx, r.companyProviderId).provider.name }));
}

export function prepareReminders(ctx: Ctx, rfqId: Id, linkIds: Id[]): EmailDraft[] {
  assertCanEdit(ctx);
  const rfq = getRfq(ctx, rfqId);
  const company = getCompany(ctx, rfq.companyId);
  const at = now();
  const out: EmailDraft[] = [];

  for (const linkId of linkIds) {
    const recipient = findRecipient(rfq.id, linkId);
    if (!recipient) throw new FreightError('That provider is not on this RFQ.');
    if (recipient.status === 'responded') {
      throw new FreightError(
        `${getCompanyProvider(ctx, linkId).provider.name} has already replied, so a reminder would be wrong.`,
      );
    }
    if (recipient.status === 'selected') {
      throw new FreightError('The RFQ has not been sent to that provider yet, so there is nothing to remind them about.');
    }

    const round = recipient.remindersSent + 1;
    const { view, to, cc } = recipientsFor(ctx, linkId);
    const input = emailInput(company, rfq, ctx.user.name, ctx.user.email, view.provider.name, to[0]?.name ?? null);
    const draft: EmailDraft = {
      id: newId('em'),
      companyId: rfq.companyId,
      rfqId: rfq.id,
      kind: 'reminder',
      companyProviderId: linkId,
      to,
      cc,
      subject: reminderSubject(rfq),
      bodyText: reminderBody({ ...input, sentAt: recipient.sentAt ?? rfq.createdAt }),
      attachments: [],
      contentHash: '',
      status: 'awaiting_approval',
      approvedBy: null,
      approvedAt: null,
      approvedHash: null,
      sentAt: null,
      transportMessageId: null,
      simulated: true,
      failureReason: null,
      idempotencyKey: `reminder:${rfq.id}:${linkId}:${round}`,
      createdAt: at,
      updatedAt: at,
    };
    draft.contentHash = contentHash(draft);
    try {
      insertEmail(draft);
    } catch (err) {
      if (String(err).includes('UNIQUE')) {
        throw new FreightError(
          `A reminder for ${view.provider.name} is already prepared and waiting. Send or discard it before preparing another.`,
          409,
          'duplicate',
        );
      }
      throw err;
    }
    out.push(draft);
  }

  audit(ctx, {
    companyId: rfq.companyId,
    action: 'rfq.reminder_prepared',
    subject: `rfq:${rfq.id}`,
    summary: `Prepared ${out.length} reminder${out.length === 1 ? '' : 's'} for ${rfq.reference}. Each one needs approval before it can be sent.`,
  });
  return out;
}

/**
 * Closes response collection.
 *
 * The default is explicit closure by the manager: the deadline is shown and
 * counted down, but it does not close the RFQ on its own, because the customer
 * has not confirmed that rule. The `collection.autoCloseOnDeadline` setting
 * (Settings -> Optional automation) switches on `closeRfqsAtDeadline` below.
 */
export function closeRfq(ctx: Ctx, rfqId: Id): Rfq {
  if (ctx.user.role !== 'logistics_manager') {
    throw new FreightError('Only the Logistics Operations Manager can close response collection.', 403, 'forbidden');
  }
  const rfq = getRfq(ctx, rfqId);
  if (rfq.status === 'closed' || rfq.status === 'comparison_ready' || rfq.status === 'completed') {
    return rfq;
  }
  if (rfq.status === 'draft' || rfq.status === 'awaiting_approval') {
    throw new FreightError(`${rfq.reference} has not been sent yet, so there is nothing to close.`);
  }
  const at = now();
  const next: Rfq = { ...rfq, status: 'closed', closedAt: at, closedBy: ctx.user.id };
  updateRfq(next);

  // Anyone who never replied is recorded as such, so the trail is honest.
  for (const r of listRecipients(rfq.id)) {
    if (r.status === 'sent') updateRecipient({ ...r, status: 'no_response' });
  }
  audit(ctx, {
    companyId: rfq.companyId,
    action: 'rfq.closed',
    subject: `rfq:${rfq.id}`,
    summary: `Closed response collection on ${rfq.reference}.`,
  });
  return next;
}

/* ------------------------- Optional automation (settings) ------------------------ */

/**
 * Two small choices the handover left to the customer, each off by default:
 * pre-selecting providers that serve the lane, and closing collection when the
 * deadline passes. Neither sends anything or approves anything.
 */
export const PRESELECT_LANE_KEY = 'recipients.preselectLane';
export const CLOSE_AT_DEADLINE_KEY = 'collection.autoCloseOnDeadline';

/**
 * With the setting on, a new RFQ starts with every contactable provider that
 * serves its lane already selected. A manager still reviews the list, and
 * restricted providers are never included: `setRecipients` applies the same
 * rules as a hand-made selection.
 */
export function preselectLaneProviders(ctx: Ctx, rfqId: Id): number {
  if (!getSetting<boolean>(PRESELECT_LANE_KEY, false)) return 0;
  const picks = recipientOptions(ctx, rfqId)
    .filter((o) => o.contactable && o.servesLane)
    .map((o) => o.linkId);
  if (picks.length === 0) return 0;
  setRecipients(ctx, rfqId, picks);
  const rfq = getRfq(ctx, rfqId);
  audit(ctx, {
    companyId: rfq.companyId,
    action: 'rfq.recipients_preselected',
    subject: `rfq:${rfq.id}`,
    summary: `Pre-selected ${picks.length} provider${picks.length === 1 ? '' : 's'} serving ${rfq.originPort} to ${rfq.destinationPort}. Review the list before preparing email.`,
  });
  return picks.length;
}

/**
 * With the setting on, closes collection on every RFQ whose response deadline
 * has passed, as the "Response deadline (automatic)" identity. Replies that
 * arrive later are still filed, exactly as after a manual close; a manager can
 * reopen the RFQ as usual. Returns the references closed.
 */
export function closeRfqsAtDeadline(at: string = now()): string[] {
  if (!getSetting<boolean>(CLOSE_AT_DEADLINE_KEY, false)) return [];
  const ctx = deadlineCtx();
  const closed: string[] = [];
  for (const rfq of listRfqsPastDeadline(at)) {
    updateRfq({ ...rfq, status: 'closed', closedAt: at, closedBy: ctx.user.id });
    for (const r of listRecipients(rfq.id)) {
      if (r.status === 'sent') updateRecipient({ ...r, status: 'no_response' });
    }
    audit(ctx, {
      companyId: rfq.companyId,
      action: 'rfq.closed',
      subject: `rfq:${rfq.id}`,
      summary: `Closed response collection on ${rfq.reference} because its deadline passed. A manager can reopen it.`,
    });
    closed.push(rfq.reference);
  }
  return closed;
}

export function reopenRfq(ctx: Ctx, rfqId: Id): Rfq {
  if (ctx.user.role !== 'logistics_manager') {
    throw new FreightError('Only the Logistics Operations Manager can reopen an RFQ.', 403, 'forbidden');
  }
  const rfq = getRfq(ctx, rfqId);
  if (rfq.status !== 'closed' && rfq.status !== 'comparison_ready') {
    throw new FreightError('Only a closed RFQ can be reopened.');
  }
  const next: Rfq = { ...rfq, status: 'collecting', closedAt: null, closedBy: null };
  updateRfq(next);
  audit(ctx, {
    companyId: rfq.companyId,
    action: 'rfq.reopened',
    subject: `rfq:${rfq.id}`,
    summary: `Reopened ${rfq.reference} for further responses.`,
  });
  return next;
}
