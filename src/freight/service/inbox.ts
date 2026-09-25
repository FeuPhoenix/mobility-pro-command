/**
 * Collecting replies and turning them into quotations.
 *
 * Ingestion is idempotent on the transport's message id, so re-running a
 * mailbox poll cannot create the same quote twice.
 */

import type {
  EmailAttachment,
  Id,
  InboundMessage,
  Quote,
  RelationshipStatus,
} from '../types';
import {
  assertCanEdit,
  audit,
  findInboundByExternalId,
  findLinksByContactEmail,
  findRecipient,
  getCompanyProvider,
  getInbound,
  getQuote,
  getRfq,
  getRfqUnscoped,
  insertInbound,
  insertQuote,
  latestQuoteVersion,
  listEmails,
  listQuotes,
  listRecipients,
  listRfqs,
  newId,
  now,
  updateInbound,
  updateQuote,
  updateRecipient,
  FreightError,
  type Ctx,
} from '../repo';
import { matchMessage, type MatchContext } from '../domain/matching';
import { extractQuote, correctField } from '../domain/extraction';
import { storeFile, validateUpload } from '../files';

export interface IncomingMail {
  externalId: string;
  threadId: string | null;
  inReplyTo: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  receivedAt: string;
  bodyText: string;
  attachments: { filename: string; content: Buffer }[];
  simulated: boolean;
}

/** Builds the lookup tables the matcher needs. */
function matchContext(ctx: Ctx, fromEmail: string): MatchContext {
  const rfqs = listRfqs(ctx).filter(
    (r) => r.status === 'collecting' || r.status === 'sent' || r.status === 'closed',
  );
  const recipientsByRfq = new Map<Id, Id[]>();
  const threadIndex = new Map<string, { rfqId: Id; companyProviderId: Id }>();
  for (const rfq of rfqs) {
    recipientsByRfq.set(
      rfq.id,
      listRecipients(rfq.id).map((r) => r.companyProviderId),
    );
    for (const email of listEmails(ctx, { rfqId: rfq.id })) {
      if (email.status !== 'sent' || !email.transportMessageId || !email.companyProviderId) continue;
      threadIndex.set(email.transportMessageId, {
        rfqId: rfq.id,
        companyProviderId: email.companyProviderId,
      });
    }
  }
  const linksForSender = findLinksByContactEmail(fromEmail)
    .map((x) => x.link)
    .filter((l) => ctx.user.companyIds.includes(l.companyId));

  return {
    rfqs,
    recipientsByRfq,
    linksForSender,
    threadIndex,
    providerName: (id) => {
      try {
        return getCompanyProvider(ctx, id).provider.name;
      } catch {
        return 'Unknown provider';
      }
    },
  };
}

export interface IngestResult {
  message: InboundMessage;
  quote: Quote | null;
  /** Why no quote was created, when none was. */
  note: string | null;
}

export async function ingestMessage(ctx: Ctx, mail: IncomingMail): Promise<IngestResult> {
  const existing = findInboundByExternalId(mail.externalId);
  if (existing) {
    return {
      message: existing,
      quote: null,
      note: 'This message had already been collected, so it was not processed again.',
    };
  }

  const attachments: EmailAttachment[] = [];
  const rejected: string[] = [];
  for (const a of mail.attachments) {
    try {
      const { contentType } = validateUpload(a.filename, a.content.byteLength);
      attachments.push({
        filename: a.filename,
        contentType,
        storageKey: storeFile(a.filename, a.content),
        bytes: a.content.byteLength,
      });
    } catch (err) {
      // An attachment we will not accept is recorded, not silently dropped.
      rejected.push(`${a.filename}: ${err instanceof Error ? err.message : 'rejected'}`);
    }
  }

  const outcome = matchMessage(
    {
      fromEmail: mail.fromEmail,
      subject: mail.subject,
      bodyText: mail.bodyText,
      threadId: mail.threadId,
      inReplyTo: mail.inReplyTo,
    },
    matchContext(ctx, mail.fromEmail),
  );

  const at = now();
  const message: InboundMessage = {
    id: newId('in'),
    externalId: mail.externalId,
    threadId: mail.threadId,
    inReplyTo: mail.inReplyTo,
    fromEmail: mail.fromEmail.toLowerCase(),
    fromName: mail.fromName,
    subject: mail.subject,
    receivedAt: mail.receivedAt,
    bodyText: mail.bodyText + (rejected.length > 0 ? `\n\n[Attachments not accepted: ${rejected.join('; ')}]` : ''),
    attachments,
    matchStatus: outcome.status,
    matchBasis: outcome.basis,
    rfqId: outcome.rfqId,
    companyProviderId: outcome.companyProviderId,
    candidates: outcome.candidates,
    reviewedBy: null,
    reviewedAt: null,
    simulated: mail.simulated,
    createdAt: at,
  };
  insertInbound(message);

  const rfq = message.rfqId ? getRfqUnscoped(message.rfqId) : null;
  audit(ctx, {
    companyId: rfq?.companyId ?? null,
    action: 'inbox.received',
    subject: message.rfqId ? `rfq:${message.rfqId}` : `message:${message.id}`,
    summary:
      outcome.status === 'matched'
        ? `Received a reply from ${mail.fromEmail} and matched it to ${rfq?.reference ?? 'an RFQ'}.`
        : `Received a reply from ${mail.fromEmail} that needs a person to say which RFQ it belongs to.`,
    detail: { matchStatus: outcome.status, basis: outcome.basis },
  });

  if (outcome.status !== 'matched' || !message.rfqId || !message.companyProviderId) {
    return {
      message,
      quote: null,
      note: 'The reply could not be matched automatically, so no quotation was created. It is waiting in the review queue.',
    };
  }

  const quote = await createQuoteFromMessage(ctx, message);
  return { message, quote, note: null };
}

