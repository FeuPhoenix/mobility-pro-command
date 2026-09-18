/**
 * The n8n workflows that surround this application.
 *
 * ---------------------------------------------------------------------------
 * DIVISION OF LABOUR
 * ---------------------------------------------------------------------------
 * This application owns **detection and the rules**: it decides that a document
 * disagrees with a purchase order, that a lot has aged past 180 days, or that an
 * order cannot be released under CR-4.2. Those decisions are deterministic, they
 * are versioned with the code, and they are testable.
 *
 * n8n owns **the doing**: polling ERPNext, fetching the supplier's email,
 * delivering the clarification, chasing the approver, posting the briefing, and
 * writing outcomes back. That work is I/O, it changes often, and it belongs
 * somewhere the client's own team can edit it without a deployment.
 *
 * The seam between them is a small set of HTTP calls, documented in
 * docs/N8N_INTEGRATION.md. Every workflow here has a matching importable export
 * under /n8n/.
 *
 * ---------------------------------------------------------------------------
 * HONEST STATUS
 * ---------------------------------------------------------------------------
 * Nothing here has run. There is no n8n instance connected to this demo. The run
 * history below is invented so the screen shows what the surface would look like
 * in use, and every run is flagged `simulated`.
 */

import type { Automation } from './types';

export const N8N_WORKFLOWS: Automation[] = [
  /* ----------------------------- Journey A ------------------------------- */
  {
    id: 'supplier-document-intake',
    name: 'Supplier document intake',
    purpose:
      'Watches the procurement mailbox for supplier pro forma invoices and packing lists, extracts the fields, and hands them to document control for checking against the purchase order.',
    status: 'Active',
    journey: 'Supplier documents',
    ownerId: 'U-OMAR',
    workflowFile: 'supplier-document-intake.json',
    trigger: { kind: 'email', mailbox: 'procurement@mobilitypro.example', human: 'On new email with an attachment' },
    steps: [
      { node: 'n8n-nodes-base.emailReadImap', label: 'Watch mailbox', detail: 'IMAP, filters on attachments from known supplier domains.' },
      { node: 'n8n-nodes-base.extractFromFile', label: 'Read the attachment', detail: 'Pulls text from the PDF ready for field extraction.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Extract fields', detail: 'Calls the document-extraction service and maps the result to size, ply, pattern, quantity, unit price and terms.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Post to Mobility Pro Command', detail: 'POST /api/automation/document-received — the app validates against the purchase order and returns the mismatches.' },
      { node: 'n8n-nodes-base.if', label: 'Blocking mismatch?', detail: 'Branches on the blocking count returned by the app.' },
      { node: 'n8n-nodes-base.slack', label: 'Notify procurement', detail: 'Posts the mismatch summary and a deep link to the document case.' },
    ],
    writesBack:
      'Creates the document record and its extracted fields, then lets the app run the SOP checks. The rules stay in the app.',
    guardrail:
      'Never opens a discrepancy case on its own and never contacts the supplier — a person still decides that.',
    runs: [
      { id: 'RUN-SDI-114', at: '2026-09-15T05:41:00Z', outcome: 'Success', durationMs: 8420, itemsIn: 2, itemsOut: 2, note: 'PI-ORI-88412 and PL-ORI-88412 ingested against PO-2026-0418. 4 blocking, 1 advisory returned.', simulated: true },
      { id: 'RUN-SDI-113', at: '2026-09-10T06:12:00Z', outcome: 'Success', durationMs: 6190, itemsIn: 1, itemsOut: 1, note: 'PI-STP-20714 ingested against PO-2026-0431. No mismatches.', simulated: true },
      { id: 'RUN-SDI-112', at: '2026-09-09T05:40:00Z', outcome: 'No work to do', durationMs: 910, itemsIn: 0, itemsOut: 0, note: 'No new supplier attachments.', simulated: true },
    ],
  },
  {
    id: 'supplier-clarification-dispatch',
    name: 'Supplier clarification dispatch',
    purpose:
      'Delivers the clarification a buyer has approved on a discrepancy case, then chases the supplier if no revision arrives.',
    status: 'Active',
    journey: 'Supplier documents',
    ownerId: 'U-OMAR',
    workflowFile: 'supplier-clarification-dispatch.json',
    trigger: { kind: 'webhook', path: '/webhook/mpc/clarification-approved', from: 'Mobility Pro Command' },
    steps: [
      { node: 'n8n-nodes-base.webhook', label: 'Clarification approved', detail: 'Fired by the app when a person records the draft as sent.' },
      { node: 'n8n-nodes-base.emailSend', label: 'Send to supplier', detail: 'Sends the edited draft from the procurement mailbox, threaded on the case reference.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Log on the case', detail: 'POST /api/automation/case-event so the activity trail records the delivery.' },
      { node: 'n8n-nodes-base.wait', label: 'Wait 72 hours', detail: 'Business-hours aware.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Revision received?', detail: 'GET the case; exits if a revised document has arrived.' },
      { node: 'n8n-nodes-base.slack', label: 'Chase', detail: 'Reminds the case owner that the supplier has not responded.' },
    ],
    writesBack: 'Appends delivery and follow-up events to the case activity trail.',
    guardrail:
      'Only ever sends a message a person has already reviewed and approved. It cannot compose or alter the text.',
    runs: [
      { id: 'RUN-SCD-041', at: '2026-09-16T09:02:00Z', outcome: 'Success', durationMs: 2280, itemsIn: 1, itemsOut: 1, note: 'Clarification for PI-ORI-88412 delivered to export@orientrubber.example. Follow-up armed for 19 Sept.', simulated: true },
      { id: 'RUN-SCD-040', at: '2026-08-28T14:35:00Z', outcome: 'Success', durationMs: 2510, itemsIn: 1, itemsOut: 1, note: 'Clarification delivered; revision received inside the window, chase cancelled.', simulated: true },
    ],
  },

  /* ----------------------------- Journey B ------------------------------- */
  {
    id: 'aging-stock-sweep',
    name: 'Aging stock sweep',
    purpose:
      'Pulls stock, lot ages and trailing sales from ERPNext every morning and asks the app to re-evaluate which lots have aged past the threshold.',
    status: 'Active',
    journey: 'Inventory and credit',
    ownerId: 'U-RANA',
    workflowFile: 'aging-stock-sweep.json',
    trigger: { kind: 'schedule', cron: '0 6 * * 1-6', human: 'Every day at 06:00 Africa/Cairo, Monday to Saturday' },
    steps: [
      { node: 'n8n-nodes-base.scheduleTrigger', label: 'Daily at 06:00', detail: 'Africa/Cairo, skips Sunday.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Read stock from ERPNext', detail: 'Bin and Stock Ledger Entry, scoped to the three warehouses.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Read trailing sales', detail: 'Delivery Notes for the last six months, for the shipped-rate comparison.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Post to Mobility Pro Command', detail: 'POST /api/automation/stock-snapshot — the app applies rule INV-AGE-180 and returns any new opportunities.' },
      { node: 'n8n-nodes-base.if', label: 'New opportunity?', detail: 'Only notifies on something that was not already open.' },
      { node: 'n8n-nodes-base.slack', label: 'Notify supply planning', detail: 'Posts the SKU, the lot age, the carrying value and a link.' },
    ],
    writesBack: 'Refreshes stock positions and lot ages. The ageing threshold and the rule itself stay in the app.',
    guardrail: 'Never prices, discounts, transfers or reserves anything. It reports; people decide.',
    runs: [
      { id: 'RUN-ASS-212', at: '2026-09-17T04:00:00Z', outcome: 'Success', durationMs: 14380, itemsIn: 24, itemsOut: 1, note: '24 lots evaluated. 1 open opportunity confirmed (265/70R16 10PR at Obour, 215 days).', simulated: true },
      { id: 'RUN-ASS-211', at: '2026-09-16T04:00:00Z', outcome: 'Success', durationMs: 13910, itemsIn: 24, itemsOut: 1, note: 'New opportunity raised: 265/70R16 10PR crossed 180 days at Obour.', simulated: true },
      { id: 'RUN-ASS-210', at: '2026-09-15T04:00:00Z', outcome: 'No work to do', durationMs: 12040, itemsIn: 24, itemsOut: 0, note: 'No lot crossed a threshold.', simulated: true },
    ],
  },
  {
    id: 'credit-hold-notifier',
    name: 'Credit hold notifier',
    purpose:
      'Tells finance the moment an order is withheld on credit, with the receivables evidence already assembled, so the decision does not wait on someone noticing.',
    status: 'Active',
    journey: 'Inventory and credit',
    ownerId: 'U-NOUR',
    workflowFile: 'credit-hold-notifier.json',
    trigger: { kind: 'webhook', path: '/webhook/mpc/order-held', from: 'Mobility Pro Command' },
    steps: [
      { node: 'n8n-nodes-base.webhook', label: 'Order held on credit', detail: 'Fired by the app when a credit check withholds release.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Fetch the evidence', detail: 'GET the order, the exposure build-up and the overdue invoices.' },
      { node: 'n8n-nodes-base.switch', label: 'Route by reason', detail: 'Overdue, over-limit and account-on-hold go to different people.' },
      { node: 'n8n-nodes-base.slack', label: 'Notify the credit controller', detail: 'Posts the clause, the overdue balance and the fulfilment options.' },
      { node: 'n8n-nodes-base.emailSend', label: 'Copy the account manager', detail: 'So sales know before the customer calls.' },
    ],
    writesBack: 'Records that finance was notified, and when, on the order activity trail.',
    guardrail:
      'Cannot approve, release, or alter a credit limit. It carries the evidence to a person and stops.',
    runs: [
      { id: 'RUN-CHN-088', at: '2026-09-15T11:02:00Z', outcome: 'Success', durationMs: 1840, itemsIn: 1, itemsOut: 2, note: 'SO-2026-0766 (Minya Motors, over limit) routed to Nourhan Adel and Kareem Fahmy.', simulated: true },
      { id: 'RUN-CHN-087', at: '2026-09-12T10:18:00Z', outcome: 'Success', durationMs: 1610, itemsIn: 1, itemsOut: 2, note: 'Overdue-invoice hold routed to finance.', simulated: true },
    ],
  },
  {
    id: 'approval-chaser',
    name: 'Approval chaser',
    purpose:
      'Keeps approval requests from going quiet. Reminds the named approver, then escalates if a decision is still outstanding after a working day.',
    status: 'Active',
    journey: 'Inventory and credit',
    ownerId: 'U-SAMIR',
    workflowFile: 'approval-chaser.json',
    trigger: { kind: 'schedule', cron: '0 */4 * * *', human: 'Every four hours' },
    steps: [
      { node: 'n8n-nodes-base.scheduleTrigger', label: 'Every four hours', detail: 'Business hours only.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'List pending approvals', detail: 'GET /api/automation/approvals?status=Pending.' },
      { node: 'n8n-nodes-base.filter', label: 'Older than 4 hours', detail: 'Leaves fresh requests alone.' },
      { node: 'n8n-nodes-base.slack', label: 'Remind the approver', detail: 'Direct message with the request and a decision link.' },
      { node: 'n8n-nodes-base.if', label: 'Older than 24 hours?', detail: 'Escalation branch.' },
      { node: 'n8n-nodes-base.emailSend', label: 'Escalate', detail: 'Copies the Commercial Director.' },
    ],
    writesBack: 'Nothing. It reads pending approvals and sends reminders only.',
    guardrail:
      'Cannot decide, withdraw or expire an approval. Staleness under CR-5.4 is the app’s job, not a reminder’s.',
    runs: [
      { id: 'RUN-APC-506', at: '2026-09-17T08:00:00Z', outcome: 'No work to do', durationMs: 740, itemsIn: 0, itemsOut: 0, note: 'No approvals pending longer than four hours.', simulated: true },
      { id: 'RUN-APC-505', at: '2026-09-17T04:00:00Z', outcome: 'No work to do', durationMs: 690, itemsIn: 0, itemsOut: 0, note: 'Nothing pending.', simulated: true },
      { id: 'RUN-APC-504', at: '2026-09-16T20:00:00Z', outcome: 'Success', durationMs: 1220, itemsIn: 1, itemsOut: 1, note: 'Reminded Samir Ghali about a credit release pending 5 hours.', simulated: true },
    ],
  },

  /* --------------------------- Cross-cutting ----------------------------- */
  {
    id: 'erpnext-master-sync',
    name: 'ERPNext master sync',
    purpose:
      'Keeps customers, items, warehouses, price lists and open receivables in step with ERPNext, so the decision surface is never reasoning about stale records.',
    status: 'Draft',
    journey: 'Cross-cutting',
    ownerId: 'U-OMAR',
    workflowFile: 'erpnext-master-sync.json',
    trigger: { kind: 'schedule', cron: '15 * * * *', human: 'Hourly, at quarter past' },
    steps: [
      { node: 'n8n-nodes-base.scheduleTrigger', label: 'Hourly', detail: 'Offset from the hour to avoid the ERPNext scheduler peak.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Read ERPNext doctypes', detail: 'Customer, Item, Warehouse, Item Price, Sales Invoice — modified since the last watermark.' },
      { node: 'n8n-nodes-base.code', label: 'Map to the domain model', detail: 'Applies the field mapping in docs/ERPNEXT_INTEGRATION.md.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Push the delta', detail: 'POST /api/automation/master-sync with an idempotency key per record.' },
      { node: 'n8n-nodes-base.errorTrigger', label: 'On failure', detail: 'Records the failure and alerts, rather than retrying a write blindly.' },
    ],
    writesBack: 'Refreshes reference data and receivables. It never writes into ERPNext.',
    guardrail:
      'Read-only against ERPNext. A live write path is out of scope until the discovery questions are answered.',
    runs: [
      { id: 'RUN-EMS-003', at: '2026-09-14T12:15:00Z', outcome: 'Partial', durationMs: 22100, itemsIn: 61, itemsOut: 58, note: 'Dry run against the sandbox. 3 items skipped: size and ply not found as fields on Item.', simulated: true },
      { id: 'RUN-EMS-002', at: '2026-09-11T12:15:00Z', outcome: 'Failed', durationMs: 4300, itemsIn: 0, itemsOut: 0, note: 'Dry run. Permission denied reading Sales Invoice with the supplied role profile.', simulated: true },
    ],
  },
  {
    id: 'daily-briefing',
    name: 'Daily operations briefing',
    purpose:
      'Posts the morning briefing — what needs a decision, who owns it, what is at stake — to the operations channel and to each owner.',
    status: 'Active',
    journey: 'Cross-cutting',
    ownerId: 'U-DALIA',
    workflowFile: 'daily-briefing.json',
    trigger: { kind: 'schedule', cron: '0 7 * * 1-6', human: 'Every day at 07:00 Africa/Cairo, Monday to Saturday' },
    steps: [
      { node: 'n8n-nodes-base.scheduleTrigger', label: 'Daily at 07:00', detail: 'After the aging sweep has run.' },
      { node: 'n8n-nodes-base.httpRequest', label: 'Get the briefing', detail: 'GET /api/automation/briefing — the same content the Overview shows.' },
      { node: 'n8n-nodes-base.code', label: 'Format per owner', detail: 'Groups exceptions by the person who owns the decision.' },
      { node: 'n8n-nodes-base.slack', label: 'Post to #operations', detail: 'One message, ranked, with links.' },
      { node: 'n8n-nodes-base.emailSend', label: 'Email each owner', detail: 'Only to people who have something outstanding.' },
    ],
    writesBack: 'Nothing. The briefing is generated by the app and delivered unchanged.',
    guardrail:
      'Sends only what the app produced. It does not summarise, re-rank or editorialise the figures.',
    runs: [
      { id: 'RUN-DBR-301', at: '2026-09-17T05:00:00Z', outcome: 'Success', durationMs: 3120, itemsIn: 5, itemsOut: 4, note: '5 exceptions posted to #operations; 4 owners emailed.', simulated: true },
      { id: 'RUN-DBR-300', at: '2026-09-16T05:00:00Z', outcome: 'Success', durationMs: 2980, itemsIn: 4, itemsOut: 3, note: '4 exceptions posted.', simulated: true },
    ],
  },
];

/* -------------------------------- Helpers --------------------------------- */

export function triggerLabel(a: Automation): string {
  switch (a.trigger.kind) {
    case 'schedule':
      return a.trigger.human;
    case 'webhook':
      return `Webhook from ${a.trigger.from}`;
    case 'email':
      return a.trigger.human;
  }
}

export function triggerDetail(a: Automation): string {
  switch (a.trigger.kind) {
    case 'schedule':
      return a.trigger.cron;
    case 'webhook':
      return a.trigger.path;
    case 'email':
      return a.trigger.mailbox;
  }
}

/** The most recent run, or undefined if the workflow has never been run. */
export function lastRun(a: Automation) {
  return [...a.runs].sort((x, y) => y.at.localeCompare(x.at))[0];
}
