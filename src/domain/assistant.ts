/**
 * Contextual assistant.
 *
 * SIMULATED: this is a deterministic rules-and-retrieval assistant. It runs
 * entirely on the demo dataset with no model credentials and no network call.
 * Every number it reports is produced by the same domain functions the UI uses
 * (money, stock, credit and workflow are never "reasoned about" - they are
 * calculated). Where it cannot answer, it says so instead of inventing data.
 *
 * Answers are separated into four bands so the reader always knows what kind
 * of statement they are looking at:
 *   facts        - observed in the dataset
 *   calculations - derived deterministically, with the arithmetic shown
 *   assumptions  - editable demo assumptions or policy settings
 *   recommendation
 */

import { formatDate, formatEGP, formatQty } from './money';
import { receivingReadiness } from './documentRules';
import { CREDIT_RULES, checkCredit, checkStock, discountAuthority } from './credit';
import { runScenario } from './scenarios';
import { buildBriefing, buildExceptions } from './exceptions';
import {
  activePriceList,
  byId,
  customersWhoBought,
  observedUnitsPerMonth,
  orderValue,
  receivables,
  skuLabel,
  skuLongLabel,
  stockAt,
  stockBySku,
} from './selectors';
import type { DemoState, Id, RecordRef } from './types';

export interface AssistantContext {
  /** The record the user is looking at, if any. */
  type?: 'document' | 'case' | 'shipment' | 'opportunity' | 'salesOrder' | 'customer' | 'sku' | 'approval';
  id?: Id;
  path?: string;
}

export interface AssistantBand {
  kind: 'facts' | 'calculations' | 'assumptions' | 'recommendation' | 'limitation';
  title: string;
  items: string[];
}

export interface AssistantActionPreview {
  label: string;
  description: string;
  /** The exact action the UI would dispatch. Subject to identical validation. */
  action: Record<string, unknown>;
  requires?: string;
}

export interface AssistantAnswer {
  intent: string;
  headline: string;
  bands: AssistantBand[];
  refs: RecordRef[];
  actions: AssistantActionPreview[];
  simulated: true;
}

export const SUGGESTED_QUESTIONS = [
  'What needs my attention today?',
  'Why is this shipment blocked?',
  'Compare an 8% discount with transferring this stock.',
  'Which customers have purchased this SKU before?',
  "Why can't this order be released?",
  'Prepare an approval request.',
  'Draft a supplier clarification.',
  'Who approves a 10% discount?',
];

function has(q: string, ...words: string[]): boolean {
  return words.some((w) => q.includes(w));
}

/* -------------------------- Context resolution ----------------------------- */

function resolveOrder(state: DemoState, ctx: AssistantContext) {
  if (ctx.type === 'salesOrder' && ctx.id) return byId(state.salesOrders, ctx.id);
  if (ctx.type === 'approval' && ctx.id) {
    const a = byId(state.approvals, ctx.id);
    return a ? byId(state.salesOrders, a.subjectRef.id) : undefined;
  }
  if (ctx.type === 'opportunity' && ctx.id) {
    const o = byId(state.opportunities, ctx.id);
    return o?.salesOrderId ? byId(state.salesOrders, o.salesOrderId) : undefined;
  }
  return (
    state.salesOrders.find((o) => o.status === 'Pending approval') ??
    state.salesOrders.find((o) => o.status === 'Blocked - credit')
  );
}

function resolveShipment(state: DemoState, ctx: AssistantContext) {
  if (ctx.type === 'shipment' && ctx.id) return byId(state.shipments, ctx.id);
  if (ctx.type === 'document' && ctx.id) {
    const d = byId(state.documents, ctx.id);
    return d?.shipmentId ? byId(state.shipments, d.shipmentId) : undefined;
  }
  if (ctx.type === 'case' && ctx.id) {
    const c = byId(state.cases, ctx.id);
    return c?.shipmentId ? byId(state.shipments, c.shipmentId) : undefined;
  }
  return state.shipments.find((s) => receivingReadiness(state, s.id).state === 'Held - document control');
}

function resolveOpportunity(state: DemoState, ctx: AssistantContext) {
  if (ctx.type === 'opportunity' && ctx.id) return byId(state.opportunities, ctx.id);
  if (ctx.type === 'sku' && ctx.id) return state.opportunities.find((o) => o.skuId === ctx.id);
  return state.opportunities.find((o) => o.status !== 'Dismissed');
}

function resolveSkuId(state: DemoState, ctx: AssistantContext): Id | undefined {
  if (ctx.type === 'sku' && ctx.id) return ctx.id;
  const opp = resolveOpportunity(state, ctx);
  if (opp) return opp.skuId;
  const order = ctx.type === 'salesOrder' && ctx.id ? byId(state.salesOrders, ctx.id) : undefined;
  return order?.lines[0]?.skuId;
}

