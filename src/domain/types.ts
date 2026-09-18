/** Domain model for the Mobility Pro Command demo (fictional tyre distribution). */

export type Id = string;

export type Role = 'sales' | 'supply_planning' | 'procurement' | 'finance' | 'management';

export interface DemoUser {
  id: Id;
  name: string;
  role: Role;
  title: string;
  initials: string;
}

/* ------------------------------- Catalogue -------------------------------- */

export interface Sku {
  id: Id; // e.g. "TY-2657016-AT"
  brand: string;
  pattern: string; // e.g. "Terra AT-3"
  size: string; // e.g. "265/70R16"
  ply: string; // e.g. "10PR"
  segment: 'PCR' | 'SUV/LT' | 'TBR' | 'OTR';
  unit: 'pcs';
  landedCost: number; // EGP per piece, weighted average landed
  listPrice: number; // EGP per piece from the active price list
}

export interface Warehouse {
  id: Id; // "WH-JAFZA"
  name: string;
  governorate: string;
  code: string;
}

export interface StockLot {
  id: Id;
  skuId: Id;
  warehouseId: Id;
  qty: number; // physical on hand
  reservedQty: number; // committed to orders
  receivedOn: string; // ISO date
  landedCost: number; // EGP per piece for this lot
  sourceShipmentId?: Id;
}

/* -------------------------------- Partners -------------------------------- */

export interface Customer {
  id: Id;
  name: string;
  segment: 'Retail chain' | 'Fleet' | 'Wholesale' | 'Export' | 'Government';
  governorate: string;
  contactName: string;
  contactEmail: string;
  creditLimit: number;
  paymentTermsDays: number;
  onHold: boolean;
  since: string;
  owner: Id; // DemoUser id
}

export interface Supplier {
  id: Id;
  name: string;
  country: string;
  contactName: string;
  contactEmail: string;
  incoterm: 'CFR' | 'FOB';
  paymentTerms: string;
}

/* ------------------------------ Receivables ------------------------------- */

export interface SalesInvoice {
  id: Id;
  customerId: Id;
  issuedOn: string;
  dueOn: string;
  total: number;
  outstanding: number;
  salesOrderId?: Id;
}

export interface CustomerPayment {
  id: Id;
  customerId: Id;
  receivedOn: string;
  amount: number;
  invoiceId?: Id;
}

/* ------------------------------ Procurement ------------------------------- */

export interface PurchaseOrderLine {
  lineNo: number;
  skuId: Id;
  size: string;
  ply: string;
  pattern: string;
  qty: number;
  unitPriceUsd: number;
}

export interface PurchaseOrder {
  id: Id;
  supplierId: Id;
  orderedOn: string;
  incoterm: 'CFR' | 'FOB';
  paymentTerms: string;
  currency: 'USD';
  fxRate: number;
  lines: PurchaseOrderLine[];
  status: 'Open' | 'In production' | 'Shipped' | 'Received' | 'Closed';
}

export type ExtractionState = 'Needs review' | 'Confirmed' | 'Corrected';

export interface ExtractedField {
  key: string; // "line.1.ply"
  label: string;
  group: string; // "Header" | "Line 1" ...
  value: string; // as extracted (string form, normalised on edit)
  originalValue: string; // first extraction, never mutated
  state: ExtractionState;
  page: number;
  anchor: string; // human reference into the source document
  numeric: boolean;
}

export type DocumentKind = 'Pro forma invoice' | 'Packing list' | 'Bill of lading';

export interface SupplierDocument {
  id: Id;
  kind: DocumentKind;
  purchaseOrderId: Id;
  shipmentId?: Id;
  supplierId: Id;
  reference: string; // supplier document number
  issuedOn: string;
  receivedOn: string;
  revision: number;
  supersedesId?: Id;
  extraction: ExtractedField[];
  /** Rendered source document facsimile (pages of structured content). */
  pages: DocPage[];
  extractionMode: 'simulated';
}

export interface DocPage {
  page: number;
  title: string;
  rows: DocRow[];
  footer?: string[];
}

export interface DocRow {
  anchor: string;
  cells: string[];
  emphasis?: boolean;
  heading?: boolean;
}

export type DiscrepancySeverity = 'blocking' | 'advisory';

export interface Discrepancy {
  id: Id;
  fieldKey: string;
  label: string;
  group: string;
  documentValue: string;
  orderValue: string;
  severity: DiscrepancySeverity;
  rule: string;
  ruleId: string;
  impactEgp?: number;
  page: number;
  anchor: string;
  resolved: boolean;
  resolvedBy?: string;
  resolvedNote?: string;
}

