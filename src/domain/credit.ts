/**
 * Credit and fulfilment rules.
 *
 * These are configurable, explainable business rules from the fictional
 * credit policy (POL-CREDIT v3.1). There is no opaque "AI credit score"
 * anywhere in this demo: every outcome names the clause that produced it.
 */

import { round2 } from './money';
import { creditExposure, orderValue, receivables, stockAt, totalAvailable } from './selectors';
import type { DemoState, Id, SalesOrder } from './types';

/** Configurable fictional credit rules. */
export const CREDIT_RULES = {
  /** Automatic release is withheld once an invoice passes this age. */
  maxOverdueDays: 30,
  /** Minimum advance deposit, as a fraction of order value, under CR-4.2(a). */
  minDepositFraction: 0.3,
} as const;

export type CreditOutcome = 'release' | 'blocked_overdue' | 'blocked_limit' | 'blocked_hold';

export interface CreditCheck {
  outcome: CreditOutcome;
  released: boolean;
  headline: string;
  /** Observed facts. */
  creditLimit: number;
  openReceivables: number;
  overdue: number;
  worstOverdueDays: number;
  committedOrders: number;
  exposureBefore: number;
  /** Deterministic calculation. */
  orderValue: number;
  exposureAfter: number;
  availableCreditBefore: number;
  availableCreditAfter: number;
  /** Rule trace. */
  checks: { clause: string; description: string; passed: boolean; detail: string }[];
  options: FulfilmentOption[];
}

export interface FulfilmentOption {
  id: string;
  label: string;
  description: string;
  clause: string;
  /** Whether this option can be taken without an approval request. */
  selfService: boolean;
  requiresApprovalBy?: 'Finance Director' | 'Commercial Director';
  computed?: { label: string; value: string }[];
  assumptions?: string[];
}

export interface StockCheck {
  skuId: Id;
  warehouseId: Id;
  requested: number;
  onHand: number;
  reserved: number;
  available: number;
  sufficient: number;
  ok: boolean;
}

export function checkStock(state: DemoState, order: SalesOrder): StockCheck[] {
  return order.lines.map((l) => {
    const p = stockAt(state, l.skuId, l.warehouseId);
    // Quantity already reserved by THIS order should not count against itself.
    const ownReserved = state.reservations
      .filter((r) => !r.releasedAt && r.salesOrderId === order.id && r.skuId === l.skuId && r.warehouseId === l.warehouseId)
      .reduce((n, r) => n + r.qty, 0);
    const available = Math.max(0, p.onHand - (p.reserved - ownReserved));
    return {
      skuId: l.skuId,
      warehouseId: l.warehouseId,
      requested: l.qty,
      onHand: p.onHand,
      reserved: p.reserved,
      available,
      sufficient: available - l.qty,
      ok: available >= l.qty,
    };
  });
}

export function checkCredit(state: DemoState, order: SalesOrder): CreditCheck {
  const cust = state.customers.find((c) => c.id === order.customerId);
  const ar = receivables(state, order.customerId);
  const exposureBefore = creditExposure(state, order.customerId, order.id);
  const value = orderValue(order);
  const exposureAfter = round2(exposureBefore + value);
  const limit = cust?.creditLimit ?? 0;
  const committed = round2(exposureBefore - ar.outstanding);

  const checks: CreditCheck['checks'] = [];

  const notOnHold = !(cust?.onHold ?? false);
  checks.push({
    clause: 'CR-3.0',
    description: 'Customer is not on hold',
    passed: notOnHold,
    detail: notOnHold ? 'Account is active.' : 'Account is flagged on hold by Finance.',
  });

  const withinLimit = exposureAfter <= limit;
  checks.push({
    clause: 'CR-3.0',
    description: 'Exposure after this order is within the approved credit limit',
    passed: withinLimit,
    detail: `${fmt(exposureBefore)} exposure + ${fmt(value)} order = ${fmt(exposureAfter)} against a ${fmt(limit)} limit.`,
  });

  const noBadOverdue = ar.worstOverdueDays <= CREDIT_RULES.maxOverdueDays;
  checks.push({
    clause: 'CR-3.0',
    description: `No invoice more than ${CREDIT_RULES.maxOverdueDays} days past due`,
    passed: noBadOverdue,
    detail: ar.worstOverdueDays > 0
      ? `Oldest overdue invoice is ${ar.worstOverdueDays} days past due (${fmt(ar.overdue)} overdue in total).`
      : 'No overdue invoices.',
  });

  let outcome: CreditOutcome = 'release';
  let headline = 'Within policy. This order can be released without an approval request.';
  if (!notOnHold) {
    outcome = 'blocked_hold';
    headline = 'Account is on hold. Release requires Finance to lift the hold first.';
  } else if (!noBadOverdue) {
    outcome = 'blocked_overdue';
    headline = `Stock is available and the limit has room, but an invoice is ${ar.worstOverdueDays} days past due. Automatic release is withheld under CR-4.2.`;
  } else if (!withinLimit) {
    outcome = 'blocked_limit';
    headline = `Exposure after this order (${fmt(exposureAfter)}) exceeds the ${fmt(limit)} credit limit.`;
  }

  return {
    outcome,
    released: outcome === 'release',
    headline,
    creditLimit: limit,
    openReceivables: ar.outstanding,
    overdue: ar.overdue,
    worstOverdueDays: ar.worstOverdueDays,
    committedOrders: committed,
    exposureBefore,
    orderValue: value,
    exposureAfter,
    availableCreditBefore: round2(limit - exposureBefore),
    availableCreditAfter: round2(limit - exposureAfter),
    checks,
    options: buildOptions(outcome, value, limit, exposureBefore, ar.overdue, order),
  };
}