/* -------------------------------- Answering -------------------------------- */

export function ask(state: DemoState, question: string, ctx: AssistantContext = {}): AssistantAnswer {
  const q = question.toLowerCase().trim();

  if (!q) return limitation(state, 'Ask a question about what you are looking at.');

  if (has(q, 'attention', 'today', 'briefing', 'what should i', 'priorit')) return attentionToday(state);
  if (has(q, 'blocked', 'why is this shipment', 'held', 'receiving') && !has(q, 'order', 'release', 'credit'))
    return whyShipmentBlocked(state, ctx);
  if (has(q, "can't this order", 'cannot be released', 'why is this order', 'release', 'credit hold') || (has(q, 'credit') && has(q, 'why')))
    return whyOrderBlocked(state, ctx);
  if (has(q, 'compare', 'scenario', 'transfer') && has(q, 'discount', 'transfer', 'hold'))
    return compareScenarios(state, ctx, q);
  if (has(q, 'purchased', 'bought', 'buys', 'which customers', 'who buys')) return whoBought(state, ctx);
  if (has(q, 'prepare an approval', 'approval request', 'request approval')) return prepareApproval(state, ctx);
  if (has(q, 'draft', 'clarification', 'supplier message', 'write to the supplier')) return draftClarification(state, ctx);
  if (has(q, 'who approves', 'approval matrix', 'authority', 'policy', 'sop', 'who signs')) return policyAnswer(state, q);
  if (has(q, 'aging', 'ageing', 'slow moving', 'slow-moving', 'old stock', 'dio')) return agingAnswer(state, ctx);
  if (has(q, 'stock', 'availability', 'how many', 'on hand')) return stockAnswer(state, ctx);
  if (has(q, 'overdue', 'receivable', 'owes', 'collection')) return receivablesAnswer(state, ctx);

  return limitation(
    state,
    'This demo assistant answers from the demo dataset using fixed rules. It has no model credentials and will not guess.',
  );
}

/* --------------------------------- Intents --------------------------------- */

function attentionToday(state: DemoState): AssistantAnswer {
  const exceptions = buildExceptions(state).filter((e) => e.status !== 'Resolved');
  const briefing = buildBriefing(state, exceptions);
  const top = exceptions.slice(0, 5);

  return {
    intent: 'attention_today',
    headline: briefing.headline,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Observed in the dataset',
        items: top.map(
          (e) =>
            `${e.severity.toUpperCase()} - ${e.title}. Owner: ${byId(state.users, e.ownerId)?.name}. ${e.why}`,
        ),
      },
      {
        kind: 'calculations',
        title: 'Measures, kept separate',
        items: briefing.measures.map((m) => `${m.label}: ${formatEGP(m.amount)}. ${m.note}`),
      },
      {
        kind: 'assumptions',
        title: 'What these numbers are not',
        items: [
          'These measures are different things and are never added together. Carrying value is cash tied up in stock; receivables are amounts already invoiced; purchase exposure sits under an open supplier order.',
          'Nothing here represents revenue earned or cash collected.',
        ],
      },
      {
        kind: 'recommendation',
        title: 'Suggested order of work',
        items: [
          top[0] ? `Start with "${top[0].title}" - ${top[0].nextAction.toLowerCase()}.` : 'Nothing is blocked.',
          ...top.slice(1, 3).map((e) => `Then: ${e.title} - ${e.nextAction.toLowerCase()}.`),
        ],
      },
    ],
    refs: top.flatMap((e) => e.refs).slice(0, 8),
    actions: [],
  };
}

