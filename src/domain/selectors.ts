/**
 * Derived reads over the demo state. Nothing here mutates.
 *
 * Every function is deliberately explicit about WHICH measure it returns.
 * Inventory carrying value, potential sales value, gross profit and
 * receivables are separate measures and are never summed together.
 */

import { daysBetween, round0, round2 } from './money';
import type {
  Customer,
  DemoState,
  HistoricalSale,
  Id,
  PriceListVersion,
  SalesOrder,
  Sku,
  StockLot,
  Warehouse,
} from './types';

/* ------------------------------ Tiny lookups ------------------------------- */

export const byId = <T extends { id: Id }>(list: T[], id: Id): T | undefined =>
  list.find((x) => x.id === id);

export const sku = (s: DemoState, id: Id): Sku | undefined => byId(s.skus, id);
export const warehouse = (s: DemoState, id: Id): Warehouse | undefined => byId(s.warehouses, id);
export const customer = (s: DemoState, id: Id): Customer | undefined => byId(s.customers, id);

export function skuLabel(s: DemoState, id: Id): string {
  const k = sku(s, id);
  if (!k) return id;
  return `${k.size} ${k.ply} ${k.pattern}`;
}

export function skuLongLabel(s: DemoState, id: Id): string {
  const k = sku(s, id);
  if (!k) return id;
  return `${k.brand} ${k.pattern} ${k.size} ${k.ply}`;
}

export function userName(s: DemoState, id: Id): string {
  return s.users.find((u) => u.id === id)?.name ?? id;
}

export function activePriceList(s: DemoState): PriceListVersion {
  return s.priceLists.find((p) => p.active) ?? s.priceLists[s.priceLists.length - 1];
}

export function priceOf(s: DemoState, skuId: Id, priceListId?: Id): number {
  const pl = priceListId ? byId(s.priceLists, priceListId) : activePriceList(s);
  return pl?.prices[skuId] ?? sku(s, skuId)?.listPrice ?? 0;
}

/* -------------------------------- Stock ----------------------------------- */

export interface StockPosition {
  skuId: Id;
  warehouseId: Id;
  onHand: number;
  reserved: number;
  available: number;
  /** Weighted average landed cost across the lots in this position. */
  weightedCost: number;
  oldestReceivedOn: string;
  maxAgeDays: number;
  lots: StockLot[];
}

/** Reservations are the single source of truth for committed quantity. */
export function reservedFor(s: DemoState, skuId: Id, warehouseId: Id): number {
  return s.reservations
    .filter((r) => !r.releasedAt && r.skuId === skuId && r.warehouseId === warehouseId)
    .reduce((n, r) => n + r.qty, 0);
}

export function stockAt(s: DemoState, skuId: Id, warehouseId: Id): StockPosition {
  const lots = s.lots.filter((l) => l.skuId === skuId && l.warehouseId === warehouseId);
  const onHand = lots.reduce((n, l) => n + l.qty, 0);
  const reserved = reservedFor(s, skuId, warehouseId);
  const value = lots.reduce((n, l) => n + l.qty * l.landedCost, 0);
  const oldest = lots.map((l) => l.receivedOn).sort()[0] ?? s.meta.today;
  return {
    skuId,
    warehouseId,
    onHand,
    reserved,
    available: Math.max(0, onHand - reserved),
    weightedCost: onHand > 0 ? round2(value / onHand) : 0,
    oldestReceivedOn: oldest,
    maxAgeDays: daysBetween(oldest, s.meta.today),
    lots,
  };
}

export function stockBySku(s: DemoState, skuId: Id): StockPosition[] {
  return s.warehouses
    .map((w) => stockAt(s, skuId, w.id))
    .filter((p) => p.onHand > 0 || p.reserved > 0);
}

export function totalAvailable(s: DemoState, skuId: Id): number {
  return stockBySku(s, skuId).reduce((n, p) => n + p.available, 0);
}

/** MEASURE: inventory carrying value — landed cost of physical stock on hand. */
export function inventoryCarryingValue(s: DemoState, skuId?: Id): number {
  return round2(
    s.lots
      .filter((l) => (skuId ? l.skuId === skuId : true))
      .reduce((n, l) => n + l.qty * l.landedCost, 0),
  );
}

/* ---------------------------- Sales history -------------------------------- */

export function salesForSku(s: DemoState, skuId: Id): HistoricalSale[] {
  return s.historicalSales
    .filter((h) => h.skuId === skuId)
    .sort((a, b) => b.soldOn.localeCompare(a.soldOn));
}

export function salesInWindow(s: DemoState, skuId: Id, months: number): HistoricalSale[] {
  const cutoff = new Date(s.meta.today + 'T00:00:00Z');
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const iso = cutoff.toISOString().slice(0, 10);
  return salesForSku(s, skuId).filter((h) => h.soldOn >= iso);
}

/** Observed shipped units per month over the trailing window. A FACT. */
export function observedUnitsPerMonth(s: DemoState, skuId: Id, months: number): number {
  const units = salesInWindow(s, skuId, months).reduce((n, h) => n + h.qty, 0);
  return round2(units / months);
}

export interface CustomerSkuHistory {
  customerId: Id;
  customerName: string;
  totalQty: number;
  orderCount: number;
  lastPurchase: string;
  lastUnitPrice: number;
  avgUnitPrice: number;
  daysSinceLast: number;
}