function fmt(n: number): string {
  return `EGP ${Math.round(n).toLocaleString('en-EG')}`;
}

function buildOptions(
  outcome: CreditOutcome,
  value: number,
  limit: number,
  exposureBefore: number,
  overdue: number,
  order: SalesOrder,
): FulfilmentOption[] {
  if (outcome === 'release') {
    return [
      {
        id: 'release_full',
        label: 'Release in full',
        description: 'Reserve the full quantity and move the order to fulfilment.',
        clause: 'CR-3.0',
        selfService: true,
        computed: [{ label: 'Order value', value: fmt(value) }],
      },
    ];
  }

  if (outcome === 'blocked_hold') {
    return [
      {
        id: 'finance_review',
        label: 'Request Finance review',
        description: 'Ask Finance to review the hold and record a decision on this order.',
        clause: 'CR-4.2(c)',
        selfService: false,
        requiresApprovalBy: 'Finance Director',
      },
    ];
  }

  const deposit = round2(value * CREDIT_RULES.minDepositFraction);
  const headroom = Math.max(0, round2(limit - exposureBefore));
  const partialFraction = value > 0 ? Math.min(1, headroom / value) : 0;
  const partialQty = Math.floor(
    order.lines.reduce((n, l) => n + l.qty, 0) * partialFraction,
  );

  return [
    {
      id: 'deposit',
      label: `Release against a ${(CREDIT_RULES.minDepositFraction * 100).toFixed(0)}% advance deposit`,
      description:
        'Customer pays a deposit before dispatch; the balance follows normal terms. Requires Finance Director approval.',
      clause: 'CR-4.2(a)',
      selfService: false,
      requiresApprovalBy: 'Finance Director',
      computed: [
        { label: 'Order value', value: fmt(value) },
        { label: 'Deposit required before dispatch', value: fmt(deposit) },
        { label: 'Balance on terms', value: fmt(round2(value - deposit)) },
      ],
      assumptions: [
        'Demo policy assumption: a deposit reduces the uncovered exposure but does not settle the existing overdue balance.',
      ],
    },
    {
      id: 'partial',
      label: 'Partial release within the uncovered limit',
      description:
        'Release only the portion that fits inside the remaining credit headroom; hold the balance until the overdue invoice is settled.',
      clause: 'CR-4.2(b)',
      selfService: false,
      requiresApprovalBy: 'Finance Director',
      computed: [
        { label: 'Remaining credit headroom', value: fmt(headroom) },
        { label: 'Releasable now (approx.)', value: `${partialQty.toLocaleString('en-EG')} pcs` },
        { label: 'Overdue balance still outstanding', value: fmt(overdue) },
      ],
      assumptions: [
        'Demo policy assumption: partial release is proportional across order lines and rounded down to whole pieces.',
      ],
    },
    {
      id: 'finance_review',
      label: 'Finance review with a dated collection commitment',
      description:
        'Escalate to Finance with the receivables evidence and a committed settlement date from the customer.',
      clause: 'CR-4.2(c)',
      selfService: false,
      requiresApprovalBy: 'Finance Director',
      computed: [{ label: 'Overdue balance to be addressed', value: fmt(overdue) }],
      assumptions: ['Demo policy assumption: a collection commitment is recorded as a note, not as cash received.'],
    },
  ];
}

/* --------------------------- Discount authority ---------------------------- */

export function discountAuthority(discountPct: number): {
  role: string;
  clause: string;
  needsApproval: boolean;
} {
  if (discountPct <= 5) return { role: 'Key Accounts Manager', clause: 'AM-1.1', needsApproval: false };
  if (discountPct <= 10) return { role: 'Commercial Director', clause: 'AM-1.2', needsApproval: true };
  return { role: 'Commercial Director and Finance Director', clause: 'AM-1.3', needsApproval: true };
}

/* ------------------------- Approval staleness hash ------------------------- */

/**
 * The material inputs behind a credit approval (policy CR-5.4).
 * If any of these change after the request, the approval is stale.
 */
export function approvalInputHash(state: DemoState, order: SalesOrder): string {
  const cust = state.customers.find((c) => c.id === order.customerId);
  const ar = receivables(state, order.customerId);
  const parts = [
    order.id,
    order.lines
      .map((l) => `${l.skuId}:${l.qty}:${l.unitPrice}:${l.warehouseId}`)
      .join('|'),
    `limit=${cust?.creditLimit ?? 0}`,
    `overdue=${ar.overdue}`,
  ];
  return simpleHash(parts.join('::'));
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export { totalAvailable };
