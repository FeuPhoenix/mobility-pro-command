/**
 * The single mutation boundary for the freight module.
 *
 * Everything the browser can change goes through `applyFreightAction`. The
 * route handler does no business logic of its own, which means every rule -
 * approval, outreach restrictions, company isolation, duplicate protection -
 * is enforced in one place and is impossible to route around by calling a
 * different endpoint.
 */

import { z } from 'zod';
import type { Ctx } from './repo';
import { assertCanEdit, FreightError, getCompanyProvider, getRfq, listCompanies } from './repo';
import {
  addContact,
  commitProviderImport,
  createCompany,
  setProviderStatus,
  upsertProvider,
} from './service/providers';
import {
  closeRfq,
  createRfq,
  prepareReminders,
  prepareRfqEmails,
  recipientOptions,
  reopenRfq,
  setRecipients,
} from './service/rfq';
import { approveEmail, editEmail, requestApproval, sendApproved, sendEmail, unapproveEmail } from './service/mail';
import { assignMessage, ingestMessage, markDeclined, reviewQuote } from './service/inbox';
import { createComparison, prepareComparisonEmail } from './service/compare';
import { queueSync, runSync } from './service/erp';
import { collectInbox } from './service/collect';
import { checkConnection } from './service/connections';
import { setSetting } from './db';

const lane = z.object({ originPort: z.string().min(2), destinationPort: z.string().min(2) });
const contact = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().nullable().default(null),
  isPrimary: z.boolean().default(false),
});
const relationshipStatus = z.enum(['active', 'contracted', 'excluded', 'prospect']);

const containerLine = z.object({
  type: z.string(),
  quantity: z.number().int().positive(),
  grossWeightKg: z.number().positive().nullable().default(null),
  commodity: z.string().min(1),
});