/** Extracts a quotation from an already-matched message. */
export async function createQuoteFromMessage(ctx: Ctx, message: InboundMessage): Promise<Quote> {
  if (!message.rfqId || !message.companyProviderId) {
    throw new FreightError('That message is not attached to an RFQ and provider yet.');
  }
  const rfq = getRfq(ctx, message.rfqId);
  const at = now();
  const { quote: body, aiCall } = await extractQuote({ message, at });

  // A later quotation from the same provider is a new version, not a replacement.
  const previousVersion = latestQuoteVersion(rfq.id, message.companyProviderId);
  const previous =
    previousVersion > 0
      ? (listQuotes(ctx, rfq.id).find(
          (q) => q.companyProviderId === message.companyProviderId && q.version === previousVersion,
        ) ?? null)
      : null;

  const quote: Quote = {
    ...body,
    id: newId('q'),
    companyId: rfq.companyId,
    rfqId: rfq.id,
    companyProviderId: message.companyProviderId,
    version: previousVersion + 1,
    supersedesQuoteId: previous?.id ?? null,
    createdAt: at,
  };
  insertQuote(quote);

  if (previous && previous.status !== 'superseded') {
    updateQuote({ ...previous, status: 'superseded' });
  }

  const recipient = findRecipient(rfq.id, message.companyProviderId);
  if (recipient) {
    updateRecipient({
      ...recipient,
      status: quote.status === 'declined' ? 'declined' : 'responded',
      firstResponseAt: recipient.firstResponseAt ?? message.receivedAt,
    });
  }

  const providerName = getCompanyProvider(ctx, message.companyProviderId).provider.name;
  audit(ctx, {
    companyId: rfq.companyId,
    action: quote.version > 1 ? 'quote.revised' : 'quote.received',
    subject: `rfq:${rfq.id}`,
    summary:
      quote.status === 'declined'
        ? `${providerName} declined to quote on ${rfq.reference}.`
        : quote.status === 'unreadable'
          ? `A quotation arrived from ${providerName} for ${rfq.reference} but could not be read: ${quote.unreadableReason}`
          : quote.version > 1
            ? `${providerName} sent a revised quotation for ${rfq.reference}. Version ${previousVersion} has been kept and marked superseded.`
            : `Extracted a quotation from ${providerName} for ${rfq.reference}. The figures need checking before they are compared.`,
    detail: aiCall ? { extractor: quote.extractorId, ai: aiCall } : { extractor: quote.extractorId },
  });

  return quote;
}

/** A human resolving an ambiguous or unmatched reply. */
export async function assignMessage(
  ctx: Ctx,
  messageId: Id,
  rfqId: Id,
  companyProviderId: Id,
): Promise<IngestResult> {
  assertCanEdit(ctx);
  const message = getInbound(messageId);
  if (!message) throw new FreightError('That message was not found.', 404, 'not_found');
  if (message.rfqId && message.companyProviderId && message.matchStatus === 'matched') {
    throw new FreightError('That message has already been attached to an RFQ.');
  }

  const rfq = getRfq(ctx, rfqId);
  const view = getCompanyProvider(ctx, companyProviderId);
  if (view.link.companyId !== rfq.companyId) {
    throw new FreightError('That provider does not belong to the same company as the RFQ.', 403, 'forbidden');
  }
  if (!findRecipient(rfq.id, companyProviderId)) {
    throw new FreightError(
      `${view.provider.name} was not sent ${rfq.reference}, so a quotation from them cannot be attached to it.`,
    );
  }

  const at = now();
  const updated: InboundMessage = {
    ...message,
    matchStatus: 'matched',
    matchBasis: `Attached to ${rfq.reference} by ${ctx.user.name}.`,
    rfqId: rfq.id,
    companyProviderId,
    reviewedBy: ctx.user.id,
    reviewedAt: at,
  };
  updateInbound(updated);

  audit(ctx, {
    companyId: rfq.companyId,
    action: 'inbox.assigned',
    subject: `rfq:${rfq.id}`,
    summary: `${ctx.user.name} attached the reply from ${message.fromEmail} to ${rfq.reference} as ${view.provider.name}.`,
  });

  const quote = await createQuoteFromMessage(ctx, updated);
  return { message: updated, quote, note: null };
}