/** Purchasing-history evidence behind every suggested customer. */
export function customersWhoBought(s: DemoState, skuId: Id): CustomerSkuHistory[] {
  const map = new Map<Id, HistoricalSale[]>();
  for (const h of salesForSku(s, skuId)) {
    const arr = map.get(h.customerId) ?? [];
    arr.push(h);
    map.set(h.customerId, arr);
  }
  return [...map.entries()]
    .map(([customerId, rows]) => {
      const totalQty = rows.reduce((n, r) => n + r.qty, 0);
      const last = rows.slice().sort((a, b) => b.soldOn.localeCompare(a.soldOn))[0];
      const revenue = rows.reduce((n, r) => n + r.qty * r.unitPrice, 0);
      return {
        customerId,
        customerName: customer(s, customerId)?.name ?? customerId,
        totalQty,
        orderCount: rows.length,
        lastPurchase: last.soldOn,
        lastUnitPrice: last.unitPrice,
        avgUnitPrice: round2(revenue / totalQty),
        daysSinceLast: daysBetween(last.soldOn, s.meta.today),
      };
    })
    .sort((a, b) => b.totalQty - a.totalQty);
}

/* ------------------------------ Receivables -------------------------------- */

export interface ReceivablesSummary {
  /** MEASURE: receivables — invoiced and unpaid. */
  outstanding: number;
  overdue: number;
  worstOverdueDays: number;
  overdueInvoices: { id: Id; dueOn: string; outstanding: number; daysOverdue: number }[];
  currentInvoices: { id: Id; dueOn: string; outstanding: number }[];
}

export function receivables(s: DemoState, customerId: Id): ReceivablesSummary {
  const open = s.invoices.filter((i) => i.customerId === customerId && i.outstanding > 0);
  const overdueInvoices = open
    .filter((i) => i.dueOn < s.meta.today)
    .map((i) => ({
      id: i.id,
      dueOn: i.dueOn,
      outstanding: i.outstanding,
      daysOverdue: daysBetween(i.dueOn, s.meta.today),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  return {
    outstanding: round2(open.reduce((n, i) => n + i.outstanding, 0)),
    overdue: round2(overdueInvoices.reduce((n, i) => n + i.outstanding, 0)),
    worstOverdueDays: overdueInvoices[0]?.daysOverdue ?? 0,
    overdueInvoices,
    currentInvoices: open
      .filter((i) => i.dueOn >= s.meta.today)
      .map((i) => ({ id: i.id, dueOn: i.dueOn, outstanding: i.outstanding }))
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn)),
  };
}

export function orderValue(o: SalesOrder): number {
  return round2(o.lines.reduce((n, l) => n + l.qty * l.unitPrice, 0));
}

export function orderCost(o: SalesOrder): number {
  return round2(o.lines.reduce((n, l) => n + l.qty * l.unitCost, 0));
}

export function orderGrossProfit(o: SalesOrder): number {
  return round2(orderValue(o) - orderCost(o));
}

/** Approved-but-undelivered order value counts as exposure (policy CR-2.1). */
export function committedOrderValue(s: DemoState, customerId: Id, excludeOrderId?: Id): number {
  return round2(
    s.salesOrders
      .filter(
        (o) =>
          o.customerId === customerId &&
          o.id !== excludeOrderId &&
          o.status === 'Approved - reserved',
      )
      .reduce((n, o) => n + orderValue(o), 0),
  );
}

/** MEASURE: credit exposure = open receivables + approved undelivered orders. */
export function creditExposure(s: DemoState, customerId: Id, excludeOrderId?: Id): number {
  return round2(receivables(s, customerId).outstanding + committedOrderValue(s, customerId, excludeOrderId));
}

/* ------------------------------- Portfolio --------------------------------- */

export interface AgingBucket {
  label: string;
  qty: number;
  value: number;
}

export function agingProfile(s: DemoState, skuId?: Id): AgingBucket[] {
  const buckets: AgingBucket[] = [
    { label: '0-60 days', qty: 0, value: 0 },
    { label: '61-120 days', qty: 0, value: 0 },
    { label: '121-180 days', qty: 0, value: 0 },
    { label: 'Over 180 days', qty: 0, value: 0 },
  ];
  for (const l of s.lots) {
    if (skuId && l.skuId !== skuId) continue;
    const age = daysBetween(l.receivedOn, s.meta.today);
    const idx = age <= 60 ? 0 : age <= 120 ? 1 : age <= 180 ? 2 : 3;
    buckets[idx].qty += l.qty;
    buckets[idx].value = round2(buckets[idx].value + l.qty * l.landedCost);
  }
  return buckets;
}

/** Days inventory outstanding, computed from trailing cost of goods shipped. */
export function daysInventoryOutstanding(s: DemoState): number {
  const carrying = inventoryCarryingValue(s);
  const months = 6;
  const cutoff = new Date(s.meta.today + 'T00:00:00Z');
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const iso = cutoff.toISOString().slice(0, 10);
  const cogs = s.historicalSales
    .filter((h) => h.soldOn >= iso)
    .reduce((n, h) => n + h.qty * (sku(s, h.skuId)?.landedCost ?? 0), 0);
  if (cogs <= 0) return 0;
  const dailyCogs = cogs / (months * 30.4);
  return round0(carrying / dailyCogs);
}