function whyShipmentBlocked(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  const shipment = resolveShipment(state, ctx);
  if (!shipment) return limitation(state, 'No shipment is currently held by document control.');

  const readiness = receivingReadiness(state, shipment.id);
  const po = byId(state.purchaseOrders, shipment.purchaseOrderId);
  const docs = state.documents.filter((d) => d.shipmentId === shipment.id);
  const doc = docs.filter((d) => d.kind === 'Pro forma invoice').sort((a, b) => b.revision - a.revision)[0];
  const open = state.discrepancies.filter((d) => doc && d.id.startsWith(`DSC-${doc.id}-`) && !d.resolved);
  const relatedCase = state.cases.find((c) => c.shipmentId === shipment.id);

  const refs: RecordRef[] = [
    { type: 'shipment', id: shipment.id, label: shipment.id },
    ...(po ? [{ type: 'purchaseOrder' as const, id: po.id, label: po.id }] : []),
    ...(doc ? [{ type: 'document' as const, id: doc.id, label: doc.reference }] : []),
    ...(relatedCase ? [{ type: 'case' as const, id: relatedCase.id, label: relatedCase.id }] : []),
  ];

  return {
    intent: 'shipment_blocked',
    headline:
      readiness.state === 'Ready for receiving'
        ? `${shipment.id} is ready for receiving.`
        : readiness.state === 'Not yet arrived'
          ? `${shipment.id} has not arrived yet.`
          : `${shipment.id} is held by document control.`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Observed',
        items: [
          `Shipment ${shipment.id}: ${shipment.vessel}, B/L ${shipment.blNumber}, ETA ${formatDate(shipment.eta)}, status "${shipment.status}".`,
          `Destination ${byId(state.warehouses, shipment.destinationWarehouseId)?.name}, discharged at ${shipment.portOfDischarge}.`,
          ...(doc ? [`Latest supplier document on file: ${doc.reference} (revision ${doc.revision}), received ${formatDate(doc.receivedOn)}. Extraction is simulated.`] : []),
        ],
      },
      {
        kind: 'calculations',
        title: 'Rule evaluation',
        items:
          open.length > 0
            ? open.map(
                (d) =>
                  `${d.severity === 'blocking' ? 'BLOCKING' : 'Advisory'} (${d.ruleId}) - ${d.group} ${d.label}: document "${d.documentValue}" vs order "${d.orderValue}"${d.impactEgp ? `, value effect ${formatEGP(Math.abs(d.impactEgp))}` : ''}. Page ${d.page}.`,
              )
            : readiness.reasons,
      },
      {
        kind: 'assumptions',
        title: 'Policy in force',
        items: [
          'Import document control SOP v1.9: spec mismatches (PR-2.1), quantity variance over 2% (PR-2.2), unit-price variance over 0.5% (PR-2.3) and payment-term changes (PR-2.4) are blocking.',
          'PR-3.1: readiness is a document-control state only. It does not mean goods arrived, were counted, or that payment is approved.',
        ],
      },
      {
        kind: 'recommendation',
        title: 'Next step',
        items:
          readiness.state === 'Held - document control'
            ? [
                relatedCase
                  ? `Continue case ${relatedCase.id}: ${relatedCase.status === 'Open' ? 'prepare the supplier clarification' : relatedCase.status === 'Awaiting supplier' ? 'record receipt of the revised document' : 're-run validation'}.`
                  : 'Open a discrepancy case on the document, then prepare a supplier clarification.',
                'Alternatively an authorised Procurement Manager can override with a written reason (AM-3.1) - the mismatches stay on record.',
              ]
            : ['No action required from document control.'],
      },
    ],
    refs,
    actions:
      readiness.state === 'Held - document control' && doc && !relatedCase
        ? [
            {
              label: 'Open a discrepancy case',
              description: `Raise a case against ${doc.reference} with the ${open.length} difference(s) attached.`,
              action: { type: 'case.create', documentId: doc.id },
            },
          ]
        : [],
  };
}

