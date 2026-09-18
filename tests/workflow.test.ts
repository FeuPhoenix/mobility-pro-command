import { beforeEach, describe, expect, it } from 'vitest';
import { buildSeedState } from '@/domain/seed';
import { ActionError, applyAction, ensureValidated } from '@/server/actions';
import { checkCredit, checkStock } from '@/domain/credit';
import { creditExposure, orderValue, receivables, stockAt } from '@/domain/selectors';
import { buildExceptions } from '@/domain/exceptions';
import type { DemoState } from '@/domain/types';

const OPP = 'OPP-2026-014';
const SKU = 'TY-2657016-AT3';
const WH = 'WH-OBOUR';
const NILE = 'C-NILEFLT';

function fresh(): DemoState {
  const s = buildSeedState('test');
  ensureValidated(s);
  return s;
}

function expectRefusal(fn: () => unknown, match: RegExp, status?: number) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    expect((e as ActionError).message).toMatch(match);
    if (status) expect((e as ActionError).status).toBe(status);
    return;
  }
  throw new Error('Expected the action to be refused, but it succeeded.');
}

/* --------------------------------- Credit ---------------------------------- */

describe('credit rules', () => {
  let state: DemoState;
  beforeEach(() => {
    state = fresh();
  });

  it('defines exposure as receivables plus approved undelivered orders', () => {
    const ar = receivables(state, NILE);
    expect(ar.outstanding).toBe(13_223_000);
    expect(ar.overdue).toBe(7_110_000);
    expect(ar.worstOverdueDays).toBe(52);
    // No approved orders for this account in the seed, so exposure equals AR.
    expect(creditExposure(state, NILE)).toBe(ar.outstanding);
  });

  it('excludes draft orders from exposure (CR-2.1)', () => {
    const before = creditExposure(state, NILE);
    applyAction(state, {
      type: 'opportunity.createOrder',
      opportunityId: OPP,
      customerId: NILE,
      qty: 420,
      discountPct: 8,
    });
    expect(creditExposure(state, NILE)).toBe(before);
  });

  it('withholds release for an overdue invoice even when stock and limit allow it', () => {
    applyAction(state, {
      type: 'opportunity.createOrder',
      opportunityId: OPP,
      customerId: NILE,
      qty: 420,
      discountPct: 8,
    });
    const order = state.salesOrders.find((o) => o.sourceOpportunityId === OPP)!;
    const credit = checkCredit(state, order);

    expect(credit.outcome).toBe('blocked_overdue');
    expect(credit.released).toBe(false);
    // Stock is fine...
    expect(checkStock(state, order).every((s) => s.ok)).toBe(true);
    // ...and so is the limit.
    expect(credit.exposureAfter).toBeLessThan(credit.creditLimit);
    expect(credit.availableCreditAfter).toBeGreaterThan(0);
    expect(credit.headline).toMatch(/52 days past due/);
  });

  it('offers a deposit, a partial release and a finance review, all needing approval', () => {
    applyAction(state, {
      type: 'opportunity.createOrder',
      opportunityId: OPP,
      customerId: NILE,
      qty: 420,
      discountPct: 8,
    });
    const order = state.salesOrders.find((o) => o.sourceOpportunityId === OPP)!;
    const credit = checkCredit(state, order);

    expect(credit.options.map((o) => o.id)).toEqual(['deposit', 'partial', 'finance_review']);
    expect(credit.options.every((o) => !o.selfService)).toBe(true);
    const deposit = credit.options[0].computed!.find((c) => c.label.includes('Deposit'))!;
    // 30% of the order value
    expect(deposit.value).toBe(`EGP ${Math.round(orderValue(order) * 0.3).toLocaleString('en-EG')}`);
  });

  it('blocks a customer who is over the limit for a different reason', () => {
    const order = state.salesOrders.find((o) => o.id === 'SO-2026-0766')!;
    const credit = checkCredit(state, order);
    expect(credit.outcome).toBe('blocked_limit');
    expect(credit.exposureAfter).toBeGreaterThan(credit.creditLimit);
  });
});

/* ------------------------------- Order guards ------------------------------ */

