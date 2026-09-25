/**
 * Associating an inbound reply with the right company, RFQ and provider.
 *
 * SIGNALS, STRONGEST FIRST
 * ------------------------
 *  1. The conversation/thread id of the RFQ we sent. Unambiguous.
 *  2. The RFQ reference in the subject or body. Near-unambiguous - it is why
 *     the RFQ email asks providers to keep it in the subject line.
 *  3. The sender's address matching a known provider contact, combined with an
 *     RFQ that provider is actually a recipient of.
 *
 * A single strong signal matches. Two or more equally plausible candidates, or
 * only a weak signal, produces `ambiguous` and the message goes to a human
 * review queue with the candidates and the reason for each. Guessing here would
 * attach a provider's prices to the wrong company's RFQ, which is the one
 * mistake this module must never make silently.
 */

import type { CompanyProvider, Id, MatchCandidate, MatchStatus, Rfq } from '../types';

export interface MatchInput {
  fromEmail: string;
  subject: string;
  bodyText: string;
  threadId: string | null;
  inReplyTo: string | null;
}

export interface MatchContext {
  /** Open RFQs the reply could plausibly belong to. */
  rfqs: Rfq[];
  /** Recipients per RFQ id. */
  recipientsByRfq: Map<Id, Id[]>;
  /** Provider links reachable from the sender's address. */
  linksForSender: CompanyProvider[];
  providerName: (companyProviderId: Id) => string;
  /** Thread id recorded when the RFQ email was sent, per recipient. */
  threadIndex: Map<string, { rfqId: Id; companyProviderId: Id }>;
}

export interface MatchOutcome {
  status: MatchStatus;
  basis: string;
  rfqId: Id | null;
  companyProviderId: Id | null;
  candidates: MatchCandidate[];
}

/** Finds an RFQ reference such as RFQ-MPD-2026-0007 anywhere in the text. */
export function findReference(text: string): string | null {
  const m = /\bRFQ-[A-Z]{2,6}-\d{4}-\d{3,5}\b/i.exec(text);
  return m ? m[0].toUpperCase() : null;
}

export function matchMessage(input: MatchInput, ctx: MatchContext): MatchOutcome {
  // 1. Thread id - the reply is on the conversation we started.
  const threadKey = input.threadId ?? input.inReplyTo;
  if (threadKey) {
    const hit = ctx.threadIndex.get(threadKey);
    if (hit) {
      return {
        status: 'matched',
        basis: 'Replied on the same email conversation as the RFQ that was sent.',
        rfqId: hit.rfqId,
        companyProviderId: hit.companyProviderId,
        candidates: [],
      };
    }
  }

  // 2. The RFQ reference, in the subject first, then the body.
  const reference =
    findReference(input.subject) ?? findReference(input.bodyText);
  const referencedRfq = reference ? ctx.rfqs.find((r) => r.reference === reference) ?? null : null;

  // 3. Who the sender is. An address can legitimately belong to more than one
  //    company relationship - the same forwarder serving two of our companies.
  const senderLinks = ctx.linksForSender;

  if (referencedRfq) {
    const recipients = ctx.recipientsByRfq.get(referencedRfq.id) ?? [];
    const senderOnThisRfq = senderLinks.filter(
      (l) => l.companyId === referencedRfq.companyId && recipients.includes(l.id),
    );

    if (senderOnThisRfq.length === 1) {
      return {
        status: 'matched',
        basis: `Quoted reference ${referencedRfq.reference} and the sender is a contact for ${ctx.providerName(senderOnThisRfq[0].id)} on that RFQ.`,
        rfqId: referencedRfq.id,
        companyProviderId: senderOnThisRfq[0].id,
        candidates: [],
      };
    }

    if (senderOnThisRfq.length === 0) {
      // The reference is right but we do not recognise the sender. That is a
      // real situation - a colleague replying from a different address - and a
      // person has to say which provider it is.
      return {
        status: 'ambiguous',
        basis: `The email quotes reference ${referencedRfq.reference}, but ${input.fromEmail} is not a known contact for any provider on that RFQ. Confirm which provider this is from.`,
        rfqId: referencedRfq.id,
        companyProviderId: null,
        candidates: recipients.map((id) => ({
          rfqId: referencedRfq.id,
          rfqReference: referencedRfq.reference,
          companyProviderId: id,
          providerName: ctx.providerName(id),
          reason: 'On the recipient list for this RFQ.',
          score: 0.5,
        })),
      };
    }

    return {
      status: 'ambiguous',
      basis: `The sender's address is registered against more than one provider on ${referencedRfq.reference}.`,
      rfqId: referencedRfq.id,
      companyProviderId: null,
      candidates: senderOnThisRfq.map((l) => ({
        rfqId: referencedRfq.id,
        rfqReference: referencedRfq.reference,
        companyProviderId: l.id,
        providerName: ctx.providerName(l.id),
        reason: `${input.fromEmail} is a registered contact for this provider.`,
        score: 0.6,
      })),
    };
  }

  // No reference. Fall back to the sender, but only when it lands on exactly
  // one open RFQ - otherwise a person decides.
  const candidates: MatchCandidate[] = [];
  for (const link of senderLinks) {
    for (const rfq of ctx.rfqs) {
      if (rfq.companyId !== link.companyId) continue;
      const recipients = ctx.recipientsByRfq.get(rfq.id) ?? [];
      if (!recipients.includes(link.id)) continue;
      candidates.push({
        rfqId: rfq.id,
        rfqReference: rfq.reference,
        companyProviderId: link.id,
        providerName: ctx.providerName(link.id),
        reason: `${input.fromEmail} is a contact for this provider, which was sent this RFQ.`,
        score: 0.4,
      });
    }
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      status: 'matched',
      basis: `No reference was quoted, but ${input.fromEmail} is a contact for ${only.providerName}, which has exactly one open RFQ (${only.rfqReference}).`,
      rfqId: only.rfqId,
      companyProviderId: only.companyProviderId,
      candidates: [],
    };
  }

  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      basis: `No RFQ reference was quoted and ${input.fromEmail} has ${candidates.length} open RFQs. Choose the one this quotation belongs to.`,
      rfqId: null,
      companyProviderId: null,
      candidates: candidates.sort((a, b) => a.rfqReference.localeCompare(b.rfqReference)),
    };
  }

  return {
    status: 'unmatched',
    basis: `No RFQ reference was quoted and ${input.fromEmail} is not a registered contact for any provider. Add the contact to a provider, or attach this message to an RFQ by hand.`,
    rfqId: null,
    companyProviderId: null,
    candidates: [],
  };
}
