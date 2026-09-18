import { describe, expect, it } from 'vitest';
import { carryingCost, dealMath, runScenario, TRANSFER_COST_PER_UNIT } from '@/domain/scenarios';

const BASE = {
  listPrice: 4610,
  unitCost: 3540,
  paymentTermsDays: 90,
  collectionDelayDays: 12,
  today: '2026-09-17',
};

describe('deal arithmetic (deterministic)', () => {
  it('computes price, revenue, cost, profit and margin exactly', () => {
    const d = dealMath({ ...BASE, qty: 420, discountPct: 8 });
    expect(d.unitPrice).toBe(4241.2);
    expect(d.revenue).toBe(1_781_304);
    expect(d.costOfGoods).toBe(1_486_800);
    expect(d.grossProfit).toBe(294_504);
    expect(d.grossMarginPct).toBe(16.53);
    expect(d.unitMargin).toBe(701.2);
  });

  it('moves consistently across the 5 / 8 / 10 percent steps', () => {
    const five = dealMath({ ...BASE, qty: 420, discountPct: 5 });
    const eight = dealMath({ ...BASE, qty: 420, discountPct: 8 });
    const ten = dealMath({ ...BASE, qty: 420, discountPct: 10 });

    expect(five.unitPrice).toBe(4379.5);
    expect(ten.unitPrice).toBe(4149);
    expect(five.grossProfit).toBeGreaterThan(eight.grossProfit);
    expect(eight.grossProfit).toBeGreaterThan(ten.grossProfit);
    // Cost of goods is untouched by a price decision.
    expect(five.costOfGoods).toBe(ten.costOfGoods);
  });

  it('scales linearly with quantity', () => {
    const a = dealMath({ ...BASE, qty: 100, discountPct: 8 });
    const b = dealMath({ ...BASE, qty: 200, discountPct: 8 });
    expect(b.revenue).toBe(a.revenue * 2);
    expect(b.grossProfit).toBe(a.grossProfit * 2);
    expect(b.grossMarginPct).toBe(a.grossMarginPct);
  });

  it('flags a price below landed cost', () => {
    expect(dealMath({ ...BASE, qty: 10, discountPct: 10 }).belowCost).toBe(false);
    expect(dealMath({ ...BASE, qty: 10, discountPct: 30 }).belowCost).toBe(true);
  });

  it('derives the collection date from terms plus the assumed delay', () => {
    const d = dealMath({ ...BASE, qty: 10, discountPct: 0 });
    expect(d.dueDate).toBe('2026-12-16');
    expect(d.estimatedCollectionDate).toBe('2026-12-28');
  });
});

describe('carrying cost', () => {
  it('is an annual percentage pro-rated over the horizon', () => {
    // 412 pcs x EGP 3,540 x 18% x (3/12)
    expect(carryingCost(412, 3540, 3)).toBe(65_631.6);
    expect(carryingCost(412, 3540, 12)).toBe(carryingCost(412, 3540, 3) * 4);
    expect(carryingCost(0, 3540, 3)).toBe(0);
  });
});

describe('scenarios', () => {
  const common = {
    ...BASE,
    lotQty: 812,
    proposedQty: 420,
    assumption: { baselineUnitsPerMonth: 56, unitsPerDiscountPoint: 4.5, horizonMonths: 3 },
  };

  it('hold produces no revenue and only a carrying cost', () => {
    const s = runScenario({ ...common, scenarioId: 'hold', discountPct: 0 });
    expect(s.deal).toBeNull();
    expect(s.remainingStock).toBe(812);
    expect(s.netContribution).toBeLessThan(0);
    expect(s.assumed.assumedUnitsPerMonth).toBe(56);
  });

  it('transfer costs money and creates no revenue', () => {
    const s = runScenario({ ...common, scenarioId: 'transfer', discountPct: 0, transferQty: 240 });
    expect(s.deal).toBeNull();
    expect(s.transferCost).toBe(240 * TRANSFER_COST_PER_UNIT);
    expect(s.remainingStock).toBe(812 - 240);
    expect(s.cautions.join(' ')).toMatch(/does not create a sale/i);
  });

  it('a discount scenario commits the proposed quantity and reduces remaining stock', () => {
    const s = runScenario({ ...common, scenarioId: 'discount-8', discountPct: 8 });
    expect(s.deal!.qty).toBe(420);
    expect(s.remainingStock).toBe(392);
    expect(s.deal!.grossProfit).toBe(294_504);
  });

  it('never commits more than the lot holds', () => {
    const s = runScenario({ ...common, scenarioId: 'discount-8', discountPct: 8, proposedQty: 5000 });
    expect(s.deal!.qty).toBe(812);
    expect(s.remainingStock).toBe(0);
  });

  it('keeps the uplift assumption separate and responsive to editing', () => {
    const low = runScenario({
      ...common,
      scenarioId: 'discount-10',
      discountPct: 10,
      assumption: { ...common.assumption, unitsPerDiscountPoint: 0 },
    });
    const high = runScenario({
      ...common,
      scenarioId: 'discount-10',
      discountPct: 10,
      assumption: { ...common.assumption, unitsPerDiscountPoint: 10 },
    });

    // The assumption changes the assumed rate...
    expect(low.assumed.assumedUnitsPerMonth).toBe(56);
    expect(high.assumed.assumedUnitsPerMonth).toBe(156);
    // ...but must never change the deterministic arithmetic.
    expect(low.deal!.revenue).toBe(high.deal!.revenue);
    expect(low.deal!.grossProfit).toBe(high.deal!.grossProfit);
  });

  it('warns when the discount takes the price below landed cost', () => {
    const s = runScenario({ ...common, scenarioId: 'discount-10', discountPct: 30 });
    expect(s.deal!.belowCost).toBe(true);
    expect(s.cautions[0]).toMatch(/below weighted landed cost/i);
  });
});
