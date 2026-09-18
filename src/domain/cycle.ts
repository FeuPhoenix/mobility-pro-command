/**
 * The demand-to-cash cycle, transcribed from the client briefing workbook
 * (tab "1) Demand-to-Cash (MAIN CYCLE)").
 *
 * `coverage` is an honest statement of what this DEMO does, not a claim about
 * what is automated in the client's live operation:
 *   - 'demonstrated' : a working journey in this demo touches this stage.
 *   - 'context'      : shown for orientation; no interactive journey here.
 */

export type StageCoverage = 'demonstrated' | 'context';

export interface CycleStage {
  key: string;
  stage: string;
  activities: string;
  owners: string;
  coverage: StageCoverage;
  /** What this demo actually does at this stage. */
  demoNote?: string;
  href?: string;
}

export const DEMAND_TO_CASH: CycleStage[] = [
  {
    key: 'demand-estimation',
    stage: 'Demand estimation',
    activities: 'Review historical sales, sales forecast, market pulse, customer/SKU demand.',
    owners: 'Sales, Procurement, Supply Planning',
    coverage: 'context',
  },
  {
    key: 'demand-inventory-planning',
    stage: 'Demand & inventory planning',
    activities: 'Review stock, aging, DIO, pipeline, future arrivals; decide buy/hold/move/push.',
    owners: 'Procurement, Supply Planning, Sales, Finance',
    coverage: 'demonstrated',
    demoNote: 'Aging-stock rule raises an opportunity with hold / transfer / discount scenarios.',
    href: '/operations/inventory',
  },
  {
    key: 'buying-decision',
    stage: 'Buying decision',
    activities: 'Decide SKU, quantity, supplier, timing, lead time, cost and terms.',
    owners: 'Procurement, Finance, Sales',
    coverage: 'context',
  },
  {
    key: 'supplier-pi-check',
    stage: 'Supplier order & PI check',
    activities: 'Send order to factory, receive PI, check size, ply, pattern, quantity, price, terms.',
    owners: 'Procurement',
    coverage: 'demonstrated',
    demoNote: 'Full document-control journey: compare, correct, case, clarification draft, revised document.',
    href: '/operations/documents',
  },
  {
    key: 'production-ready-goods',
    stage: 'Production & ready goods check',
    activities: 'Track production, receive ready goods notice, compare ready goods vs PI/order.',
    owners: 'Procurement',
    coverage: 'context',
  },
  {
    key: 'payment-financing',
    stage: 'Payment / financing',
    activities: 'Confirm terms, payment timing, credit/LC/cash requirement and approval.',
    owners: 'Finance, Procurement, Management',
    coverage: 'context',
    demoNote: 'Payment-term mismatches are detected, but no payment instruction is modelled.',
  },
  {
    key: 'freight-booking',
    stage: 'Freight & shipping booking',
    activities: 'Decide CFR/FOB, get quotations if FOB, book line and coordinate shipment.',
    owners: 'Freight, Procurement, Finance',
    coverage: 'context',
  },
  {
    key: 'documents-clearance',
    stage: 'Documents & clearance',
    activities: 'Manage document cycle, check BL, invoice, packing list and customs documents.',
    owners: 'Freight, Procurement, Finance, Clearance partner',
    coverage: 'demonstrated',
    demoNote: 'Pro forma invoice and packing list are both viewable and validated against the order.',
    href: '/operations/documents',
  },
  {
    key: 'warehouse-receiving',
    stage: 'Warehouse receiving',
    activities: 'Receive goods, check packing list vs actual quantity/specs, record discrepancy.',
    owners: 'Warehouse, Freight, Procurement',
    coverage: 'demonstrated',
    demoNote: 'Receiving READINESS is modelled and gated by document control. Physical counting is not.',
    href: '/operations/documents',
  },
  {
    key: 'inventory-availability',
    stage: 'Inventory availability',
    activities: 'Stock becomes available; sales notified; stock position updated by warehouse/market.',
    owners: 'Warehouse, Supply Planning, Sales',
    coverage: 'demonstrated',
    demoNote: 'Live on-hand / reserved / available per warehouse, updated by approvals.',
    href: '/operations/inventory',
  },
  {
    key: 'trade-pricing',
    stage: 'Trade pricing decision',
    activities: 'Set or revise price based on landed cost, stock position, market price and margin.',
    owners: 'Pricing Committee, Sales, Finance, Procurement',
    coverage: 'demonstrated',
    demoNote: 'Price-list versioning and a stale-version exception. Committee workflow is not modelled.',
    href: '/operations/orders',
  },
  {
    key: 'order-capture',
    stage: 'Customer order capture',
    activities: 'Customer places order; order details captured and checked.',
    owners: 'Sales, Sales Ops',
    coverage: 'demonstrated',
    demoNote: 'Orders are created from an inventory opportunity with full line-level pricing.',
    href: '/operations/orders',
  },
  {
    key: 'credit-fulfilment',
    stage: 'Credit & fulfilment decision',
    activities: 'Check stock, credit balance, overdue, customer performance; decide fulfill/hold/split.',
    owners: 'Supply Planning, Finance, Sales',
    coverage: 'demonstrated',
    demoNote: 'Explainable credit rules, fulfilment options, approval inbox, reservations.',
    href: '/approvals',
  },
  {
    key: 'picking-delivery',
    stage: 'Pre-invoice, picking & delivery',
    activities: 'Pre-invoice goes to warehouse; warehouse picks, dispatches and delivers goods.',
    owners: 'Warehouse, Sales Ops, Finance',
    coverage: 'context',
    demoNote: 'Approval creates reservations only. No picking or dispatch is simulated.',
  },
  {
    key: 'invoicing',
    stage: 'Invoicing',
    activities: 'Issue invoice, match to sales order and delivery note, send to customer, confirm due date.',
    owners: 'Finance, Sales',
    coverage: 'context',
    demoNote: 'Existing invoices are seeded as receivables. No invoice is raised by the demo.',
  },
  {
    key: 'collection',
    stage: 'Collection',
    activities: 'Monitor AR ageing, send statements, follow up terms, escalate overdue, post payments.',
    owners: 'Finance, Sales',
    coverage: 'demonstrated',
    demoNote: 'Receivables ageing drives the credit decision. Statements and postings are not modelled.',
    href: '/customers',
  },
];