function whyOrderBlocked(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  const order = resolveOrder(state, ctx);
  if (!order) return limitation(state, 'There is no order currently waiting on a credit decision.');

  const cust = byId(state.customers, order.customerId)!;
  const credit = checkCredit(state, order);
  const stock = checkStock(state, order);
  const ar = receivables(state, order.customerId);

  return {
    intent: 'order_blocked',
    headline: credit.released
      ? `${order.id} is within credit policy and can be released.`
      : `${order.id} cannot be released automatically: ${credit.headline}`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Observed',
        items: [
          `${cust.name}, ${cust.segment}, ${cust.paymentTermsDays}-day terms, credit limit ${formatEGP(cust.creditLimit)}.`,
          `Open receivables ${formatEGP(ar.outstanding)}, of which ${formatEGP(ar.overdue)} is overdue.`,
          ...ar.overdueInvoices.map((i) => `${i.id}: ${formatEGP(i.outstanding)} outstanding, due ${formatDate(i.dueOn)}, ${i.daysOverdue} days past due.`),
          ...stock.map(
            (s) =>
              `Stock at ${byId(state.warehouses, s.warehouseId)?.name}: ${s.onHand} on hand, ${s.reserved} reserved, ${s.available} available against ${s.requested} requested.`,
          ),
        ],
      },
      {
        kind: 'calculations',
        title: 'Credit arithmetic',
        items: [
          `Exposure before this order = open receivables ${formatEGP(credit.openReceivables)} + approved undelivered orders ${formatEGP(credit.committedOrders)} = ${formatEGP(credit.exposureBefore)}.`,
          `Order value = ${formatEGP(credit.orderValue)}.`,
          `Exposure after = ${formatEGP(credit.exposureBefore)} + ${formatEGP(credit.orderValue)} = ${formatEGP(credit.exposureAfter)} against a ${formatEGP(credit.creditLimit)} limit, leaving ${formatEGP(credit.availableCreditAfter)}.`,
          ...credit.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.clause} - ${c.description}. ${c.detail}`),
        ],
      },
      {
        kind: 'assumptions',
        title: 'Configurable rules in force',
        items: [
          `Automatic release is withheld once any invoice is more than ${CREDIT_RULES.maxOverdueDays} days past due (CR-3.0 / CR-4.2).`,
          `Minimum advance deposit under CR-4.2(a) is ${(CREDIT_RULES.minDepositFraction * 100).toFixed(0)}% of order value.`,
          'CR-2.1: draft orders are not exposure; only approved undelivered orders are.',
          'These are fictional demo rules held in configuration, not a credit score.',
        ],
      },
      {
        kind: 'recommendation',
        title: credit.released ? 'Next step' : 'Available fulfilment options',
        items: credit.options.map(
          (o) =>
            `${o.label} (${o.clause})${o.requiresApprovalBy ? ` - needs ${o.requiresApprovalBy}` : ' - can be actioned directly'}. ${o.computed?.map((c) => `${c.label}: ${c.value}`).join('; ') ?? ''}`,
        ),
      },
    ],
    refs: [
      { type: 'salesOrder', id: order.id, label: order.id },
      { type: 'customer', id: cust.id, label: cust.name },
    ],
    actions: credit.released
      ? [
          {
            label: 'Release in full',
            description: 'Reserve stock and move the order to fulfilment.',
            action: { type: 'order.releaseFull', orderId: order.id },
          },
        ]
      : credit.options
          .filter((o) => !o.selfService)
          .map((o) => ({
            label: `Request approval: ${o.label}`,
            description: o.description,
            action: { type: 'order.requestApproval', orderId: order.id, optionId: o.id, note: '' },
            requires: o.requiresApprovalBy,
          })),
  };
}

function compareScenarios(state: DemoState, ctx: AssistantContext, q: string): AssistantAnswer {
  const opp = resolveOpportunity(state, ctx);
  if (!opp) return limitation(state, 'No inventory opportunity is open to compare scenarios against.');

  const pos = stockAt(state, opp.skuId, opp.warehouseId);
  const pl = activePriceList(state);
  const listPrice = pl.prices[opp.skuId] ?? byId(state.skus, opp.skuId)!.listPrice;
  const discount = Number(/(\d+)\s*%/.exec(q)?.[1] ?? 8);
  const proposedQty = Math.min(420, pos.available);
  const transferQty = 240;

  const common = {
    lotQty: pos.available,
    proposedQty,
    listPrice,
    unitCost: pos.weightedCost,
    paymentTermsDays: 60,
    assumption: opp.assumption,
    collectionDelayDays: opp.assumption.collectionDelayDays,
    today: state.meta.today,
  };

  const discountRun = runScenario({ ...common, scenarioId: `discount-${discount}` as never, discountPct: discount });
  const transferRun = runScenario({ ...common, scenarioId: 'transfer', discountPct: 0, transferQty });
  const holdRun = runScenario({ ...common, scenarioId: 'hold', discountPct: 0 });

  return {
    intent: 'compare_scenarios',
    headline: `${discount}% discount on ${proposedQty} pcs versus transferring ${transferQty} pcs, for ${skuLabel(state, opp.skuId)}.`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Observed',
        items: [
          `${pos.onHand} pcs on hand at ${byId(state.warehouses, opp.warehouseId)?.name}, ${pos.reserved} reserved, ${pos.available} available.`,
          `Oldest lot received ${formatDate(pos.oldestReceivedOn)} (${pos.maxAgeDays} days).`,
          `Weighted landed cost ${formatEGP(pos.weightedCost)} per piece. Active list price ${formatEGP(listPrice)} (${pl.name}).`,
          `Shipped volume over the last 3 months: ${observedUnitsPerMonth(state, opp.skuId, 3)} pcs/month.`,
        ],
      },
      {
        kind: 'calculations',
        title: 'Deterministic outcomes',
        items: [
          `Discount ${discount}%: unit price ${formatEGP(discountRun.deal!.unitPrice, { cents: true })}, revenue ${formatEGP(discountRun.deal!.revenue)}, cost of goods ${formatEGP(discountRun.deal!.costOfGoods)}, gross profit ${formatEGP(discountRun.deal!.grossProfit)} at ${discountRun.deal!.grossMarginPct}% margin. Remaining stock ${discountRun.remainingStock} pcs.`,
          `Transfer ${transferQty} pcs: handling cost ${formatEGP(transferRun.transferCost)}, no revenue, remaining at source ${transferRun.remainingStock} pcs.`,
          `Hold: no cash movement; carrying cost over ${opp.assumption.horizonMonths} months is ${formatEGP(holdRun.carryingCostOverHorizon)}.`,
          `Estimated collection on the discount option: ${formatDate(discountRun.deal!.estimatedCollectionDate)}.`,
        ],
      },
      {
        kind: 'assumptions',
        title: 'Assumption-led, editable',
        items: [
          `Baseline ${opp.assumption.baselineUnitsPerMonth} pcs/month, plus ${opp.assumption.unitsPerDiscountPoint} pcs/month for each 1pp of discount, over ${opp.assumption.horizonMonths} months.`,
          `At ${discount}% that assumes ${discountRun.assumed.assumedUnitsPerMonth} pcs/month. The discount does not guarantee this volume.`,
          `Carrying cost is modelled at 18% per year of landed cost. Transfer handling is EGP 185 per piece.`,
          `Collection is assumed ${opp.assumption.collectionDelayDays} days beyond terms.`,
        ],
      },
      {
        kind: 'recommendation',
        title: 'Reading of the comparison',
        items: [
          `The discount is the only option that produces a committed gross profit (${formatEGP(discountRun.deal!.grossProfit)}); the transfer produces none and costs ${formatEGP(transferRun.transferCost)}.`,
          `The transfer is worth considering only where the destination has demand this stock cannot reach today.`,
          'Neither result is a forecast. Change the uplift assumption on the opportunity page to see how sensitive the comparison is.',
        ],
      },
    ],
    refs: [
      { type: 'opportunity', id: opp.id, label: opp.id },
      { type: 'sku', id: opp.skuId, label: skuLabel(state, opp.skuId) },
    ],
    actions: [],
  };
}

function whoBought(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  const skuId = resolveSkuId(state, ctx);
  if (!skuId) return limitation(state, 'Open a SKU or an inventory opportunity first, so I know which product you mean.');
  const history = customersWhoBought(state, skuId);
  if (history.length === 0) return limitation(state, `No purchase history exists for ${skuLabel(state, skuId)} in the demo dataset.`);

  return {
    intent: 'who_bought',
    headline: `${history.length} customers have bought ${skuLongLabel(state, skuId)}.`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Purchase history (the evidence behind any suggestion)',
        items: history.map(
          (h) =>
            `${h.customerName}: ${formatQty(h.totalQty)} across ${h.orderCount} order(s). Last purchase ${formatDate(h.lastPurchase)} (${h.daysSinceLast} days ago) at ${formatEGP(h.lastUnitPrice)}. Average realised price ${formatEGP(h.avgUnitPrice)}.`,
        ),
      },
      {
        kind: 'calculations',
        title: 'Current commercial position',
        items: history.slice(0, 4).map((h) => {
          const ar = receivables(state, h.customerId);
          const c = byId(state.customers, h.customerId)!;
          return `${h.customerName}: limit ${formatEGP(c.creditLimit)}, open receivables ${formatEGP(ar.outstanding)}, overdue ${formatEGP(ar.overdue)}${ar.worstOverdueDays ? ` (oldest ${ar.worstOverdueDays} days)` : ''}.`;
        }),
      },
      {
        kind: 'assumptions',
        title: 'Limits of this evidence',
        items: [
          'Ranking is by historical volume only. It is not a prediction that these customers will buy again.',
          'The demo dataset holds roughly 12 months of sales history for this SKU.',
        ],
      },
      {
        kind: 'recommendation',
        title: 'Reading',
        items: [
          history[0]
            ? `${history[0].customerName} is the largest historical buyer at ${formatQty(history[0].totalQty)}; check the overdue position before proposing volume.`
            : '',
        ].filter(Boolean),
      },
    ],
    refs: [
      { type: 'sku', id: skuId, label: skuLabel(state, skuId) },
      ...history.slice(0, 4).map((h) => ({ type: 'customer' as const, id: h.customerId, label: h.customerName })),
    ],
    actions: [],
  };
}

function prepareApproval(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  const order = resolveOrder(state, ctx);
  if (!order) return limitation(state, 'There is no order that needs an approval request right now.');
  const credit = checkCredit(state, order);
  const cust = byId(state.customers, order.customerId)!;

  if (credit.released) {
    return {
      intent: 'prepare_approval',
      headline: `${order.id} does not need an approval request - it is within policy.`,
      simulated: true,
      bands: [
        {
          kind: 'calculations',
          title: 'Why no approval is needed',
          items: credit.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.clause} - ${c.description}. ${c.detail}`),
        },
      ],
      refs: [{ type: 'salesOrder', id: order.id, label: order.id }],
      actions: [
        {
          label: 'Release in full',
          description: 'Reserve stock and move the order to fulfilment.',
          action: { type: 'order.releaseFull', orderId: order.id },
        },
      ],
    };
  }

  const option = credit.options[0];
  return {
    intent: 'prepare_approval',
    headline: `An approval request can be prepared for ${order.id} (${cust.name}).`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Evidence the approver will see',
        items: [
          `Credit limit ${formatEGP(credit.creditLimit)}, open receivables ${formatEGP(credit.openReceivables)}, overdue ${formatEGP(credit.overdue)} (oldest ${credit.worstOverdueDays} days).`,
          `Order value ${formatEGP(credit.orderValue)}; exposure would move from ${formatEGP(credit.exposureBefore)} to ${formatEGP(credit.exposureAfter)}.`,
          `Stock: ${checkStock(state, order).every((s) => s.ok) ? 'sufficient at the requested location' : 'insufficient'}.`,
        ],
      },
      {
        kind: 'assumptions',
        title: 'Routing',
        items: [
          `${option.label} is routed to the ${option.requiresApprovalBy} under ${option.clause}.`,
          `Discount authority: ${discountAuthority(Math.max(...order.lines.map((l) => l.discountPct))).role} (${discountAuthority(Math.max(...order.lines.map((l) => l.discountPct))).clause}).`,
          'The approval lapses automatically if quantity, price, credit limit or overdue balance change afterwards (CR-5.4).',
        ],
      },
      {
        kind: 'recommendation',
        title: 'Preview only',
        items: [
          'Nothing is submitted until you confirm below. The request is subject to exactly the same validation as the button in the order screen.',
        ],
      },
    ],
    refs: [
      { type: 'salesOrder', id: order.id, label: order.id },
      { type: 'customer', id: cust.id, label: cust.name },
    ],
    actions: credit.options
      .filter((o) => !o.selfService)
      .map((o) => ({
        label: `Submit: ${o.label}`,
        description: o.description,
        action: { type: 'order.requestApproval', orderId: order.id, optionId: o.id, note: 'Prepared from the assistant.' },
        requires: o.requiresApprovalBy,
      })),
  };
}