describe('order creation guards', () => {
  let state: DemoState;
  beforeEach(() => {
    state = fresh();
  });

  it('refuses more than the available quantity', () => {
    expectRefusal(
      () =>
        applyAction(state, {
          type: 'opportunity.createOrder',
          opportunityId: OPP,
          customerId: NILE,
          qty: 5000,
          discountPct: 8,
        }),
      /Only 812 pcs are available/,
    );
  });

  it('refuses a fractional quantity', () => {
    expectRefusal(
      () =>
        applyAction(state, {
          type: 'opportunity.createOrder',
          opportunityId: OPP,
          customerId: NILE,
          qty: 10.5,
          discountPct: 8,
        }),
      /whole number/,
    );
  });

  it('refuses a price below landed cost (PP-3.1)', () => {
    expectRefusal(
      () =>
        applyAction(state, {
          type: 'opportunity.createOrder',
          opportunityId: OPP,
          customerId: NILE,
          qty: 100,
          discountPct: 30,
        }),
      /below the weighted landed cost/,
    );
  });

  it('refuses a second order from the same opportunity', () => {
    applyAction(state, {
      type: 'opportunity.createOrder',
      opportunityId: OPP,
      customerId: NILE,
      qty: 100,
      discountPct: 5,
    });
    expectRefusal(
      () =>
        applyAction(state, {
          type: 'opportunity.createOrder',
          opportunityId: OPP,
          customerId: NILE,
          qty: 100,
          discountPct: 5,
        }),
      /already prepared/,
      409,
    );
  });
});

/* -------------------------------- Approvals -------------------------------- */

describe('approval workflow', () => {
  let state: DemoState;
  let orderId: string;

  beforeEach(() => {
    state = fresh();
    applyAction(state, {
      type: 'opportunity.createOrder',
      opportunityId: OPP,
      customerId: NILE,
      qty: 420,
      discountPct: 8,
    });
    orderId = state.salesOrders.find((o) => o.sourceOpportunityId === OPP)!.id;
  });

  it('refuses a direct release while the order is held', () => {
    expectRefusal(() => applyAction(state, { type: 'order.releaseFull', orderId }), /Release refused/, 409);
  });

  it('refuses a second pending request on the same order', () => {
    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'deposit', note: '' });
    expectRefusal(
      () => applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'partial', note: '' }),
      /already pending/,
      409,
    );
  });

  it('refuses a decision from an unauthorised role', () => {
    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'deposit', note: '' });
    const approvalId = state.approvals[0].id;
    expectRefusal(
      () => applyAction(state, { type: 'approval.decide', approvalId, decision: 'Approved', note: '' }),
      /not authorised/,
      403,
    );
  });

  it('lapses the approval when a material input changes (CR-5.4)', () => {
    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'deposit', note: '' });
    const approvalId = state.approvals[0].id;
    applyAction(state, { type: 'order.updateLine', orderId, qty: 400, discountPct: 8 });

    expect(state.approvals[0].status).toBe('Stale - inputs changed');
    expect(state.salesOrders.find((o) => o.id === orderId)!.status).toBe('Blocked - credit');
    expectRefusal(
      () => applyAction(state, { type: 'approval.decide', approvalId, decision: 'Approved', note: '' }),
      /already "Stale - inputs changed"/,
      409,
    );
  });

  it('approves, reserves stock and updates availability consistently', () => {
    const before = stockAt(state, SKU, WH);
    expect(before.available).toBe(812);

    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'deposit', note: '' });
    applyAction(state, { type: 'demo.setRole', userId: 'U-SAMIR' });
    const approvalId = state.approvals[0].id;
    applyAction(state, { type: 'approval.decide', approvalId, decision: 'Approved', note: 'Deposit agreed.' });

    const order = state.salesOrders.find((o) => o.id === orderId)!;
    expect(order.status).toBe('Approved - reserved');
    expect(state.reservations.filter((r) => r.salesOrderId === orderId)).toHaveLength(1);

    const after = stockAt(state, SKU, WH);
    expect(after.onHand).toBe(812); // physical stock is untouched
    expect(after.reserved).toBe(420);
    expect(after.available).toBe(392);

    // The approved order now counts as exposure.
    expect(creditExposure(state, NILE)).toBe(13_223_000 + orderValue(order));

    // Approval must not recognise revenue or collect cash.
    expect(receivables(state, NILE).outstanding).toBe(13_223_000);
    expect(state.opportunities[0].status).toBe('Actioned');
  });

  it('refuses a second decision on the same request', () => {
    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'deposit', note: '' });
    applyAction(state, { type: 'demo.setRole', userId: 'U-SAMIR' });
    const approvalId = state.approvals[0].id;
    applyAction(state, { type: 'approval.decide', approvalId, decision: 'Approved', note: '' });
    expectRefusal(
      () => applyAction(state, { type: 'approval.decide', approvalId, decision: 'Rejected', note: '' }),
      /cannot be recorded twice/,
      409,
    );
  });

  it('never creates a duplicate reservation or negative available stock', () => {
    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'deposit', note: '' });
    applyAction(state, { type: 'demo.setRole', userId: 'U-SAMIR' });
    applyAction(state, { type: 'approval.decide', approvalId: state.approvals[0].id, decision: 'Approved', note: '' });

    expectRefusal(() => applyAction(state, { type: 'order.releaseFull', orderId }), /already released/, 409);
    expect(state.reservations.filter((r) => r.salesOrderId === orderId && !r.releasedAt)).toHaveLength(1);
    expect(stockAt(state, SKU, WH).available).toBeGreaterThanOrEqual(0);
  });

  it('rejects cleanly, reserving nothing', () => {
    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'finance_review', note: '' });
    applyAction(state, { type: 'demo.setRole', userId: 'U-SAMIR' });
    applyAction(state, {
      type: 'approval.decide',
      approvalId: state.approvals[0].id,
      decision: 'Rejected',
      note: 'Settle the 52-day invoice first.',
    });
    expect(state.salesOrders.find((o) => o.id === orderId)!.status).toBe('Rejected');
    expect(state.reservations.filter((r) => r.salesOrderId === orderId)).toHaveLength(0);
    expect(stockAt(state, SKU, WH).available).toBe(812);
  });

  it('locks an approved order against further edits', () => {
    applyAction(state, { type: 'order.requestApproval', orderId, optionId: 'deposit', note: '' });
    applyAction(state, { type: 'demo.setRole', userId: 'U-SAMIR' });
    applyAction(state, { type: 'approval.decide', approvalId: state.approvals[0].id, decision: 'Approved', note: '' });
    expectRefusal(
      () => applyAction(state, { type: 'order.updateLine', orderId, qty: 100, discountPct: 8 }),
      /approved and reserved/,
      409,
    );
  });
});

