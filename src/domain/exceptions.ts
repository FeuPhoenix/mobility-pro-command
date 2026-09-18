/**
 * The ranked exception queue behind "Your operation today".
 *
 * Every entry is produced by a named rule, carries a single explicitly-typed
 * measure (never a blend), names an owner, and points at a next action.
 */

import { daysBetween, round2 } from './money';
import { receivingReadiness, documentTotals, validateDocument } from './documentRules';
import { checkCredit } from './credit';
import {
  activePriceList,
  byId,
  inventoryCarryingValue,
  observedUnitsPerMonth,
  orderValue,
  receivables,
  skuLabel,
  stockAt,
  stockBySku,
} from './selectors';
import type { DemoState, ExceptionItem, MeasureKind } from './types';

export const MEASURE_LABEL: Record<MeasureKind, string> = {
  inventory_carrying_value: 'Inventory carrying value',
  potential_sales_value: 'Potential sales value',
  gross_profit: 'Gross profit',
  receivables_at_risk: 'Receivables at risk',
  purchase_value_exposed: 'Purchase value exposed',
};

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2 } as const;

export function buildExceptions(state: DemoState): ExceptionItem[] {
  const out: ExceptionItem[] = [];

  /* ---- 1. Supplier document discrepancies ------------------------------- */
  for (const shipment of state.shipments) {
    if (shipment.status === 'Received') continue;
    const readiness = receivingReadiness(state, shipment.id);
    if (readiness.state !== 'Held - document control') continue;

    const po = byId(state.purchaseOrders, shipment.purchaseOrderId);
    const doc = state.documents
      .filter((d) => d.shipmentId === shipment.id && d.kind === 'Pro forma invoice')
      .sort((a, b) => b.revision - a.revision)[0];
    if (!po || !doc) continue;

    const live = state.discrepancies.filter(
      (d) => d.id.startsWith(`DSC-${doc.id}-`) && !d.resolved && d.severity === 'blocking',
    );
    const affectedLines = new Set(
      live.map((d) => /^line\.(\d+)\./.exec(d.fieldKey)?.[1]).filter(Boolean) as string[],
    );
    const exposedUsd = po.lines
      .filter((l) => affectedLines.has(String(l.lineNo)))
      .reduce((n, l) => n + l.qty * l.unitPriceUsd, 0);
    const exposedEgp = round2(exposedUsd * po.fxRate);

    const relatedCase = state.cases.find((c) => c.documentId === doc.id);

    out.push({
      id: `EXC-DOC-${shipment.id}`,
      kind: 'document_discrepancy',
      title: `${doc.reference} does not match ${po.id}`,
      why: `${readiness.blockingCount} blocking mismatch${readiness.blockingCount === 1 ? '' : 'es'} against the purchase order. Receiving readiness for ${shipment.id} is held.`,
      ruleId: 'PR-2.1 / PR-2.2 / PR-2.3 / PR-2.4',
      rule: 'Import document control SOP v1.9: spec, quantity, price and payment-term mismatches are blocking.',
      ownerId: 'U-OMAR',
      detectedAt: `${doc.receivedOn}T05:41:00Z`,
      severity: 'critical',
      measure: {
        kind: 'purchase_value_exposed',
        amount: exposedEgp > 0 ? exposedEgp : round2(documentTotals(doc, po).orderValueEgp),
        note: `Ordered value of the ${affectedLines.size || po.lines.length} affected purchase order line(s). This is exposure under an open order, not a loss and not a payment.`,
      },
      nextAction: relatedCase ? `Continue case ${relatedCase.id}` : 'Review the document and open a discrepancy case',
      href: `/operations/documents/${doc.id}`,
      status: relatedCase ? 'In progress' : 'Open',
      refs: [
        { type: 'document', id: doc.id, label: doc.reference },
        { type: 'purchaseOrder', id: po.id, label: po.id },
        { type: 'shipment', id: shipment.id, label: shipment.id },
      ],
    });
  }

  /* ---- 2. Aging inventory opportunities ---------------------------------- */
  for (const opp of state.opportunities) {
    if (opp.status === 'Dismissed') continue;
    const pos = stockAt(state, opp.skuId, opp.warehouseId);
    const value = round2(pos.onHand * pos.weightedCost);
    const recent = observedUnitsPerMonth(state, opp.skuId, 3);
    out.push({
      id: `EXC-AGE-${opp.id}`,
      kind: 'aging_inventory',
      title: `${skuLabel(state, opp.skuId)} has aged past 180 days`,
      why: `${pos.onHand.toLocaleString('en-EG')} pcs on hand at ${byId(state.warehouses, opp.warehouseId)?.name}, oldest lot ${pos.maxAgeDays} days. Shipped volume is running at ${recent} pcs/month across all locations.`,
      ruleId: opp.ruleId,
      rule: 'Inventory rule INV-AGE-180: lots held beyond 180 days with a falling shipped rate are raised for a decision.',
      ownerId: opp.ownerId,
      detectedAt: `${opp.detectedOn}T04:10:00Z`,
      severity: 'high',
      measure: {
        kind: 'inventory_carrying_value',
        amount: value,
        note: `${pos.onHand.toLocaleString('en-EG')} pcs at the weighted landed cost of this location. This is cash tied up in stock, not revenue and not profit.`,
      },
      nextAction: opp.status === 'Actioned' ? 'Review the resulting order' : 'Compare hold, transfer and discount scenarios',
      href: `/operations/inventory/${opp.id}`,
      status: opp.status === 'Actioned' ? 'Resolved' : opp.status === 'In progress' ? 'In progress' : 'Open',
      refs: [
        { type: 'opportunity', id: opp.id, label: opp.id },
        { type: 'sku', id: opp.skuId, label: skuLabel(state, opp.skuId) },
      ],
    });
  }

  /* ---- 3. Orders held on credit ------------------------------------------ */
  for (const order of state.salesOrders) {
    if (order.status !== 'Blocked - credit' && order.status !== 'Pending approval') continue;
    const check = checkCredit(state, order);
    const ar = receivables(state, order.customerId);
    const cust = byId(state.customers, order.customerId);
    out.push({
      id: `EXC-CREDIT-${order.id}`,
      kind: 'credit_review',
      title: `${order.id} for ${cust?.name} needs a credit decision`,
      why: check.headline,
      ruleId: check.outcome === 'blocked_overdue' ? 'CR-4.2' : 'CR-3.0',
      rule: 'Credit and release policy v3.1.',
      ownerId: 'U-NOUR',
      detectedAt: `${order.createdOn}T11:02:00Z`,
      severity: order.status === 'Pending approval' ? 'high' : 'critical',
      measure: {
        kind: 'receivables_at_risk',
        amount: ar.overdue > 0 ? ar.overdue : check.exposureAfter,
        note:
          ar.overdue > 0
            ? `Overdue receivables on this account. Separate from the ${`EGP ${Math.round(orderValue(order)).toLocaleString('en-EG')}`} value of the order itself.`
            : 'Total exposure if this order is released. Not revenue.',
      },
      nextAction: order.status === 'Pending approval' ? 'Decide in the approval inbox' : 'Review the credit position and choose a fulfilment plan',
      href: `/operations/orders/${order.id}`,
      status: order.status === 'Pending approval' ? 'In progress' : 'Open',
      refs: [
        { type: 'salesOrder', id: order.id, label: order.id },
        { type: 'customer', id: order.customerId, label: cust?.name ?? order.customerId },
      ],
    });
  }

  /* ---- 4. Stale price list ----------------------------------------------- */
  const active = activePriceList(state);
  for (const order of state.salesOrders) {
    if (order.status !== 'Draft') continue;
    if (order.priceListId === active.id) continue;
    const used = byId(state.priceLists, order.priceListId);
    const atActive = order.lines.reduce(
      (n, l) => n + l.qty * (active.prices[l.skuId] ?? l.listPrice),
      0,
    );
    const atUsed = orderValue(order);
    const cust = byId(state.customers, order.customerId);
    out.push({
      id: `EXC-PRICE-${order.id}`,
      kind: 'stale_price_list',
      title: `${order.id} is priced on ${used?.name ?? order.priceListId}`,
      why: `The active version is ${active.name}, effective ${active.effectiveFrom}. The proposal must be re-priced before it can be confirmed.`,
      ruleId: 'PP-1.1',
      rule: 'Trade pricing policy v2.0: quotations must use the price list version active on the quotation date.',
      ownerId: 'U-KAREEM',
      detectedAt: `${order.createdOn}T07:35:00Z`,
      severity: 'medium',
      measure: {
        kind: 'gross_profit',
        amount: round2(atActive - atUsed),
        note: 'Gross profit difference between the superseded price and the active price, at the quoted quantities. Nothing has been invoiced.',
      },
      nextAction: 'Re-price the proposal on the active list',
      href: `/operations/orders/${order.id}`,
      status: 'Open',
      refs: [
        { type: 'salesOrder', id: order.id, label: order.id },
        { type: 'customer', id: order.customerId, label: cust?.name ?? order.customerId },
      ],
    });
  }

  /* ---- 5. Warehouse imbalance -------------------------------------------- */
  for (const s of state.skus) {
    const positions = stockBySku(state, s.id);
    if (positions.length < 2) continue;
    const short = positions.filter((p) => p.available > 0 && p.available <= 20);
    const long = positions.filter((p) => p.available >= 400);
    if (short.length === 0 || long.length === 0) continue;
    const from = long[0];
    const to = short[0];
    const moveQty = 120;
    out.push({
      id: `EXC-IMB-${s.id}`,
      kind: 'warehouse_imbalance',
      title: `${skuLabel(state, s.id)} is short at ${byId(state.warehouses, to.warehouseId)?.name}`,
      why: `${to.available} pcs available at ${byId(state.warehouses, to.warehouseId)?.code} while ${from.available} pcs sit at ${byId(state.warehouses, from.warehouseId)?.code}.`,
      ruleId: 'INV-IMB-01',
      rule: 'Inventory rule INV-IMB-01: one location below 20 pcs while another holds 400 or more.',
      ownerId: 'U-RANA',
      detectedAt: `${state.meta.today}T04:12:00Z`,
      severity: 'medium',
      measure: {
        kind: 'potential_sales_value',
        amount: round2(moveQty * (activePriceList(state).prices[s.id] ?? s.listPrice)),
        note: `Value of ${moveQty} pcs at the active list price if a transfer allows them to be sold. Potential only - no order exists.`,
      },
      nextAction: 'Review the transfer scenario',
      href: `/operations/inventory`,
      status: 'Open',
      refs: [{ type: 'sku', id: s.id, label: skuLabel(state, s.id) }],
    });
  }

  return out.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    return b.measure.amount - a.measure.amount;
  });
}