function draftClarification(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  let theCase = ctx.type === 'case' && ctx.id ? byId(state.cases, ctx.id) : undefined;
  if (!theCase && ctx.type === 'document' && ctx.id) {
    theCase = state.cases.find((c) => c.documentId === ctx.id);
  }
  theCase = theCase ?? state.cases.find((c) => c.status === 'Open' || c.status === 'Awaiting supplier');

  if (!theCase) {
    const doc = state.documents.find((d) =>
      state.discrepancies.some((x) => x.id.startsWith(`DSC-${d.id}-`) && !x.resolved && x.severity === 'blocking'),
    );
    if (!doc) return limitation(state, 'There is no open discrepancy to write to a supplier about.');
    return {
      intent: 'draft_clarification',
      headline: 'A case has to exist before a clarification can be drafted.',
      simulated: true,
      bands: [
        {
          kind: 'recommendation',
          title: 'Next step',
          items: [`Open a discrepancy case on ${doc.reference}, then the draft can be generated against it.`],
        },
      ],
      refs: [{ type: 'document', id: doc.id, label: doc.reference }],
      actions: [
        {
          label: 'Open a discrepancy case',
          description: `Raise a case against ${doc.reference}.`,
          action: { type: 'case.create', documentId: doc.id },
        },
      ],
    };
  }

  const doc = byId(state.documents, theCase.documentId)!;
  const items = state.discrepancies.filter((d) => theCase!.discrepancyIds.includes(d.id) && !d.resolved);

  return {
    intent: 'draft_clarification',
    headline: `A supplier clarification can be drafted for case ${theCase.id}.`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Points the draft will raise',
        items: items.map(
          (d) => `${d.severity === 'blocking' ? 'BLOCKING' : 'Advisory'} - ${d.group} ${d.label}: "${d.documentValue}" vs ordered "${d.orderValue}".`,
        ),
      },
      {
        kind: 'assumptions',
        title: 'What happens on send',
        items: [
          'The draft is fully editable before anything is recorded.',
          'Nothing leaves this demo. "Send" records the action inside the case only; no email account is connected.',
        ],
      },
      {
        kind: 'recommendation',
        title: 'Next step',
        items: ['Generate the draft, edit it, then record it as sent to move the case to "Awaiting supplier".'],
      },
    ],
    refs: [
      { type: 'case', id: theCase.id, label: theCase.id },
      { type: 'document', id: doc.id, label: doc.reference },
    ],
    actions: [
      {
        label: theCase.draft ? 'Regenerate the draft' : 'Generate the draft',
        description: 'Builds an editable message listing each blocking point with the ordered value.',
        action: { type: 'case.generateDraft', caseId: theCase.id },
      },
    ],
  };
}