const recipientList = z.array(z.object({ name: z.string().nullable(), email: z.string().email() }));

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('company.create'), code: z.string(), name: z.string(), country: z.string(), addressLines: z.array(z.string()).default([]) }),

  z.object({
    type: z.literal('provider.upsert'),
    companyId: z.string(),
    name: z.string().min(1),
    kind: z.string().default(''),
    country: z.string().default(''),
    website: z.string().nullable().default(null),
    generalEmail: z.string().nullable().default(null),
    notes: z.string().nullable().default(null),
    status: relationshipStatus,
    restrictionReason: z.string().nullable().default(null),
    accountRef: z.string().nullable().default(null),
    lanes: z.array(lane).default([]),
    contacts: z.array(contact).default([]),
  }),
  z.object({ type: z.literal('provider.setStatus'), linkId: z.string(), status: relationshipStatus, reason: z.string().nullable().default(null) }),
  z.object({ type: z.literal('provider.addContact'), linkId: z.string(), contact }),
  z.object({ type: z.literal('provider.commitImport'), companyId: z.string(), report: z.unknown() }),

  z.object({
    type: z.literal('rfq.create'),
    companyId: z.string(),
    title: z.string(),
    originPort: z.string(),
    destinationPort: z.string(),
    incoterm: z.string(),
    containers: z.array(containerLine).min(1),
    cargoNotes: z.string().nullable().default(null),
    targetShipFrom: z.string(),
    targetShipTo: z.string(),
    responseDeadline: z.string(),
    instructions: z.string().nullable().default(null),
    requestedCurrency: z.string().default('USD'),
  }),
  z.object({ type: z.literal('rfq.setRecipients'), rfqId: z.string(), linkIds: z.array(z.string()) }),
  z.object({ type: z.literal('rfq.prepareEmails'), rfqId: z.string() }),
  z.object({ type: z.literal('rfq.prepareReminders'), rfqId: z.string(), linkIds: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('rfq.close'), rfqId: z.string() }),
  z.object({ type: z.literal('rfq.reopen'), rfqId: z.string() }),

  z.object({
    type: z.literal('email.edit'),
    emailId: z.string(),
    to: recipientList.optional(),
    cc: recipientList.optional(),
    subject: z.string().optional(),
    bodyText: z.string().optional(),
  }),
  z.object({ type: z.literal('email.requestApproval'), emailId: z.string() }),
  z.object({ type: z.literal('email.approve'), emailId: z.string() }),
  z.object({ type: z.literal('email.unapprove'), emailId: z.string() }),
  z.object({ type: z.literal('email.send'), emailId: z.string() }),
  z.object({ type: z.literal('email.sendBatch'), rfqId: z.string(), emailIds: z.array(z.string()).min(1) }),

  z.object({ type: z.literal('inbox.assign'), messageId: z.string(), rfqId: z.string(), companyProviderId: z.string() }),

  z.object({
    type: z.literal('quote.review'),
    quoteId: z.string(),
    fields: z.array(z.object({ field: z.string(), value: z.union([z.string(), z.number(), z.null()]) })).default([]),
    surcharges: z
      .array(
        z.object({
          code: z.string(),
          label: z.string(),
          amount: z.number().nullable(),
          currency: z.string().nullable(),
          basis: z.string(),
        }),
      )
      .optional(),
    confirm: z.boolean().default(false),
  }),
  z.object({ type: z.literal('quote.markDeclined'), quoteId: z.string() }),

  z.object({
    type: z.literal('comparison.build'),
    rfqId: z.string(),
    criteria: z
      .object({
        weightCost: z.number().min(0),
        weightTransit: z.number().min(0),
        weightFreeDays: z.number().min(0),
        minValidityDays: z.number().min(0),
        baseCurrency: z.string().length(3),
      })
      .partial()
      .optional(),
    fxRates: z
      .array(
        z.object({
          from: z.string().length(3),
          to: z.string().length(3),
          rate: z.number().positive(),
          source: z.string().min(1),
          asOf: z.string(),
        }),
      )
      .optional(),
  }),
  z.object({ type: z.literal('comparison.prepareEmail'), comparisonId: z.string() }),

  z.object({ type: z.literal('erp.queue'), comparisonId: z.string() }),
  z.object({ type: z.literal('erp.sync'), comparisonId: z.string() }),

  z.object({ type: z.literal('settings.criteria'), criteria: z.object({
    weightCost: z.number().min(0),
    weightTransit: z.number().min(0),
    weightFreeDays: z.number().min(0),
    minValidityDays: z.number().min(0),
    baseCurrency: z.string().length(3),
  }) }),
  z.object({ type: z.literal('settings.fxRates'), rates: z.array(z.object({
    from: z.string().length(3),
    to: z.string().length(3),
    rate: z.number().positive(),
    source: z.string().min(1),
    asOf: z.string(),
  })) }),
  z.object({ type: z.literal('settings.reminders'), afterDays: z.number().int().min(1).max(30), maxRounds: z.number().int().min(0).max(5) }),

  z.object({ type: z.literal('mailbox.collect') }),
  z.object({ type: z.literal('connection.check'), target: z.enum(['mail', 'mailbox', 'erp']) }),

  z.object({
    type: z.literal('demo.deliverReply'),
    rfqId: z.string(),
    companyProviderId: z.string(),
    bodyText: z.string().min(1),
    subject: z.string().min(1),
    includeReference: z.boolean().default(true),
  }),
]);

export type FreightAction = z.infer<typeof ActionSchema>;

export interface ActionResult {
  ok: true;
  /** A short sentence for the toast, written in operational language. */
  message: string;
  data?: unknown;
}