export type CaseStatus =
  | 'Open'
  | 'Awaiting supplier'
  | 'Revised document received'
  | 'Resolved'
  | 'Overridden';

export interface DiscrepancyCase {
  id: Id;
  title: string;
  documentId: Id;
  purchaseOrderId: Id;
  shipmentId?: Id;
  status: CaseStatus;
  openedOn: string;
  ownerId: Id;
  discrepancyIds: Id[];
  draft?: SupplierDraft;
  correctedDocumentId?: Id;
  overrideReason?: string;
  overrideBy?: string;
}

export interface SupplierDraft {
  subject: string;
  body: string;
  to: string;
  editedAt?: string;
  sentInDemoAt?: string; // "sent" never leaves the demo
}

export interface Shipment {
  id: Id;
  purchaseOrderId: Id;
  supplierId: Id;
  vessel: string;
  blNumber: string;
  etd: string;
  eta: string;
  portOfLoading: string;
  portOfDischarge: string;
  destinationWarehouseId: Id;
  containers: string[];
  status: 'In transit' | 'Arrived' | 'Cleared' | 'Received';
}

/* --------------------------------- Sales ---------------------------------- */

export interface PriceListVersion {
  id: Id;
  name: string;
  effectiveFrom: string;
  supersededOn?: string;
  active: boolean;
  prices: Record<Id, number>; // skuId -> EGP
}

export interface SalesOrderLine {
  skuId: Id;
  qty: number;
  warehouseId: Id;
  listPrice: number;
  discountPct: number;
  unitPrice: number;
  unitCost: number;
}

export type SalesOrderStatus =
  | 'Draft'
  | 'Blocked - credit'
  | 'Pending approval'
  | 'Approved - reserved'
  | 'Rejected'
  | 'Delivered'
  | 'Invoiced';

export interface SalesOrder {
  id: Id;
  customerId: Id;
  createdOn: string;
  createdBy: Id;
  status: SalesOrderStatus;
  lines: SalesOrderLine[];
  priceListId: Id;
  fulfilmentPlanId?: string;
  approvalId?: Id;
  reservationIds: Id[];
  sourceOpportunityId?: Id;
  notes?: string;
  /** Hash of the material inputs at the time approval was requested. */
  approvalInputHash?: string;
}

export interface Reservation {
  id: Id;
  salesOrderId: Id;
  skuId: Id;
  warehouseId: Id;
  qty: number;
  createdAt: string;
  releasedAt?: string;
}

export interface HistoricalSale {
  id: Id;
  customerId: Id;
  skuId: Id;
  soldOn: string;
  qty: number;
  unitPrice: number;
}

/* ------------------------------- Approvals -------------------------------- */

export type ApprovalStatus =
  | 'Pending'
  | 'Approved'
  | 'Rejected'
  | 'Stale - inputs changed'
  | 'Withdrawn';

export interface ApprovalRequest {
  id: Id;
  kind: 'credit_release' | 'discount' | 'document_override';
  title: string;
  subjectRef: { type: 'salesOrder' | 'case'; id: Id };
  requestedBy: Id;
  requestedAt: string;
  approverRole: Role;
  status: ApprovalStatus;
  decidedBy?: Id;
  decidedAt?: string;
  decisionNote?: string;
  /** Evidence rows shown to the approver. */
  evidence: { label: string; value: string; tone?: 'neutral' | 'warn' | 'bad' | 'good' }[];
  impact: { label: string; value: string }[];
  policyRefs: string[];
  inputHash: string;
  proposal: string;
}

/* ------------------------------- Activity --------------------------------- */

export interface ActivityEvent {
  id: Id;
  at: string;
  actor: string;
  kind: 'system' | 'user' | 'assistant';
  summary: string;
  detail?: string;
  refs: RecordRef[];
}

export interface RecordRef {
  type:
    | 'purchaseOrder'
    | 'shipment'
    | 'document'
    | 'case'
    | 'sku'
    | 'salesOrder'
    | 'customer'
    | 'approval'
    | 'opportunity';
  id: Id;
  label: string;
}

/* ------------------------------ Opportunity ------------------------------- */

export interface InventoryOpportunity {
  id: Id;
  skuId: Id;
  warehouseId: Id;
  reason: string;
  ruleId: string;
  detectedOn: string;
  ownerId: Id;
  status: 'Open' | 'In progress' | 'Actioned' | 'Dismissed';
  /** Editable demand assumption - explicitly an assumption, not a fact. */
  assumption: UpliftAssumption;
  chosenScenarioId?: string;
  salesOrderId?: Id;
}