function policyAnswer(state: DemoState, q: string): AssistantAnswer {
  const pct = Number(/(\d+)\s*%/.exec(q)?.[1] ?? NaN);
  const matches = state.policies.flatMap((p) =>
    p.clauses
      .filter((c) => {
        const t = c.text.toLowerCase();
        if (has(q, 'discount') && t.includes('discount')) return true;
        if (has(q, 'credit', 'release') && (t.includes('credit') || t.includes('release'))) return true;
        if (has(q, 'document', 'override', 'discrepancy', 'pi') && (t.includes('document') || t.includes('override') || t.includes('mismatch'))) return true;
        if (has(q, 'price', 'price list') && t.includes('price')) return true;
        return false;
      })
      .map((c) => ({ policy: p, clause: c })),
  );

  const items = matches.length
    ? matches.map((m) => `${m.policy.title} ${m.policy.version}, ${m.clause.ref}: ${m.clause.text}`)
    : state.policies.map((p) => `${p.title} ${p.version} (${p.clauses.length} clauses) - updated ${p.updatedOn}.`);

  const recommendation: string[] = [];
  if (!Number.isNaN(pct)) {
    const a = discountAuthority(pct);
    recommendation.push(`A ${pct}% discount is approved by the ${a.role} under ${a.clause}.`);
  }

  return {
    intent: 'policy',
    headline: matches.length ? 'Relevant policy clauses' : 'Policy documents held in the demo',
    simulated: true,
    bands: [
      { kind: 'facts', title: 'From the demo policy set', items },
      {
        kind: 'assumptions',
        title: 'Status of these documents',
        items: ['These are fictional policy documents written for the demo. They are not the client\'s approved policies.'],
      },
      ...(recommendation.length ? [{ kind: 'recommendation' as const, title: 'Answer', items: recommendation }] : []),
    ],
    refs: [],
    actions: [],
  };
}