/* ------------------------------ Quote review --------------------------------- */

export interface FieldCorrection {
  field: string;
  value: string | number | null;
}

export interface SurchargeCorrection {
  code: string;
  label: string;
  amount: number | null;
  currency: string | null;
  basis: string;
}

/**
 * Applies a reviewer's corrections.
 *
 * Corrections persist on the quote and therefore flow straight into any
 * comparison built afterwards - the comparison always reads the current quote,
 * never a cached copy of the machine's first reading.
 */
export function reviewQuote(
  ctx: Ctx,
  quoteId: Id,
  input: { fields: FieldCorrection[]; surcharges?: SurchargeCorrection[]; confirm: boolean },
): Quote {
  assertCanEdit(ctx);
  const quote = getQuote(ctx, quoteId);
  if (quote.status === 'superseded') {
    throw new FreightError(
      'This version has been superseded by a newer quotation from the same provider. Review the current version instead.',
    );
  }
  const at = now();
  const next: Quote = { ...quote };
  const changed: string[] = [];

  for (const c of input.fields) {
    const key = c.field as keyof Quote;
    const current = next[key];
    if (!isExtracted(current)) {
      throw new FreightError(`"${c.field}" is not a field that can be corrected.`);
    }
    const coerced = coerce(c.field, c.value);
    if (coerced !== current.value) changed.push(c.field);
    (next as unknown as Record<string, unknown>)[c.field] = correctField(current, coerced, ctx.user.id, at);
  }

  if (input.surcharges) {
    next.surcharges = input.surcharges.map((s) => ({
      code: s.code,
      label: s.label,
      amount: s.amount,
      currency: s.currency,
      basis: s.basis as Quote['surcharges'][number]['basis'],
      sourceRef: quote.surcharges.find((x) => x.code === s.code)?.sourceRef ?? 'entered during review',
      confidence: s.amount === null ? 'missing' : 'high',
    }));
    changed.push('surcharges');
  }

  if (input.confirm) {
    if (next.status === 'unreadable' && next.baseFreight.value === null) {
      throw new FreightError(
        'This quotation could not be read and no figures have been entered yet, so there is nothing to confirm. Enter the base freight at least, or leave it flagged.',
      );
    }
    next.status = 'confirmed';
    next.reviewedBy = ctx.user.id;
    next.reviewedAt = at;
  }

  updateQuote(next);

  const providerName = getCompanyProvider(ctx, quote.companyProviderId).provider.name;
  const rfq = getRfq(ctx, quote.rfqId);
  audit(ctx, {
    companyId: quote.companyId,
    action: input.confirm ? 'quote.confirmed' : 'quote.corrected',
    subject: `rfq:${quote.rfqId}`,
    summary: input.confirm
      ? `${ctx.user.name} checked the quotation from ${providerName} on ${rfq.reference}${changed.length > 0 ? ` and corrected ${changed.length} value${changed.length === 1 ? '' : 's'}` : ''}.`
      : `${ctx.user.name} corrected ${changed.join(', ')} on the quotation from ${providerName}.`,
    detail: { changed },
  });
  return next;
}

function isExtracted(v: unknown): v is { value: unknown; confidence: string } {
  return typeof v === 'object' && v !== null && 'confidence' in v && 'value' in v;
}

const NUMERIC_FIELDS = new Set(['baseFreight', 'totalQuoted', 'transitDays', 'freeDaysDestination']);

function coerce(field: string, value: string | number | null): unknown {
  if (value === null || value === '') return null;
  if (NUMERIC_FIELDS.has(field)) {
    const n = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/,/g, ''));
    if (!Number.isFinite(n)) throw new FreightError(`"${value}" is not a number.`);
    if (n < 0) throw new FreightError('A negative amount is not valid here.');
    return n;
  }
  if (field === 'currency') {
    const c = String(value).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new FreightError('The currency should be a three-letter code such as USD.');
    return c;
  }
  if (field === 'validUntil' || field === 'sailingDate') {
    const d = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new FreightError('Dates must be given as YYYY-MM-DD.');
    return d;
  }
  return String(value).trim();
}

/** Marks a provider's reply as a decline without inventing a quotation. */
export function markDeclined(ctx: Ctx, quoteId: Id): Quote {
  assertCanEdit(ctx);
  const quote = getQuote(ctx, quoteId);
  const next: Quote = { ...quote, status: 'declined', reviewedBy: ctx.user.id, reviewedAt: now() };
  updateQuote(next);
  const recipient = findRecipient(quote.rfqId, quote.companyProviderId);
  if (recipient) updateRecipient({ ...recipient, status: 'declined' });
  audit(ctx, {
    companyId: quote.companyId,
    action: 'quote.declined',
    subject: `rfq:${quote.rfqId}`,
    summary: `${getCompanyProvider(ctx, quote.companyProviderId).provider.name} was recorded as declining to quote.`,
  });
  return next;
}

export type { RelationshipStatus };