/* ------------------------------ Daily briefing ----------------------------- */

export interface Briefing {
  headline: string;
  lines: string[];
  counts: { open: number; inProgress: number; critical: number };
  measures: { kind: MeasureKind; label: string; amount: number; note: string }[];
}

/**
 * The briefing deliberately reports each measure separately. Carrying value,
 * receivables and purchase exposure are different things and are never added up.
 */
export function buildBriefing(state: DemoState, exceptions: ExceptionItem[]): Briefing {
  const open = exceptions.filter((e) => e.status === 'Open').length;
  const inProgress = exceptions.filter((e) => e.status === 'In progress').length;
  const critical = exceptions.filter((e) => e.severity === 'critical' && e.status !== 'Resolved').length;

  const byMeasure = new Map<MeasureKind, number>();
  for (const e of exceptions) {
    if (e.status === 'Resolved') continue;
    byMeasure.set(e.measure.kind, round2((byMeasure.get(e.measure.kind) ?? 0) + e.measure.amount));
  }

  const pendingApprovals = state.approvals.filter((a) => a.status === 'Pending').length;
  const lines: string[] = [];

  const docExc = exceptions.find((e) => e.kind === 'document_discrepancy' && e.status !== 'Resolved');
  if (docExc) lines.push(`${docExc.title}. Receiving is held until it is resolved or overridden.`);

  const ageExc = exceptions.find((e) => e.kind === 'aging_inventory' && e.status !== 'Resolved');
  if (ageExc) lines.push(ageExc.why);

  const creditExc = exceptions.filter((e) => e.kind === 'credit_review' && e.status !== 'Resolved');
  if (creditExc.length) {
    const age = Math.max(
      ...creditExc.map((e) => daysBetween(e.detectedAt.slice(0, 10), state.meta.today)),
    );
    const when = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;
    lines.push(
      `${creditExc.length} order${creditExc.length === 1 ? '' : 's'} waiting on a credit decision, the oldest raised ${when}.`,
    );
  }

  if (pendingApprovals > 0) {
    lines.push(`${pendingApprovals} approval request${pendingApprovals === 1 ? '' : 's'} pending a decision.`);
  }

  const dio = state.lots.length ? inventoryCarryingValue(state) : 0;
  void dio;

  return {
    headline:
      critical > 0
        ? `${critical} item${critical === 1 ? '' : 's'} need a decision today`
        : open > 0
          ? `${open} open item${open === 1 ? '' : 's'} in the queue`
          : 'Nothing is blocked today',
    lines,
    counts: { open, inProgress, critical },
    measures: [...byMeasure.entries()].map(([kind, amount]) => ({
      kind,
      label: MEASURE_LABEL[kind],
      amount,
      note: exceptions.find((e) => e.measure.kind === kind)?.measure.note ?? '',
    })),
  };
}

export { validateDocument };