export async function applyFreightAction(ctx: Ctx, action: FreightAction): Promise<ActionResult> {
  switch (action.type) {
    case 'company.create': {
      const company = createCompany(ctx, {
        code: action.code,
        name: action.name,
        country: action.country,
        addressLines: action.addressLines,
      });
      return { ok: true, message: `Added ${company.name}.`, data: company };
    }

    case 'provider.upsert': {
      const result = upsertProvider(ctx, action.companyId, {
        name: action.name,
        kind: action.kind,
        country: action.country,
        website: action.website,
        generalEmail: action.generalEmail,
        notes: action.notes,
        status: action.status,
        restrictionReason: action.restrictionReason,
        accountRef: action.accountRef,
        lanes: action.lanes,
        contacts: action.contacts,
      });
      return { ok: true, message: `Saved ${action.name}.`, data: result };
    }

    case 'provider.setStatus': {
      const link = setProviderStatus(ctx, action.linkId, action.status, action.reason);
      return { ok: true, message: 'Updated the provider.', data: link };
    }

    case 'provider.addContact': {
      const contacts = addContact(ctx, action.linkId, action.contact);
      return { ok: true, message: `Added ${action.contact.name}.`, data: contacts };
    }

    case 'provider.commitImport': {
      const report = action.report as Parameters<typeof commitProviderImport>[2];
      if (!report || !Array.isArray(report.rows)) {
        throw new FreightError('That import could not be read. Upload the file again.');
      }
      const result = commitProviderImport(ctx, action.companyId, report);
      return {
        ok: true,
        message: `Imported ${result.created} new and updated ${result.updated} provider${result.updated === 1 ? '' : 's'}${result.skipped > 0 ? `, skipping ${result.skipped} row${result.skipped === 1 ? '' : 's'} with errors` : ''}.`,
        data: result,
      };
    }

    case 'rfq.create': {
      const rfq = createRfq(ctx, {
        companyId: action.companyId,
        title: action.title,
        originPort: action.originPort,
        destinationPort: action.destinationPort,
        incoterm: action.incoterm as Parameters<typeof createRfq>[1]['incoterm'],
        containers: action.containers,
        cargoNotes: action.cargoNotes,
        targetShipFrom: action.targetShipFrom,
        targetShipTo: action.targetShipTo,
        responseDeadline: action.responseDeadline,
        instructions: action.instructions,
        requestedCurrency: action.requestedCurrency,
      });
      return { ok: true, message: `Created ${rfq.reference}.`, data: rfq };
    }

    case 'rfq.setRecipients': {
      const recipients = setRecipients(ctx, action.rfqId, action.linkIds);
      return {
        ok: true,
        message: `Selected ${recipients.length} provider${recipients.length === 1 ? '' : 's'}.`,
        data: recipients,
      };
    }

    case 'rfq.prepareEmails': {
      const emails = prepareRfqEmails(ctx, action.rfqId);
      return {
        ok: true,
        message: `Prepared ${emails.length} email${emails.length === 1 ? '' : 's'}. Each one needs approval before it can be sent.`,
        data: emails,
      };
    }

    case 'rfq.prepareReminders': {
      const emails = prepareReminders(ctx, action.rfqId, action.linkIds);
      return {
        ok: true,
        message: `Prepared ${emails.length} reminder${emails.length === 1 ? '' : 's'} for approval.`,
        data: emails,
      };
    }

    case 'rfq.close': {
      const rfq = closeRfq(ctx, action.rfqId);
      return { ok: true, message: `Closed response collection on ${rfq.reference}.`, data: rfq };
    }

    case 'rfq.reopen': {
      const rfq = reopenRfq(ctx, action.rfqId);
      return { ok: true, message: `Reopened ${rfq.reference}.`, data: rfq };
    }

    case 'email.edit': {
      const email = editEmail(ctx, action.emailId, {
        to: action.to,
        cc: action.cc,
        subject: action.subject,
        bodyText: action.bodyText,
      });
      return {
        ok: true,
        message:
          email.status === 'approval_stale'
            ? 'Saved. Because the content changed after approval, it needs approving again.'
            : 'Saved.',
        data: email,
      };
    }

    case 'email.requestApproval': {
      const email = requestApproval(ctx, action.emailId);
      return { ok: true, message: 'Sent for approval.', data: email };
    }

    case 'email.approve': {
      const email = approveEmail(ctx, action.emailId);
      return { ok: true, message: 'Approved. It is ready to send.', data: email };
    }

    case 'email.unapprove': {
      const email = unapproveEmail(ctx, action.emailId);
      return { ok: true, message: 'Approval withdrawn.', data: email };
    }

    case 'email.send': {
      const result = await sendEmail(ctx, action.emailId);
      if (!result.ok) throw new FreightError(result.error ?? 'The email could not be sent.', 502, 'send_failed');
      return {
        ok: true,
        message: result.email.simulated ? 'Sent (simulated - nothing left this machine).' : 'Sent.',
        data: result.email,
      };
    }

    case 'email.sendBatch': {
      const results = await sendApproved(ctx, action.rfqId, action.emailIds);
      const sent = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      return {
        ok: true,
        message:
          failed.length === 0
            ? `Sent ${sent} email${sent === 1 ? '' : 's'}.`
            : `Sent ${sent}, but ${failed.length} did not go out: ${failed[0].error}`,
        data: results,
      };
    }

    case 'inbox.assign': {
      const result = await assignMessage(ctx, action.messageId, action.rfqId, action.companyProviderId);
      return {
        ok: true,
        message: 'Attached to the RFQ. The quotation has been extracted and needs checking.',
        data: result,
      };
    }

    case 'quote.review': {
      const quote = reviewQuote(ctx, action.quoteId, {
        fields: action.fields,
        surcharges: action.surcharges,
        confirm: action.confirm,
      });
      return {
        ok: true,
        message: action.confirm ? 'Checked. This offer will be included in the comparison.' : 'Saved.',
        data: quote,
      };
    }

    case 'quote.markDeclined': {
      const quote = markDeclined(ctx, action.quoteId);
      return { ok: true, message: 'Recorded as declined.', data: quote };
    }

    case 'comparison.build': {
      const comparison = await createComparison(ctx, action.rfqId, {
        criteria: action.criteria,
        fxRates: action.fxRates,
      });
      const comparable = comparison.lines.filter((l) => l.comparable).length;
      return {
        ok: true,
        message: `Comparison built: ${comparable} of ${comparison.lines.length} offers could be compared.`,
        data: comparison,
      };
    }

    case 'comparison.prepareEmail': {
      const email = prepareComparisonEmail(ctx, action.comparisonId);
      return { ok: true, message: 'The comparison email is ready for your approval.', data: email };
    }

    case 'erp.queue': {
      const sync = queueSync(ctx, action.comparisonId);
      return { ok: true, message: 'Queued for recording.', data: sync };
    }

    case 'erp.sync': {
      const result = await runSync(ctx, action.comparisonId);
      if (!result.ok) {
        throw new FreightError(result.error ?? 'The record could not be written.', 502, 'erp_failed');
      }
      return {
        ok: true,
        message: result.sync.adapter === 'simulated'
          ? 'Recorded locally. This is a simulated record - nothing was written to ERPNext.'
          : `Recorded in ERPNext as ${result.sync.remoteName}.`,
        data: result.sync,
      };
    }

    case 'settings.criteria': {
      setSetting('ranking.criteria', action.criteria);
      return { ok: true, message: 'Ranking criteria saved.' };
    }

    case 'settings.fxRates': {
      setSetting('fx.rates', action.rates);
      return { ok: true, message: 'Exchange rates saved.' };
    }

    case 'settings.reminders': {
      setSetting('reminders.afterDays', action.afterDays);
      setSetting('reminders.maxRounds', action.maxRounds);
      return { ok: true, message: 'Reminder settings saved.' };
    }

    case 'mailbox.collect': {
      // The person only asks for a run. The run itself files mail as the
      // Mailbox Collector, exactly as the schedule would.
      assertCanEdit(ctx);
      const run = await collectInbox({ trigger: 'manual', requestedBy: ctx });
      if (run.outcome === 'failed') {
        throw new FreightError(`Collecting replies failed: ${run.error}`, 502, 'collect_failed');
      }
      return {
        ok: true,
        message:
          run.outcome === 'skipped'
            ? (run.error ?? 'Nothing to collect.')
            : run.filed === 0
              ? `No new replies${run.adapter === 'simulated' ? ' in the simulated mailbox' : ''}.`
              : `Collected ${run.filed} new repl${run.filed === 1 ? 'y' : 'ies'}: ${run.matched} matched, ${run.needsReview} waiting for a person.`,
        data: run,
      };
    }

    case 'connection.check': {
      const status = await checkConnection(ctx, action.target);
      return { ok: true, message: status.label, data: status };
    }

    case 'demo.deliverReply': {
      // Demonstration only: feeds a reply through the same collection pipeline
      // a real mailbox would. It never contacts anything.
      const rfq = getRfq(ctx, action.rfqId);
      const result = await ingestMessage(ctx, {
        externalId: `manual-${Date.now().toString(36)}`,
        threadId: null,
        inReplyTo: null,
        fromEmail: replyAddressFor(ctx, action.companyProviderId),
        fromName: null,
        subject: action.includeReference ? `RE: ${rfq.reference} - ${action.subject}` : action.subject,
        receivedAt: new Date().toISOString(),
        bodyText: action.includeReference
          ? action.bodyText
          : action.bodyText.replace(new RegExp(rfq.reference, 'g'), ''),
        attachments: [],
        simulated: true,
      });
      return {
        ok: true,
        message: result.quote
          ? 'Reply collected and the quotation extracted.'
          : (result.note ?? 'Reply collected.'),
        data: result,
      };
    }
  }
}

function replyAddressFor(ctx: Ctx, companyProviderId: string): string {
  const view = getCompanyProvider(ctx, companyProviderId);
  const primary = view.contacts.find((c) => c.isPrimary) ?? view.contacts[0];
  const address = primary?.email ?? view.provider.generalEmail;
  if (!address) throw new FreightError('That provider has no email address on file.');
  return address;
}

/** Companies the acting user can act on, for the picker. */
export function accessibleCompanies(ctx: Ctx) {
  return listCompanies(ctx);
}