/* ------------------------------ Price control ------------------------------ */

describe('price list control', () => {
  it('refuses release on a superseded price list and re-prices onto the active one', () => {
    const state = fresh();
    const orderId = 'SO-2026-0771';
    expectRefusal(() => applyAction(state, { type: 'order.releaseFull', orderId }), /superseded list/, 409);

    applyAction(state, { type: 'order.repriceToActive', orderId });
    const order = state.salesOrders.find((o) => o.id === orderId)!;
    expect(order.priceListId).toBe('PL-2026-Q3');
    expect(order.lines[0].listPrice).toBe(4160);

    expectRefusal(
      () => applyAction(state, { type: 'order.repriceToActive', orderId }),
      /already uses the active price list/,
      409,
    );
  });
});

/* -------------------------------- Exceptions ------------------------------- */

describe('exception queue', () => {
  it('ranks by severity and keeps each measure typed', () => {
    const state = fresh();
    const ex = buildExceptions(state);
    expect(ex.length).toBeGreaterThanOrEqual(4);
    expect(ex[0].severity).toBe('critical');

    const kinds = new Set(ex.map((e) => e.kind));
    expect(kinds).toContain('document_discrepancy');
    expect(kinds).toContain('aging_inventory');
    expect(kinds).toContain('credit_review');
    expect(kinds).toContain('stale_price_list');

    // Each exception carries exactly one explicitly typed measure.
    for (const e of ex) {
      expect(e.measure.kind).toBeTruthy();
      expect(e.measure.note.length).toBeGreaterThan(10);
    }
  });

  it('reconciles the aging measure to the underlying lot', () => {
    const state = fresh();
    const ex = buildExceptions(state).find((e) => e.kind === 'aging_inventory')!;
    const pos = stockAt(state, SKU, WH);
    expect(ex.measure.kind).toBe('inventory_carrying_value');
    expect(ex.measure.amount).toBe(pos.onHand * pos.weightedCost);
    expect(ex.measure.amount).toBe(812 * 3540);
  });

  it('clears the document exception once the case resolves', () => {
    const state = fresh();
    applyAction(state, { type: 'case.create', documentId: 'DOC-PI-0418-R1' });
    const caseId = state.cases[0].id;
    applyAction(state, { type: 'case.simulateCorrected', caseId });
    applyAction(state, { type: 'case.revalidate', caseId });
    expect(buildExceptions(state).find((e) => e.kind === 'document_discrepancy')).toBeUndefined();
  });
});

/* --------------------------------- Reset ----------------------------------- */

describe('demo reset', () => {
  it('returns an identical dataset to a fresh visitor', () => {
    const a = buildSeedState('s1');
    const b = buildSeedState('s2');
    const strip = (s: DemoState) => JSON.stringify({ ...s, meta: { ...s.meta, sessionId: '', createdAt: '' } });
    expect(strip(a)).toBe(strip(b));
  });

  it('seeds no cases, approvals or discrepancies before validation runs', () => {
    const s = buildSeedState('s3');
    expect(s.cases).toHaveLength(0);
    expect(s.approvals).toHaveLength(0);
    expect(s.discrepancies).toHaveLength(0);
  });
});