function agingAnswer(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  const opp = resolveOpportunity(state, ctx);
  if (!opp) return limitation(state, 'No aging-stock opportunity is currently open.');
  const pos = stockAt(state, opp.skuId, opp.warehouseId);
  const recent3 = observedUnitsPerMonth(state, opp.skuId, 3);
  const recent6 = observedUnitsPerMonth(state, opp.skuId, 6);

  return {
    intent: 'aging',
    headline: `${skuLabel(state, opp.skuId)} at ${byId(state.warehouses, opp.warehouseId)?.name} has aged ${pos.maxAgeDays} days.`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Observed',
        items: [
          `${pos.onHand} pcs on hand, ${pos.reserved} reserved, ${pos.available} available.`,
          `Oldest lot received ${formatDate(pos.oldestReceivedOn)}.`,
          `Shipped volume: ${recent3} pcs/month over 3 months, ${recent6} pcs/month over 6 months.`,
          opp.reason,
        ],
      },
      {
        kind: 'calculations',
        title: 'Measures',
        items: [
          `Inventory carrying value at this location: ${pos.onHand} x ${formatEGP(pos.weightedCost)} = ${formatEGP(pos.onHand * pos.weightedCost)}. This is cash tied up, not profit.`,
          `Months of cover at the 3-month rate: ${recent3 > 0 ? (pos.available / recent3).toFixed(1) : 'n/a'}.`,
        ],
      },
      {
        kind: 'assumptions',
        title: 'Assumptions in the model',
        items: [
          `Baseline used for scenarios: ${opp.assumption.baselineUnitsPerMonth} pcs/month (editable).`,
          `Uplift assumption: ${opp.assumption.unitsPerDiscountPoint} pcs/month per 1pp of discount (editable).`,
        ],
      },
      {
        kind: 'recommendation',
        title: 'Next step',
        items: ['Compare hold, transfer and discount on the opportunity page, then adjust the assumption to test how fragile the answer is.'],
      },
    ],
    refs: [
      { type: 'opportunity', id: opp.id, label: opp.id },
      { type: 'sku', id: opp.skuId, label: skuLabel(state, opp.skuId) },
    ],
    actions: [],
  };
}