export interface UpliftAssumption {
  /** Baseline units/month observed from the last 6 months of sales. */
  baselineUnitsPerMonth: number;
  /** Additional units/month assumed per 1pp of discount. Editable. */
  unitsPerDiscountPoint: number;
  /** Months in the modelled window. */
  horizonMonths: number;
  /** Assumed collection delay beyond payment terms, in days. */
  collectionDelayDays: number;
}

/* ------------------------------ Exceptions -------------------------------- */

export type ExceptionKind =
  | 'document_discrepancy'
  | 'aging_inventory'
  | 'credit_review'
  | 'stale_price_list'
  | 'warehouse_imbalance';

export type MeasureKind =
  | 'inventory_carrying_value'
  | 'potential_sales_value'
  | 'gross_profit'
  | 'receivables_at_risk'
  | 'purchase_value_exposed';

export interface ExceptionItem {
  id: Id;
  kind: ExceptionKind;
  title: string;
  why: string;
  ruleId: string;
  rule: string;
  ownerId: Id;
  detectedAt: string;
  severity: 'critical' | 'high' | 'medium';
  /** Explicitly typed measure - never mixed with other measures. */
  measure: { kind: MeasureKind; amount: number; note: string };
  nextAction: string;
  href: string;
  status: 'Open' | 'In progress' | 'Resolved';
  refs: RecordRef[];
}

/* ------------------------------- Policies --------------------------------- */

export interface PolicyDoc {
  id: Id;
  title: string;
  category: 'Approval matrix' | 'Credit policy' | 'Procurement SOP' | 'Pricing policy';
  version: string;
  updatedOn: string;
  clauses: { ref: string; text: string }[];
}

/* ------------------------------ Automations -------------------------------- */

/**
 * An n8n workflow that surrounds this application.
 *
 * Division of labour: this app owns detection and the rules; n8n does the doing
 * — polling ERPNext, sending the message, chasing the approver, writing results
 * back. See docs/N8N_INTEGRATION.md.
 */
export type AutomationTrigger =
  | { kind: 'schedule'; cron: string; human: string }
  | { kind: 'webhook'; path: string; from: string }
  | { kind: 'email'; mailbox: string; human: string };

export type AutomationStatus = 'Active' | 'Paused' | 'Draft';

export interface AutomationStep {
  /** The real n8n node type, so the listed steps match the exported workflow. */
  node: string;
  label: string;
  detail: string;
}

export interface AutomationRun {
  id: Id;
  at: string;
  outcome: 'Success' | 'No work to do' | 'Partial' | 'Failed';
  durationMs: number;
  itemsIn: number;
  itemsOut: number;
  note: string;
  /** Every run in this demo is invented. Nothing has executed. */
  simulated: true;
}

export interface Automation {
  id: Id;
  name: string;
  purpose: string;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  journey: 'Supplier documents' | 'Inventory and credit' | 'Cross-cutting';
  /** What it writes back into this application, in plain language. */
  writesBack: string;
  /** What it will NOT do — the guardrail worth stating out loud. */
  guardrail: string;
  ownerId: Id;
  /** Importable export, served from /n8n/<file>. */
  workflowFile: string;
  runs: AutomationRun[];
}

/* -------------------------------- Root ------------------------------------ */

export interface DemoState {
  meta: {
    sessionId: string;
    createdAt: string;
    today: string;
    seedVersion: string;
    currentUserId: Id;
    guidedStep: number | null;
    erpAdapter: 'ERPNext demo adapter';
  };
  users: DemoUser[];
  skus: Sku[];
  warehouses: Warehouse[];
  lots: StockLot[];
  customers: Customer[];
  suppliers: Supplier[];
  invoices: SalesInvoice[];
  payments: CustomerPayment[];
  purchaseOrders: PurchaseOrder[];
  documents: SupplierDocument[];
  discrepancies: Discrepancy[];
  cases: DiscrepancyCase[];
  shipments: Shipment[];
  priceLists: PriceListVersion[];
  salesOrders: SalesOrder[];
  reservations: Reservation[];
  historicalSales: HistoricalSale[];
  approvals: ApprovalRequest[];
  activity: ActivityEvent[];
  opportunities: InventoryOpportunity[];
  policies: PolicyDoc[];
  automations: Automation[];
}
