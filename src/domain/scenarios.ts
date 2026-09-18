/**
 * Inventory scenario modelling for the aging-stock journey.
 *
 * The hard separation this module enforces:
 *
 *   DETERMINISTIC  - price, revenue, cost of goods, gross profit, gross margin,
 *                    remaining stock, collection date. Given quantity and
 *                    discount, these are arithmetic and not open to debate.
 *
 *   ASSUMPTION-LED - how many units actually move, how long the rest takes to
 *                    clear, carrying cost avoided. These depend on an editable
 *                    demand assumption and are always labelled as such.
 *
 * A discount does not guarantee additional sales. Nothing in here should be
 * presented as a forecast.
 */

import { addDays, round0, round2 } from './money';

/** Demo assumption: internal cost of holding stock, as an annual % of landed cost. */
export const CARRYING_COST_ANNUAL_PCT = 0.18;
/** Demo assumption: inter-warehouse transfer handling cost per piece, EGP. */
export const TRANSFER_COST_PER_UNIT = 185;

export interface DealInputs {
  qty: number;
  discountPct: number;
  listPrice: number;
  unitCost: number;
  paymentTermsDays: number;
  /** Assumed collection delay beyond terms, in days. An assumption. */
  collectionDelayDays: number;
  today: string;
}

export interface DealMath {
  qty: number;
  discountPct: number;
  listPrice: number;
  unitPrice: number;
  unitCost: number;
  revenue: number;
  costOfGoods: number;
  grossProfit: number;
  grossMarginPct: number;
  unitMargin: number;
  /** True when the discounted price falls below weighted landed cost. */
  belowCost: boolean;
  invoiceDate: string;
  dueDate: string;
  estimatedCollectionDate: string;
}

/** Pure arithmetic. No assumptions, no demand modelling. */
export function dealMath(i: DealInputs): DealMath {
  const unitPrice = round2(i.listPrice * (1 - i.discountPct / 100));
  const revenue = round2(unitPrice * i.qty);
  const costOfGoods = round2(i.unitCost * i.qty);
  const grossProfit = round2(revenue - costOfGoods);
  const dueDate = addDays(i.today, i.paymentTermsDays);
  return {
    qty: i.qty,
    discountPct: i.discountPct,
    listPrice: i.listPrice,
    unitPrice,
    unitCost: i.unitCost,
    revenue,
    costOfGoods,
    grossProfit,
    grossMarginPct: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
    unitMargin: round2(unitPrice - i.unitCost),
    belowCost: unitPrice < i.unitCost,
    invoiceDate: i.today,
    dueDate,
    estimatedCollectionDate: addDays(dueDate, i.collectionDelayDays),
  };
}

/* ------------------------------ Assumptions -------------------------------- */

export interface DemandAssumption {
  baselineUnitsPerMonth: number;
  unitsPerDiscountPoint: number;
  horizonMonths: number;
}

export interface AssumedOutcome {
  /** Units/month assumed to move at this discount. ASSUMPTION. */
  assumedUnitsPerMonth: number;
  /** Units assumed to move across the horizon. ASSUMPTION. */
  assumedUnitsInHorizon: number;
  /** Months to clear the remaining lot at the assumed rate. ASSUMPTION. */
  monthsToClearRemaining: number | null;
  /** Carrying cost avoided versus holding, over the horizon. ASSUMPTION. */
  carryingCostAvoided: number;
}

/**
 * `carryingCostAvoided` is left at 0 here and filled in by each scenario,
 * because "avoided" only means something against a stated baseline (holding).
 */
export function assumedOutcome(
  a: DemandAssumption,
  discountPct: number,
  remainingUnits: number,
): AssumedOutcome {
  const assumedUnitsPerMonth = round2(
    a.baselineUnitsPerMonth + a.unitsPerDiscountPoint * discountPct,
  );
  const assumedUnitsInHorizon = round0(assumedUnitsPerMonth * a.horizonMonths);
  const monthsToClearRemaining =
    assumedUnitsPerMonth > 0 ? round2(remainingUnits / assumedUnitsPerMonth) : null;
  return {
    assumedUnitsPerMonth,
    assumedUnitsInHorizon,
    monthsToClearRemaining,
    carryingCostAvoided: 0,
  };
}

/** Carrying cost of holding `units` at `unitCost` for `months`. Deterministic. */
export function carryingCost(units: number, unitCost: number, months: number): number {
  return round2(units * unitCost * CARRYING_COST_ANNUAL_PCT * (months / 12));
}

/* -------------------------------- Scenarios -------------------------------- */