function stockAnswer(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  const skuId = resolveSkuId(state, ctx);
  if (!skuId) return limitation(state, 'Open a SKU or an opportunity so I know which product you mean.');
  const positions = stockBySku(state, skuId);
  return {
    intent: 'stock',
    headline: `${skuLongLabel(state, skuId)} across ${positions.length} location(s).`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Stock positions',
        items: positions.map(
          (p) =>
            `${byId(state.warehouses, p.warehouseId)?.name}: ${p.onHand} on hand, ${p.reserved} reserved, ${p.available} available. Oldest lot ${formatDate(p.oldestReceivedOn)} (${p.maxAgeDays} days). Weighted landed cost ${formatEGP(p.weightedCost)}.`,
        ),
      },
      {
        kind: 'calculations',
        title: 'Totals',
        items: [
          `Total on hand ${positions.reduce((n, p) => n + p.onHand, 0)} pcs; total available ${positions.reduce((n, p) => n + p.available, 0)} pcs.`,
          `Inventory carrying value ${formatEGP(positions.reduce((n, p) => n + p.onHand * p.weightedCost, 0))}.`,
        ],
      },
      {
        kind: 'assumptions',
        title: 'Definitions',
        items: ['Available = on hand minus quantity reserved against approved orders. Reservations are created only when an order is released or approved.'],
      },
    ],
    refs: [{ type: 'sku', id: skuId, label: skuLabel(state, skuId) }],
    actions: [],
  };
}

function receivablesAnswer(state: DemoState, ctx: AssistantContext): AssistantAnswer {
  const customerId =
    ctx.type === 'customer' && ctx.id
      ? ctx.id
      : resolveOrder(state, ctx)?.customerId;

  if (customerId) {
    const c = byId(state.customers, customerId)!;
    const ar = receivables(state, customerId);
    return {
      intent: 'receivables',
      headline: `${c.name}: ${formatEGP(ar.outstanding)} open, ${formatEGP(ar.overdue)} overdue.`,
      simulated: true,
      bands: [
        {
          kind: 'facts',
          title: 'Open invoices',
          items: [
            ...ar.overdueInvoices.map((i) => `${i.id}: ${formatEGP(i.outstanding)} outstanding, due ${formatDate(i.dueOn)}, ${i.daysOverdue} days past due.`),
            ...ar.currentInvoices.map((i) => `${i.id}: ${formatEGP(i.outstanding)} outstanding, due ${formatDate(i.dueOn)} (not yet due).`),
          ],
        },
        {
          kind: 'calculations',
          title: 'Position',
          items: [
            `Credit limit ${formatEGP(c.creditLimit)}; open receivables ${formatEGP(ar.outstanding)}; headroom before new orders ${formatEGP(c.creditLimit - ar.outstanding)}.`,
          ],
        },
        {
          kind: 'assumptions',
          title: 'Note',
          items: ['Receivables are amounts already invoiced. They are not revenue for the current period and not cash collected.'],
        },
      ],
      refs: [{ type: 'customer', id: c.id, label: c.name }],
      actions: [],
    };
  }

  const worst = state.customers
    .map((c) => ({ c, ar: receivables(state, c.id) }))
    .filter((x) => x.ar.overdue > 0)
    .sort((a, b) => b.ar.overdue - a.ar.overdue);

  return {
    intent: 'receivables',
    headline: `${worst.length} customers carry an overdue balance.`,
    simulated: true,
    bands: [
      {
        kind: 'facts',
        title: 'Overdue by customer',
        items: worst.map((x) => `${x.c.name}: ${formatEGP(x.ar.overdue)} overdue, oldest ${x.ar.worstOverdueDays} days. Open total ${formatEGP(x.ar.outstanding)}.`),
      },
      {
        kind: 'calculations',
        title: 'Total',
        items: [`Total overdue across the demo dataset: ${formatEGP(worst.reduce((n, x) => n + x.ar.overdue, 0))}.`],
      },
    ],
    refs: worst.slice(0, 5).map((x) => ({ type: 'customer' as const, id: x.c.id, label: x.c.name })),
    actions: [],
  };
}

function limitation(state: DemoState, reason: string): AssistantAnswer {
  void state;
  return {
    intent: 'limitation',
    headline: 'I cannot answer that from the demo dataset.',
    simulated: true,
    bands: [
      { kind: 'limitation', title: 'Why', items: [reason] },
      {
        kind: 'recommendation',
        title: 'What this assistant can do',
        items: SUGGESTED_QUESTIONS,
      },
    ],
    refs: [],
    actions: [],
  };
}

export { orderValue };
