/**
 * Every state change in the demo passes through here.
 *
 * This is the authorisation + validation boundary. The UI and the assistant
 * call exactly the same functions, so an action prepared by the assistant is
 * subject to identical rules to one clicked in a table.
 */

import { addDays, formatDate, formatEGP, round0, round2 } from '@/domain/money';
import {
  buildCorrectedDocument,
  receivingReadiness,
  validateDocument,
} from '@/domain/documentRules';
import { approvalInputHash, checkCredit, checkStock, discountAuthority } from '@/domain/credit';
import {
  activePriceList,
  byId,
  customersWhoBought,
  orderValue,
  receivables,
  skuLabel,
  stockAt,
} from '@/domain/selectors';
import type {
  ActivityEvent,
  ApprovalRequest,
  DemoState,
  DiscrepancyCase,
  Id,
  RecordRef,
  Role,
  SalesOrder,
} from '@/domain/types';

export class ActionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ActionResult {
  ok: true;
  message: string;
  /** Where the UI should navigate after a successful action, if anywhere. */
  navigateTo?: string;
  /** Ids created by the action, for the UI to focus. */
  created?: Record<string, string>;
}

/* ------------------------------- Utilities -------------------------------- */

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36).slice(-5).toUpperCase()}${counter.toString(36).toUpperCase()}`;
}

function now(state: DemoState): string {
  // Demo clock: the pinned demo date, with a real wall-clock time of day so
  // that events within a session order correctly.
  const t = new Date().toISOString().slice(11);
  return `${state.meta.today}T${t}`;
}

/** Keeps a label from appearing twice when an option contributes the same row. */
function dedupeByLabel<T extends { label: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.label) ? false : (seen.add(r.label), true)));
}

function currentUser(state: DemoState) {
  return state.users.find((u) => u.id === state.meta.currentUserId) ?? state.users[0];
}

function requireRole(state: DemoState, roles: Role[], what: string) {
  const user = currentUser(state);
  if (!roles.includes(user.role)) {
    throw new ActionError(
      `${user.name} (${user.title}) is not authorised to ${what}. Switch to an authorised role using the role selector.`,
      403,
    );
  }
  return user;
}

function log(
  state: DemoState,
  kind: ActivityEvent['kind'],
  summary: string,
  refs: RecordRef[],
  detail?: string,
  actor?: string,
) {
  state.activity.unshift({
    id: nextId('ACT'),
    at: now(state),
    actor: actor ?? currentUser(state).name,
    kind,
    summary,
    detail,
    refs,
  });
}

/** Replace all discrepancies belonging to a document with a freshly computed set. */
function revalidateDocument(state: DemoState, documentId: Id): number {
  const doc = byId(state.documents, documentId);
  if (!doc) throw new ActionError(`Document ${documentId} not found.`, 404);
  const po = byId(state.purchaseOrders, doc.purchaseOrderId);
  if (!po) throw new ActionError(`Purchase order ${doc.purchaseOrderId} not found.`, 404);

  const previous = state.discrepancies.filter((d) => d.id.startsWith(`DSC-${doc.id}-`));
  const fresh = validateDocument(state, doc, po);

  // Preserve manual resolutions for issues that still exist.
  for (const f of fresh) {
    const old = previous.find((p) => p.id === f.id);
    if (old?.resolved && old.documentValue === f.documentValue) {
      f.resolved = true;
      f.resolvedBy = old.resolvedBy;
      f.resolvedNote = old.resolvedNote;
    }
  }

  state.discrepancies = [
    ...state.discrepancies.filter((d) => !d.id.startsWith(`DSC-${doc.id}-`)),
    ...fresh,
  ];

  // Cases track the discrepancies that exist on their document right now.
  for (const c of state.cases) {
    if (c.documentId === doc.id) c.discrepancyIds = fresh.map((f) => f.id);
  }

  return fresh.filter((f) => f.severity === 'blocking' && !f.resolved).length;
}

/** Bootstrap validation for the seeded documents the first time state is read. */
export function ensureValidated(state: DemoState): boolean {
  if (state.discrepancies.length > 0) return false;
  for (const doc of state.documents) {
    if (byId(state.purchaseOrders, doc.purchaseOrderId)) revalidateDocument(state, doc.id);
  }
  return true;
}

/* -------------------------------- Actions --------------------------------- */

export type Action =
  | { type: 'demo.setRole'; userId: Id }
  | { type: 'demo.setGuidedStep'; step: number | null }
  | { type: 'document.editField'; documentId: Id; key: string; value: string }
  | { type: 'document.confirmField'; documentId: Id; key: string }
  | { type: 'document.revalidate'; documentId: Id }
  | { type: 'case.create'; documentId: Id }
  | { type: 'case.generateDraft'; caseId: Id }
  | { type: 'case.saveDraft'; caseId: Id; subject: string; body: string }
  | { type: 'case.markSent'; caseId: Id }
  | { type: 'case.simulateCorrected'; caseId: Id }
  | { type: 'case.revalidate'; caseId: Id }
  | { type: 'case.override'; caseId: Id; reason: string }
  | { type: 'opportunity.setAssumption'; opportunityId: Id; unitsPerDiscountPoint: number; horizonMonths: number; collectionDelayDays: number }
  | { type: 'opportunity.createOrder'; opportunityId: Id; customerId: Id; qty: number; discountPct: number }
  | { type: 'order.updateLine'; orderId: Id; qty: number; discountPct: number }
  | { type: 'order.repriceToActive'; orderId: Id }
  | { type: 'order.releaseFull'; orderId: Id }
  | { type: 'order.requestApproval'; orderId: Id; optionId: string; note: string }
  | { type: 'approval.decide'; approvalId: Id; decision: 'Approved' | 'Rejected'; note: string }
  | { type: 'automation.simulateRun'; automationId: Id }
  | { type: 'automation.setStatus'; automationId: Id; status: 'Active' | 'Paused' };

export function applyAction(state: DemoState, action: Action): ActionResult {
  switch (action.type) {
    case 'demo.setRole':
      return setRole(state, action.userId);
    case 'demo.setGuidedStep':
      state.meta.guidedStep = action.step;
      return { ok: true, message: action.step === null ? 'Guided demo closed.' : `Guided demo step ${action.step + 1}.` };
    case 'document.editField':
      return editField(state, action.documentId, action.key, action.value);
    case 'document.confirmField':
      return confirmField(state, action.documentId, action.key);
    case 'document.revalidate': {
      const blocking = revalidateDocument(state, action.documentId);
      return { ok: true, message: `Validation re-run. ${blocking} blocking mismatch${blocking === 1 ? '' : 'es'} outstanding.` };
    }
    case 'case.create':
      return createCase(state, action.documentId);
    case 'case.generateDraft':
      return generateDraft(state, action.caseId);
    case 'case.saveDraft':
      return saveDraft(state, action.caseId, action.subject, action.body);
    case 'case.markSent':
      return markSent(state, action.caseId);
    case 'case.simulateCorrected':
      return simulateCorrected(state, action.caseId);
    case 'case.revalidate':
      return revalidateCase(state, action.caseId);
    case 'case.override':
      return overrideCase(state, action.caseId, action.reason);
    case 'opportunity.setAssumption':
      return setAssumption(state, action);
    case 'opportunity.createOrder':
      return createOrderFromOpportunity(state, action);
    case 'order.updateLine':
      return updateOrderLine(state, action.orderId, action.qty, action.discountPct);
    case 'order.repriceToActive':
      return repriceToActive(state, action.orderId);
    case 'order.releaseFull':
      return releaseFull(state, action.orderId);
    case 'order.requestApproval':
      return requestApproval(state, action.orderId, action.optionId, action.note);
    case 'approval.decide':
      return decideApproval(state, action.approvalId, action.decision, action.note);
    case 'automation.simulateRun':
      return simulateAutomationRun(state, action.automationId);
    case 'automation.setStatus':
      return setAutomationStatus(state, action.automationId, action.status);
    default: {
      const never: never = action;
      throw new ActionError(`Unknown action: ${JSON.stringify(never)}`);
    }
  }
}

/* ------------------------------- Demo shell -------------------------------- */

function setRole(state: DemoState, userId: Id): ActionResult {
  const user = byId(state.users, userId);
  if (!user) throw new ActionError(`Unknown user ${userId}.`, 404);
  state.meta.currentUserId = userId;
  return { ok: true, message: `Now acting as ${user.name}, ${user.title}.` };
}

/* ----------------------------- Journey A: docs ----------------------------- */

function editField(state: DemoState, documentId: Id, key: string, value: string): ActionResult {
  const doc = byId(state.documents, documentId);
  if (!doc) throw new ActionError(`Document ${documentId} not found.`, 404);
  const field = doc.extraction.find((f) => f.key === key);
  if (!field) throw new ActionError(`Field ${key} is not part of this extraction.`, 404);

  const trimmed = value.trim();
  if (trimmed === '') throw new ActionError('A corrected value cannot be empty.');
  if (field.numeric) {
    const n = Number(trimmed.replace(/[,\s]/g, ''));
    if (!Number.isFinite(n)) throw new ActionError(`"${value}" is not a number. ${field.label} must be numeric.`);
    if (n < 0) throw new ActionError(`${field.label} cannot be negative.`);
  }

  field.value = trimmed;
  field.state = trimmed === field.originalValue ? 'Needs review' : 'Corrected';

  const blocking = revalidateDocument(state, documentId);
  log(
    state,
    'user',
    `Corrected ${field.group} ${field.label} on ${doc.reference} to "${trimmed}"`,
    [{ type: 'document', id: doc.id, label: doc.reference }],
    `Previously extracted as "${field.originalValue}". Validation re-run: ${blocking} blocking mismatch(es) outstanding.`,
  );
  return { ok: true, message: `${field.label} updated. ${blocking} blocking mismatch${blocking === 1 ? '' : 'es'} outstanding.` };
}

function confirmField(state: DemoState, documentId: Id, key: string): ActionResult {
  const doc = byId(state.documents, documentId);
  if (!doc) throw new ActionError(`Document ${documentId} not found.`, 404);
  const field = doc.extraction.find((f) => f.key === key);
  if (!field) throw new ActionError(`Field ${key} is not part of this extraction.`, 404);
  if (field.state === 'Confirmed') throw new ActionError(`${field.label} is already confirmed.`);
  field.state = 'Confirmed';
  log(
    state,
    'user',
    `Confirmed ${field.group} ${field.label} on ${doc.reference} as "${field.value}"`,
    [{ type: 'document', id: doc.id, label: doc.reference }],
    'Confirming an extracted value records that a person read it against the source document. It does not change the comparison result.',
  );
  return { ok: true, message: `${field.label} confirmed as read from the source document.` };
}

function createCase(state: DemoState, documentId: Id): ActionResult {
  const doc = byId(state.documents, documentId);
  if (!doc) throw new ActionError(`Document ${documentId} not found.`, 404);
  if (state.cases.some((c) => c.documentId === documentId && c.status !== 'Resolved')) {
    throw new ActionError('An open case already exists for this document.', 409);
  }
  const open = state.discrepancies.filter((d) => d.id.startsWith(`DSC-${doc.id}-`) && !d.resolved);
  if (open.length === 0) {
    throw new ActionError('There is nothing to raise: this document matches the purchase order.');
  }

  const id = nextId('CASE');
  const c: DiscrepancyCase = {
    id,
    title: `${doc.reference} does not match ${doc.purchaseOrderId}`,
    documentId: doc.id,
    purchaseOrderId: doc.purchaseOrderId,
    shipmentId: doc.shipmentId,
    status: 'Open',
    openedOn: now(state),
    ownerId: currentUser(state).id,
    discrepancyIds: open.map((d) => d.id),
  };
  state.cases.push(c);
  log(
    state,
    'user',
    `Discrepancy case ${id} opened on ${doc.reference}`,
    [
      { type: 'case', id, label: id },
      { type: 'document', id: doc.id, label: doc.reference },
      { type: 'purchaseOrder', id: doc.purchaseOrderId, label: doc.purchaseOrderId },
    ],
    `${open.filter((d) => d.severity === 'blocking').length} blocking and ${open.filter((d) => d.severity === 'advisory').length} advisory difference(s) attached.`,
  );
  return { ok: true, message: `Case ${id} opened with ${open.length} difference(s).`, created: { caseId: id } };
}

function caseOrThrow(state: DemoState, caseId: Id): DiscrepancyCase {
  const c = byId(state.cases, caseId);
  if (!c) throw new ActionError(`Case ${caseId} not found.`, 404);
  return c;
}

function generateDraft(state: DemoState, caseId: Id): ActionResult {
  const c = caseOrThrow(state, caseId);
  const doc = byId(state.documents, c.documentId)!;
  const po = byId(state.purchaseOrders, c.purchaseOrderId)!;
  const supplier = byId(state.suppliers, doc.supplierId)!;
  const items = state.discrepancies.filter((d) => c.discrepancyIds.includes(d.id) && !d.resolved);

  const blocking = items.filter((d) => d.severity === 'blocking');
  const advisory = items.filter((d) => d.severity === 'advisory');

  const bullets = blocking
    .map(
      (d, i) =>
        `${i + 1}. ${d.group} - ${d.label}\n   Your document: ${d.documentValue}\n   Our order ${po.id}: ${d.orderValue}${
          d.impactEgp ? `\n   Value effect: ${formatEGP(Math.abs(d.impactEgp))} ${d.impactEgp > 0 ? 'in your favour' : 'short against our order'}` : ''
        }`,
    )
    .join('\n\n');

  const body = [
    `Dear ${supplier.contactName},`,
    '',
    `We have reviewed ${doc.reference} dated ${doc.issuedOn} against our purchase order ${po.id} dated ${po.orderedOn}, and we cannot proceed while the following points differ:`,
    '',
    bullets,
    '',
    advisory.length
      ? `We also note a wording difference on ${advisory.map((d) => `${d.group} ${d.label.toLowerCase()} ("${d.documentValue}" vs "${d.orderValue}")`).join(', ')}. This does not affect acceptance, but please align the description on the final documents.`
      : '',
    '',
    'Please issue a revised pro forma invoice reflecting the contracted specification, quantity, price and payment terms. We are holding receiving and the payment instruction until the revised document is received.',
    '',
    'Kind regards,',
    `${currentUser(state).name}`,
    `${currentUser(state).title}`,
    'Mobility Pro Distribution S.A.E.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  c.draft = {
    to: supplier.contactEmail,
    subject: `${po.id} / ${doc.reference} - revised pro forma invoice required`,
    body,
  };
  log(
    state,
    'assistant',
    `Supplier clarification draft prepared for case ${c.id}`,
    [{ type: 'case', id: c.id, label: c.id }],
    'Draft only. Nothing is sent from this demo.',
  );
  return { ok: true, message: 'Draft prepared. It is editable and is never sent from this demo.' };
}

function saveDraft(state: DemoState, caseId: Id, subject: string, body: string): ActionResult {
  const c = caseOrThrow(state, caseId);
  if (!c.draft) throw new ActionError('Generate a draft before editing it.');
  if (!subject.trim()) throw new ActionError('The subject cannot be empty.');
  if (!body.trim()) throw new ActionError('The message body cannot be empty.');
  c.draft.subject = subject;
  c.draft.body = body;
  c.draft.editedAt = now(state);
  return { ok: true, message: 'Draft saved inside the demo.' };
}

function markSent(state: DemoState, caseId: Id): ActionResult {
  const c = caseOrThrow(state, caseId);
  if (!c.draft) throw new ActionError('There is no draft to send.');
  if (c.status === 'Awaiting supplier') throw new ActionError('This case is already awaiting the supplier.', 409);
  if (c.status === 'Resolved' || c.status === 'Overridden') {
    throw new ActionError(`Case ${c.id} is ${c.status.toLowerCase()} and cannot be re-sent.`, 409);
  }
  c.draft.sentInDemoAt = now(state);
  c.status = 'Awaiting supplier';
  log(
    state,
    'user',
    `Clarification recorded as sent to the supplier on case ${c.id}`,
    [{ type: 'case', id: c.id, label: c.id }],
    'Simulated inside the demo. No email or message leaves this application.',
  );
  return { ok: true, message: 'Recorded as sent (simulated). No message leaves this demo.' };
}

function simulateCorrected(state: DemoState, caseId: Id): ActionResult {
  const c = caseOrThrow(state, caseId);
  if (c.correctedDocumentId) throw new ActionError('A revised document has already been received on this case.', 409);
  if (c.status !== 'Awaiting supplier' && c.status !== 'Open') {
    throw new ActionError(`A revised document cannot be received while the case is "${c.status}".`, 409);
  }

  const original = byId(state.documents, c.documentId)!;
  const po = byId(state.purchaseOrders, c.purchaseOrderId)!;
  const revised = buildCorrectedDocument(original, po, state.meta.today);

  if (state.documents.some((d) => d.id === revised.id)) {
    throw new ActionError('That revision already exists.', 409);
  }

  state.documents.push(revised);
  c.correctedDocumentId = revised.id;
  c.status = 'Revised document received';

  // The revised document supersedes the original for readiness purposes.
  state.discrepancies = state.discrepancies.filter((d) => !d.id.startsWith(`DSC-${original.id}-`));
  c.documentId = revised.id;
  revalidateDocument(state, revised.id);

  log(
    state,
    'system',
    `Revised document ${revised.reference} received and linked to case ${c.id}`,
    [
      { type: 'case', id: c.id, label: c.id },
      { type: 'document', id: revised.id, label: revised.reference },
    ],
    `Supersedes ${original.reference}. Simulated receipt: the supplier is modelled as correcting the blocking points raised.`,
  );
  return {
    ok: true,
    message: `Revised document ${revised.reference} received. Re-run validation to see the result.`,
    created: { documentId: revised.id },
  };
}

function revalidateCase(state: DemoState, caseId: Id): ActionResult {
  const c = caseOrThrow(state, caseId);
  const blocking = revalidateDocument(state, c.documentId);
  const doc = byId(state.documents, c.documentId)!;
  const remaining = state.discrepancies.filter((d) => d.id.startsWith(`DSC-${doc.id}-`) && !d.resolved);
  const advisory = remaining.filter((d) => d.severity === 'advisory');

  if (blocking === 0) {
    c.status = 'Resolved';
    for (const d of remaining) {
      if (d.severity === 'advisory') {
        d.resolved = false; // advisories stay visible; they never blocked anything
      }
    }
    log(
      state,
      'system',
      `Case ${c.id} resolved: no blocking mismatches remain on ${doc.reference}`,
      [
        { type: 'case', id: c.id, label: c.id },
        { type: 'document', id: doc.id, label: doc.reference },
        ...(c.shipmentId ? [{ type: 'shipment' as const, id: c.shipmentId, label: c.shipmentId }] : []),
      ],
      `${advisory.length} advisory difference(s) remain and do not block receiving. Resolving this case does not mean goods have arrived or that payment is approved (PR-3.1).`,
    );
    return {
      ok: true,
      message: `No blocking mismatches remain. Case ${c.id} resolved; ${advisory.length} advisory note(s) retained.`,
    };
  }

  log(
    state,
    'system',
    `Validation re-run on ${doc.reference}: ${blocking} blocking mismatch(es) remain`,
    [{ type: 'case', id: c.id, label: c.id }],
  );
  return { ok: true, message: `${blocking} blocking mismatch${blocking === 1 ? '' : 'es'} still outstanding.` };
}

function overrideCase(state: DemoState, caseId: Id, reason: string): ActionResult {
  const c = caseOrThrow(state, caseId);
  const user = requireRole(state, ['procurement'], 'override a supplier document discrepancy (AM-3.1)');
  if (!reason || reason.trim().length < 15) {
    throw new ActionError('An override needs a written reason of at least 15 characters. It is retained on the case.');
  }
  if (c.status === 'Resolved') throw new ActionError('This case is already resolved; there is nothing to override.', 409);
  if (c.status === 'Overridden') throw new ActionError('This case has already been overridden.', 409);

  c.status = 'Overridden';
  c.overrideReason = reason.trim();
  c.overrideBy = user.name;
  log(
    state,
    'user',
    `Case ${c.id} overridden by ${user.name}`,
    [{ type: 'case', id: c.id, label: c.id }],
    `Reason: ${reason.trim()} (AM-3.1). The mismatches remain on record; receiving readiness is released on the authority of the override, not because the document was corrected.`,
  );
  return { ok: true, message: `Case ${c.id} overridden. The reason is retained on the case record.` };
}

/* --------------------------- Journey B: inventory -------------------------- */

function setAssumption(
  state: DemoState,
  a: Extract<Action, { type: 'opportunity.setAssumption' }>,
): ActionResult {
  const opp = byId(state.opportunities, a.opportunityId);
  if (!opp) throw new ActionError(`Opportunity ${a.opportunityId} not found.`, 404);
  if (a.unitsPerDiscountPoint < 0 || a.unitsPerDiscountPoint > 100) {
    throw new ActionError('Uplift per discount point must be between 0 and 100 pcs/month.');
  }
  if (a.horizonMonths < 1 || a.horizonMonths > 12) {
    throw new ActionError('The modelling horizon must be between 1 and 12 months.');
  }
  if (a.collectionDelayDays < 0 || a.collectionDelayDays > 180) {
    throw new ActionError('Collection delay must be between 0 and 180 days.');
  }
  opp.assumption.unitsPerDiscountPoint = round2(a.unitsPerDiscountPoint);
  opp.assumption.horizonMonths = round0(a.horizonMonths);
  opp.assumption.collectionDelayDays = round0(a.collectionDelayDays);
  return { ok: true, message: 'Demand assumption updated. Scenario outputs recalculated.' };
}

function createOrderFromOpportunity(
  state: DemoState,
  a: Extract<Action, { type: 'opportunity.createOrder' }>,
): ActionResult {
  const opp = byId(state.opportunities, a.opportunityId);
  if (!opp) throw new ActionError(`Opportunity ${a.opportunityId} not found.`, 404);
  if (opp.salesOrderId) {
    throw new ActionError(`Order ${opp.salesOrderId} was already prepared from this opportunity.`, 409);
  }
  const cust = byId(state.customers, a.customerId);
  if (!cust) throw new ActionError(`Customer ${a.customerId} not found.`, 404);

  const pos = stockAt(state, opp.skuId, opp.warehouseId);
  if (a.qty <= 0) throw new ActionError('Quantity must be at least 1 piece.');
  if (!Number.isInteger(a.qty)) throw new ActionError('Quantity must be a whole number of pieces.');
  if (a.qty > pos.available) {
    throw new ActionError(
      `Only ${pos.available} pcs are available at ${byId(state.warehouses, opp.warehouseId)?.name} (${pos.onHand} on hand, ${pos.reserved} already reserved).`,
    );
  }
  if (a.discountPct < 0 || a.discountPct > 40) {
    throw new ActionError('Discount must be between 0% and 40%.');
  }

  const pl = activePriceList(state);
  const listPrice = pl.prices[opp.skuId] ?? byId(state.skus, opp.skuId)!.listPrice;
  const unitPrice = round2(listPrice * (1 - a.discountPct / 100));
  if (unitPrice < pos.weightedCost) {
    throw new ActionError(
      `At ${a.discountPct}% the unit price (${formatEGP(unitPrice)}) falls below the weighted landed cost (${formatEGP(pos.weightedCost)}). Pricing policy PP-3.1 requires Finance Director approval before such an order can be prepared.`,
    );
  }

  const id = nextId('SO');
  const order: SalesOrder = {
    id,
    customerId: a.customerId,
    createdOn: state.meta.today,
    createdBy: currentUser(state).id,
    status: 'Draft',
    priceListId: pl.id,
    reservationIds: [],
    sourceOpportunityId: opp.id,
    lines: [
      {
        skuId: opp.skuId,
        qty: a.qty,
        warehouseId: opp.warehouseId,
        listPrice,
        discountPct: a.discountPct,
        unitPrice,
        unitCost: pos.weightedCost,
      },
    ],
  };
  state.salesOrders.push(order);
  opp.salesOrderId = id;
  opp.status = 'In progress';
  opp.chosenScenarioId = `discount-${a.discountPct}`;

  // Run the credit check immediately so the order lands in its true state.
  const credit = checkCredit(state, order);
  order.status = credit.released ? 'Draft' : 'Blocked - credit';

  log(
    state,
    'user',
    `Proposed order ${id} prepared for ${cust.name}: ${a.qty} pcs of ${skuLabel(state, opp.skuId)} at ${a.discountPct}% off list`,
    [
      { type: 'salesOrder', id, label: id },
      { type: 'customer', id: cust.id, label: cust.name },
      { type: 'opportunity', id: opp.id, label: opp.id },
    ],
    `Order value ${formatEGP(orderValue(order))}. Credit check: ${credit.headline}`,
  );

  return {
    ok: true,
    message: credit.released
      ? `Order ${id} prepared and within credit policy.`
      : `Order ${id} prepared but held: ${credit.headline}`,
    navigateTo: `/operations/orders/${id}`,
    created: { orderId: id },
  };
}

function orderOrThrow(state: DemoState, orderId: Id): SalesOrder {
  const o = byId(state.salesOrders, orderId);
  if (!o) throw new ActionError(`Order ${orderId} not found.`, 404);
  return o;
}

/** Any material change invalidates a pending approval (policy CR-5.4). */
function invalidateApprovalIfStale(state: DemoState, order: SalesOrder): boolean {
  if (!order.approvalId) return false;
  const approval = byId(state.approvals, order.approvalId);
  if (!approval || approval.status !== 'Pending') return false;
  const fresh = approvalInputHash(state, order);
  if (fresh === approval.inputHash) return false;
  approval.status = 'Stale - inputs changed';
  order.status = 'Blocked - credit';
  log(
    state,
    'system',
    `Approval ${approval.id} marked stale: the order changed after it was requested`,
    [
      { type: 'approval', id: approval.id, label: approval.id },
      { type: 'salesOrder', id: order.id, label: order.id },
    ],
    'Credit policy CR-5.4: approval lapses when quantity, unit price, credit limit or overdue balance change.',
  );
  return true;
}

function updateOrderLine(state: DemoState, orderId: Id, qty: number, discountPct: number): ActionResult {
  const order = orderOrThrow(state, orderId);
  if (order.status === 'Approved - reserved') {
    throw new ActionError('This order is approved and reserved. Changing it would invalidate the reservation; reject or revise the approval first.', 409);
  }
  if (order.lines.length !== 1) {
    throw new ActionError('Inline editing is available on single-line demo orders only.');
  }
  if (!Number.isInteger(qty) || qty <= 0) throw new ActionError('Quantity must be a whole number of at least 1.');
  if (discountPct < 0 || discountPct > 40) throw new ActionError('Discount must be between 0% and 40%.');

  const line = order.lines[0];
  const pos = stockAt(state, line.skuId, line.warehouseId);
  const ownReserved = state.reservations
    .filter((r) => !r.releasedAt && r.salesOrderId === order.id)
    .reduce((n, r) => n + r.qty, 0);
  const available = pos.onHand - (pos.reserved - ownReserved);
  if (qty > available) {
    throw new ActionError(`Only ${available} pcs are available at ${byId(state.warehouses, line.warehouseId)?.name}.`);
  }

  line.qty = qty;
  line.discountPct = discountPct;
  line.unitPrice = round2(line.listPrice * (1 - discountPct / 100));
  if (line.unitPrice < line.unitCost) {
    throw new ActionError(`At ${discountPct}% the unit price falls below landed cost (${formatEGP(line.unitCost)}). Blocked by PP-3.1.`);
  }

  const wasStale = invalidateApprovalIfStale(state, order);
  const credit = checkCredit(state, order);
  if (!order.approvalId || wasStale) {
    order.status = credit.released ? 'Draft' : 'Blocked - credit';
  }

  log(
    state,
    'user',
    `${order.id} revised to ${qty} pcs at ${discountPct}% off list`,
    [{ type: 'salesOrder', id: order.id, label: order.id }],
    `New order value ${formatEGP(orderValue(order))}.${wasStale ? ' The pending approval was invalidated.' : ''}`,
  );
  return {
    ok: true,
    message: wasStale
      ? 'Order revised. The pending approval lapsed because a material input changed (CR-5.4).'
      : 'Order revised and re-checked against credit policy.',
  };
}

function repriceToActive(state: DemoState, orderId: Id): ActionResult {
  const order = orderOrThrow(state, orderId);
  const pl = activePriceList(state);
  if (order.priceListId === pl.id) throw new ActionError('This order already uses the active price list.', 409);
  if (order.status === 'Approved - reserved') throw new ActionError('An approved order cannot be re-priced.', 409);

  const before = orderValue(order);
  for (const l of order.lines) {
    l.listPrice = pl.prices[l.skuId] ?? l.listPrice;
    l.unitPrice = round2(l.listPrice * (1 - l.discountPct / 100));
  }
  order.priceListId = pl.id;
  invalidateApprovalIfStale(state, order);
  const after = orderValue(order);

  log(
    state,
    'user',
    `${order.id} re-priced onto ${pl.name}`,
    [{ type: 'salesOrder', id: order.id, label: order.id }],
    `Order value moved from ${formatEGP(before)} to ${formatEGP(after)} (${formatEGP(after - before)} difference). Nothing has been invoiced.`,
  );
  return { ok: true, message: `Re-priced onto ${pl.name}. Order value is now ${formatEGP(after)}.` };
}

/** Creates reservations for an order, refusing duplicates and negative stock. */
function reserveFor(state: DemoState, order: SalesOrder): void {
  const existing = state.reservations.filter((r) => !r.releasedAt && r.salesOrderId === order.id);
  if (existing.length > 0) {
    throw new ActionError(`Order ${order.id} already holds ${existing.length} active reservation(s).`, 409);
  }
  const stock = checkStock(state, order);
  const short = stock.find((s) => !s.ok);
  if (short) {
    throw new ActionError(
      `Cannot reserve: ${short.requested} pcs requested of ${skuLabel(state, short.skuId)} at ${byId(state.warehouses, short.warehouseId)?.name}, but only ${short.available} are available.`,
      409,
    );
  }
  for (const l of order.lines) {
    const id = nextId('RES');
    state.reservations.push({
      id,
      salesOrderId: order.id,
      skuId: l.skuId,
      warehouseId: l.warehouseId,
      qty: l.qty,
      createdAt: now(state),
    });
    order.reservationIds.push(id);
  }
}

function releaseFull(state: DemoState, orderId: Id): ActionResult {
  const order = orderOrThrow(state, orderId);
  if (order.status === 'Approved - reserved') throw new ActionError('This order is already released and reserved.', 409);
  if (order.status === 'Rejected') throw new ActionError('A rejected order cannot be released.', 409);

  const activeList = activePriceList(state);
  if (order.priceListId !== activeList.id) {
    throw new ActionError(`Order ${order.id} is priced on a superseded list. Re-price it onto ${activeList.name} first (PP-1.1).`, 409);
  }

  const credit = checkCredit(state, order);
  if (!credit.released) {
    throw new ActionError(`Release refused. ${credit.headline}`, 409);
  }
  const auth = discountAuthority(Math.max(...order.lines.map((l) => l.discountPct)));
  if (auth.needsApproval) {
    throw new ActionError(
      `A discount of ${Math.max(...order.lines.map((l) => l.discountPct))}% requires ${auth.role} approval (${auth.clause}). Request approval instead of releasing directly.`,
      403,
    );
  }

  reserveFor(state, order);
  order.status = 'Approved - reserved';

  log(
    state,
    'user',
    `${order.id} released within policy and stock reserved`,
    [
      { type: 'salesOrder', id: order.id, label: order.id },
      { type: 'customer', id: order.customerId, label: byId(state.customers, order.customerId)?.name ?? order.customerId },
    ],
    `${order.lines.reduce((n, l) => n + l.qty, 0)} pcs reserved. Exposure moves to ${formatEGP(credit.exposureAfter)}. No revenue is recognised and no cash has been collected.`,
  );
  return { ok: true, message: `${order.id} released. Stock reserved and exposure updated.` };
}

function requestApproval(state: DemoState, orderId: Id, optionId: string, note: string): ActionResult {
  const order = orderOrThrow(state, orderId);
  if (order.status === 'Approved - reserved') throw new ActionError('This order is already approved.', 409);

  const existing = order.approvalId ? byId(state.approvals, order.approvalId) : undefined;
  if (existing?.status === 'Pending') {
    throw new ActionError(`Approval ${existing.id} is already pending a decision on this order.`, 409);
  }

  const credit = checkCredit(state, order);
  const option = credit.options.find((o) => o.id === optionId);
  if (!option) throw new ActionError(`"${optionId}" is not an available fulfilment option for this order.`);
  if (option.selfService) {
    throw new ActionError('That option does not need an approval request; it can be actioned directly.');
  }

  const cust = byId(state.customers, order.customerId)!;
  const ar = receivables(state, order.customerId);
  const maxDiscount = Math.max(...order.lines.map((l) => l.discountPct));
  const auth = discountAuthority(maxDiscount);
  const approverRole: Role = option.requiresApprovalBy === 'Commercial Director' ? 'management' : 'finance';

  const id = nextId('APR');
  const approval: ApprovalRequest = {
    id,
    kind: 'credit_release',
    title: `${option.label} - ${order.id} (${cust.name})`,
    subjectRef: { type: 'salesOrder', id: order.id },
    requestedBy: currentUser(state).id,
    requestedAt: now(state),
    approverRole,
    status: 'Pending',
    proposal: option.description,
    policyRefs: [option.clause, 'CR-5.4', auth.clause],
    inputHash: approvalInputHash(state, order),
    evidence: [
      { label: 'Customer', value: cust.name },
      { label: 'Credit limit', value: formatEGP(credit.creditLimit) },
      { label: 'Open receivables', value: formatEGP(credit.openReceivables) },
      {
        label: 'Overdue balance',
        value: `${formatEGP(credit.overdue)} (oldest ${credit.worstOverdueDays} days past due)`,
        tone: credit.overdue > 0 ? 'bad' : 'good',
      },
      { label: 'Approved undelivered orders', value: formatEGP(credit.committedOrders) },
      { label: 'Exposure before this order', value: formatEGP(credit.exposureBefore) },
      { label: 'Stock availability', value: checkStock(state, order).every((s) => s.ok) ? 'Sufficient at the requested location' : 'Insufficient', tone: checkStock(state, order).every((s) => s.ok) ? 'good' : 'bad' },
      { label: 'Price list version', value: byId(state.priceLists, order.priceListId)?.name ?? order.priceListId },
      { label: 'Discount requested', value: `${maxDiscount}% (authority: ${auth.role}, ${auth.clause})`, tone: maxDiscount > 5 ? 'warn' : 'neutral' },
      ...(note.trim() ? [{ label: 'Requester note', value: note.trim() } as const] : []),
    ],
    impact: dedupeByLabel([
      { label: 'Order value', value: formatEGP(credit.orderValue) },
      { label: 'Exposure after approval', value: formatEGP(credit.exposureAfter) },
      { label: 'Credit headroom after approval', value: formatEGP(credit.availableCreditAfter) },
      {
        label: 'Gross profit if delivered and collected',
        value: formatEGP(order.lines.reduce((n, l) => n + l.qty * (l.unitPrice - l.unitCost), 0)),
      },
      {
        label: 'Estimated collection date',
        value: formatDate(addDays(addDays(state.meta.today, cust.paymentTermsDays), 12)),
      },
      ...(option.computed ?? []).map((c) => ({ label: c.label, value: c.value })),
    ]),
  };

  state.approvals.push(approval);
  order.approvalId = id;
  order.approvalInputHash = approval.inputHash;
  order.fulfilmentPlanId = optionId;
  order.status = 'Pending approval';

  log(
    state,
    'user',
    `Approval ${id} requested on ${order.id}: ${option.label}`,
    [
      { type: 'approval', id, label: id },
      { type: 'salesOrder', id: order.id, label: order.id },
      { type: 'customer', id: cust.id, label: cust.name },
    ],
    `Routed to ${option.requiresApprovalBy} under ${option.clause}. Nothing is reserved until a decision is recorded.`,
  );
  return {
    ok: true,
    message: `Approval ${id} requested. It is waiting for the ${option.requiresApprovalBy}.`,
    navigateTo: '/approvals',
    created: { approvalId: id },
  };
}

function decideApproval(
  state: DemoState,
  approvalId: Id,
  decision: 'Approved' | 'Rejected',
  note: string,
): ActionResult {
  const approval = byId(state.approvals, approvalId);
  if (!approval) throw new ActionError(`Approval ${approvalId} not found.`, 404);
  if (approval.status !== 'Pending') {
    throw new ActionError(`Approval ${approvalId} is already "${approval.status}". A decision cannot be recorded twice.`, 409);
  }

  const roleLabel = approval.approverRole === 'finance' ? 'Finance Director' : 'Commercial Director';
  requireRole(state, [approval.approverRole], `decide this request (it is routed to the ${roleLabel})`);

  const order = orderOrThrow(state, approval.subjectRef.id);

  // Staleness check at the moment of decision, not just on edit.
  const fresh = approvalInputHash(state, order);
  if (fresh !== approval.inputHash) {
    approval.status = 'Stale - inputs changed';
    order.status = 'Blocked - credit';
    log(
      state,
      'system',
      `Approval ${approval.id} could not be decided: the order changed after the request`,
      [{ type: 'approval', id: approval.id, label: approval.id }],
      'Credit policy CR-5.4.',
    );
    throw new ActionError(
      'The order changed after this request was raised, so the approval has lapsed (CR-5.4). Ask the requester to resubmit.',
      409,
    );
  }

  const user = currentUser(state);
  approval.status = decision;
  approval.decidedBy = user.id;
  approval.decidedAt = now(state);
  approval.decisionNote = note.trim() || undefined;

  if (decision === 'Rejected') {
    order.status = 'Rejected';
    log(
      state,
      'user',
      `${approval.id} rejected by ${user.name}`,
      [
        { type: 'approval', id: approval.id, label: approval.id },
        { type: 'salesOrder', id: order.id, label: order.id },
      ],
      note.trim() ? `Reason: ${note.trim()}` : undefined,
    );
    return { ok: true, message: `${approval.id} rejected. ${order.id} is now rejected and nothing is reserved.` };
  }

  reserveFor(state, order);
  order.status = 'Approved - reserved';
  const credit = checkCredit(state, order);

  log(
    state,
    'user',
    `${approval.id} approved by ${user.name} - ${order.id} released and stock reserved`,
    [
      { type: 'approval', id: approval.id, label: approval.id },
      { type: 'salesOrder', id: order.id, label: order.id },
      { type: 'customer', id: order.customerId, label: byId(state.customers, order.customerId)?.name ?? order.customerId },
    ],
    `${order.lines.reduce((n, l) => n + l.qty, 0)} pcs reserved at ${byId(state.warehouses, order.lines[0].warehouseId)?.name}. Exposure ${formatEGP(credit.exposureAfter)}. Revenue is NOT recognised and no cash has been collected - the order still has to be delivered, invoiced and paid.`,
  );

  const opp = state.opportunities.find((o) => o.salesOrderId === order.id);
  if (opp) opp.status = 'Actioned';

  return { ok: true, message: `${approval.id} approved. ${order.id} is released and stock is reserved.` };
}

/* ------------------------------- Automations ------------------------------- */

/**
 * Simulates one execution of an n8n workflow.
 *
 * This runs entirely inside the demo: no n8n instance is contacted, no message
 * is sent, and nothing outside the demo dataset changes. What it does is compute
 * what the workflow WOULD have found right now, from the live demo state, and
 * record it as a run flagged `simulated` — the same honesty pattern as
 * "Simulate receipt of a corrected document" in the document journey.
 */
function simulateAutomationRun(state: DemoState, automationId: Id): ActionResult {
  const automation = byId(state.automations, automationId);
  if (!automation) throw new ActionError(`Automation ${automationId} not found.`, 404);
  if (automation.status === 'Paused') {
    throw new ActionError(`${automation.name} is paused. Resume it before simulating a run.`, 409);
  }
  if (automation.status === 'Draft') {
    throw new ActionError(
      `${automation.name} is still a draft — it has never been published to an n8n instance. Simulating it would imply a working integration that does not exist.`,
      409,
    );
  }

  const observed = observeForAutomation(state, automation.id);
  const run = {
    id: nextId('RUN'),
    at: now(state),
    outcome: observed.itemsOut > 0 ? ('Success' as const) : ('No work to do' as const),
    durationMs: observed.durationMs,
    itemsIn: observed.itemsIn,
    itemsOut: observed.itemsOut,
    note: observed.note,
    simulated: true as const,
  };
  automation.runs = [run, ...automation.runs].slice(0, 8);

  log(
    state,
    'system',
    `${automation.name} run simulated: ${run.note}`,
    [],
    'Simulated inside the demo. No n8n instance was contacted and no message was sent.',
    'n8n demo adapter',
  );

  return { ok: true, message: `${automation.name}: ${run.note}` };
}

/**
 * What each workflow would actually find in the current demo state. Reading the
 * live data is the point — a run right after resolving the document case should
 * report nothing to do.
 */
function observeForAutomation(
  state: DemoState,
  id: Id,
): { itemsIn: number; itemsOut: number; durationMs: number; note: string } {
  switch (id) {
    case 'supplier-document-intake': {
      const docs = state.documents.length;
      const blocking = state.discrepancies.filter((d) => d.severity === 'blocking' && !d.resolved).length;
      const advisory = state.discrepancies.filter((d) => d.severity === 'advisory' && !d.resolved).length;
      return {
        itemsIn: docs,
        itemsOut: blocking + advisory,
        durationMs: 7400 + docs * 180,
        note:
          blocking + advisory === 0
            ? `${docs} documents re-checked against their purchase orders. No mismatches outstanding.`
            : `${docs} documents re-checked. ${blocking} blocking and ${advisory} advisory mismatch(es) outstanding.`,
      };
    }
    case 'supplier-clarification-dispatch': {
      const awaiting = state.cases.filter((c) => c.status === 'Awaiting supplier').length;
      return {
        itemsIn: awaiting,
        itemsOut: awaiting,
        durationMs: 2200,
        note:
          awaiting === 0
            ? 'No clarification is awaiting a supplier response.'
            : `${awaiting} case(s) awaiting a supplier revision; follow-up reminders armed.`,
      };
    }
    case 'aging-stock-sweep': {
      const lots = state.lots.length;
      const open = state.opportunities.filter((o) => o.status === 'Open' || o.status === 'In progress').length;
      return {
        itemsIn: lots,
        itemsOut: open,
        durationMs: 13500,
        note:
          open === 0
            ? `${lots} lots evaluated. No lot is past the 180-day threshold with a falling shipped rate.`
            : `${lots} lots evaluated. ${open} aging opportunity(ies) open.`,
      };
    }
    case 'credit-hold-notifier': {
      const held = state.salesOrders.filter((o) => o.status === 'Blocked - credit').length;
      return {
        itemsIn: held,
        itemsOut: held * 2,
        durationMs: 1800,
        note:
          held === 0
            ? 'No order is currently held on credit.'
            : `${held} order(s) held on credit; finance and the account manager notified.`,
      };
    }
    case 'approval-chaser': {
      const pending = state.approvals.filter((a) => a.status === 'Pending').length;
      return {
        itemsIn: pending,
        itemsOut: pending,
        durationMs: 900,
        note:
          pending === 0
            ? 'No approvals pending a decision.'
            : `${pending} approval(s) pending; approver reminded.`,
      };
    }
    case 'daily-briefing': {
      const owners = new Set(state.salesOrders.map((o) => o.createdBy)).size;
      return {
        itemsIn: state.activity.length,
        itemsOut: owners,
        durationMs: 3000,
        note: `Briefing posted to #operations; ${owners} owner(s) emailed.`,
      };
    }
    default:
      return { itemsIn: 0, itemsOut: 0, durationMs: 800, note: 'Nothing to do.' };
  }
}

function setAutomationStatus(
  state: DemoState,
  automationId: Id,
  status: 'Active' | 'Paused',
): ActionResult {
  const automation = byId(state.automations, automationId);
  if (!automation) throw new ActionError(`Automation ${automationId} not found.`, 404);
  if (automation.status === 'Draft') {
    throw new ActionError(
      `${automation.name} is a draft and cannot be activated from here. It has to be published to an n8n instance first.`,
      409,
    );
  }
  if (automation.status === status) {
    throw new ActionError(`${automation.name} is already ${status.toLowerCase()}.`, 409);
  }
  automation.status = status;
  log(
    state,
    'user',
    `${automation.name} ${status === 'Active' ? 'resumed' : 'paused'}`,
    [],
    'Changes the workflow state inside the demo only. No n8n instance is connected.',
  );
  return { ok: true, message: `${automation.name} is now ${status.toLowerCase()}.` };
}

export { receivingReadiness, customersWhoBought };