export type ScenarioId = 'hold' | 'transfer' | 'discount-5' | 'discount-8' | 'discount-10';

export interface ScenarioInput {
  scenarioId: ScenarioId;
  lotQty: number;
  proposedQty: number;
  discountPct: number;
  listPrice: number;
  unitCost: number;
  paymentTermsDays: number;
  assumption: DemandAssumption;
  collectionDelayDays: number;
  today: string;
  /** Units moved to another warehouse in the transfer scenario. */
  transferQty?: number;
}

export interface ScenarioResult {
  id: ScenarioId;
  name: string;
  summary: string;
  /** Deterministic block. */
  deal: DealMath | null;
  transferCost: number;
  remainingStock: number;
  /** Assumption-led block. */
  assumed: AssumedOutcome;
  carryingCostOverHorizon: number;
  /** Deterministic gross profit in the horizon minus deterministic costs. */
  netContribution: number;
  cautions: string[];
}

export function runScenario(i: ScenarioInput): ScenarioResult {
  const months = i.assumption.horizonMonths;

  if (i.scenarioId === 'hold') {
    const assumed = assumedOutcome(i.assumption, 0, i.lotQty);
    const holdCarry = carryingCost(i.lotQty, i.unitCost, months);
    return {
      id: 'hold',
      name: 'Hold at current price',
      summary: 'No price action. Stock continues to age at the current shipped rate.',
      deal: null,
      transferCost: 0,
      remainingStock: i.lotQty,
      assumed,
      carryingCostOverHorizon: holdCarry,
      netContribution: round2(-holdCarry),
      cautions: [
        'No committed order. Any volume shown is an assumption, not a forecast.',
        `Carrying cost is modelled at ${(CARRYING_COST_ANNUAL_PCT * 100).toFixed(0)}% per year of landed cost (demo assumption).`,
      ],
    };
  }

  if (i.scenarioId === 'transfer') {
    const moved = Math.min(i.transferQty ?? 0, i.lotQty);
    const transferCost = round2(moved * TRANSFER_COST_PER_UNIT);
    const remaining = i.lotQty - moved;
    const assumed = assumedOutcome(i.assumption, 0, remaining);
    const holdCarry = carryingCost(i.lotQty, i.unitCost, months);
    const carryAfter = carryingCost(remaining, i.unitCost, months);
    return {
      id: 'transfer',
      name: 'Transfer to another warehouse',
      summary: `Move ${moved} pcs to a location with live demand. No revenue is generated by the move itself.`,
      deal: null,
      transferCost,
      remainingStock: remaining,
      assumed: { ...assumed, carryingCostAvoided: round2(holdCarry - carryAfter) },
      carryingCostOverHorizon: carryAfter,
      netContribution: round2(-transferCost - carryAfter),
      cautions: [
        'A transfer relocates stock; it does not create a sale.',
        `Handling cost is a flat EGP ${TRANSFER_COST_PER_UNIT} per piece (demo assumption).`,
        'Destination demand is an assumption until an order exists.',
      ],
    };
  }

  // Discount scenarios: the proposed quantity is what would actually be committed.
  const qty = Math.min(i.proposedQty, i.lotQty);
  const deal = dealMath({
    qty,
    discountPct: i.discountPct,
    listPrice: i.listPrice,
    unitCost: i.unitCost,
    paymentTermsDays: i.paymentTermsDays,
    collectionDelayDays: i.collectionDelayDays,
    today: i.today,
  });
  const remaining = i.lotQty - qty;
  const assumed = assumedOutcome(i.assumption, i.discountPct, remaining);
  const holdCarry = carryingCost(i.lotQty, i.unitCost, months);
  const carryAfter = carryingCost(remaining, i.unitCost, months);

  const cautions = [
    'Gross profit shown is for the proposed quantity only. It is not a forecast of total demand.',
    'The discount does not guarantee additional volume. The uplift assumption is editable and separate.',
  ];
  if (deal.belowCost) {
    cautions.unshift('Discounted price is below weighted landed cost. Finance Director approval is required (PP-3.1).');
  }

  return {
    id: i.scenarioId,
    name: `Discount ${i.discountPct}%`,
    summary: `Commit ${qty} pcs at ${i.discountPct}% off the active list price.`,
    deal,
    transferCost: 0,
    remainingStock: remaining,
    assumed: { ...assumed, carryingCostAvoided: round2(holdCarry - carryAfter) },
    carryingCostOverHorizon: carryAfter,
    netContribution: round2(deal.grossProfit - carryAfter),
    cautions,
  };
}
