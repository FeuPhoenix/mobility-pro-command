/**
 * ERPNext integration boundary.
 *
 * Application logic never talks to ERPNext directly - it talks to this
 * interface. The demo ships one implementation: `DemoAdapter`, which reads the
 * local fictional dataset and performs no network I/O whatsoever.
 *
 * IMPORTANT
 *  - The UI must never display "Connected to ERPNext" unless `probe()` has
 *    actually succeeded against a configured instance. The default label is
 *    "ERPNext demo adapter".
 *  - A live adapter is deliberately NOT implemented here. Building one requires
 *    verifying the installed Frappe/ERPNext version, the REST surface for that
 *    version, permissions, the custom fields in use and the site's workflows.
 *    See docs/ERPNEXT_INTEGRATION.md for the proposed mapping and the open
 *    discovery questions.
 *  - Any future live adapter starts read-only. Writes require separate,
 *    explicit configuration and permission.
 */

import type { DemoState } from '@/domain/types';

export type AdapterMode = 'demo' | 'readonly' | 'disabled';

export interface AdapterStatus {
  /** Shown verbatim in the UI. Never say "connected" without a successful probe. */
  label: string;
  mode: AdapterMode;
  connected: boolean;
  detail: string;
  /** ERPNext/Frappe version, only ever populated by a real successful probe. */
  version?: string;
  lastProbedAt?: string;
}

/** Records that the demo maps onto ERPNext doctypes. */
export interface ErpRecordMapping {
  domain: string;
  doctype: string;
  keyField: string;
  notes: string;
  /** Write support is out of scope for the demo. */
  direction: 'read' | 'read/write (not implemented)';
}

export const ERP_MAPPINGS: ErpRecordMapping[] = [
  { domain: 'Customer', doctype: 'Customer', keyField: 'name', notes: 'Credit limit lives on Customer Credit Limit child table, per company.', direction: 'read' },
  { domain: 'Sku', doctype: 'Item', keyField: 'item_code', notes: 'size / ply / pattern are expected to be custom fields or Item Attributes; must be confirmed on the live site.', direction: 'read' },
  { domain: 'Warehouse', doctype: 'Warehouse', keyField: 'name', notes: 'Tree doctype; leaf warehouses only.', direction: 'read' },
  { domain: 'StockLot', doctype: 'Stock Ledger Entry / Batch', keyField: 'name', notes: 'Lot age requires batch-wise or FIFO valuation; confirm whether batching is enabled.', direction: 'read' },
  { domain: 'Reservation', doctype: 'Stock Reservation Entry', keyField: 'name', notes: 'Available from ERPNext v15. On older versions, reservations must be modelled outside ERPNext.', direction: 'read/write (not implemented)' },
  { domain: 'PurchaseOrder', doctype: 'Purchase Order', keyField: 'name', notes: 'Line specs map to Purchase Order Item.', direction: 'read' },
  { domain: 'SupplierDocument', doctype: 'File / custom doctype', keyField: 'name', notes: 'ERPNext has no native pro-forma-invoice doctype; a custom doctype or File attachment is required.', direction: 'read' },
  { domain: 'Shipment', doctype: 'Shipment / Purchase Receipt', keyField: 'name', notes: 'Pre-receipt tracking is usually custom; Purchase Receipt only exists after receiving.', direction: 'read' },
  { domain: 'SalesOrder', doctype: 'Sales Order', keyField: 'name', notes: 'Fulfilment plan and credit decision are custom fields in this design.', direction: 'read/write (not implemented)' },
  { domain: 'SalesInvoice', doctype: 'Sales Invoice', keyField: 'name', notes: 'Outstanding amount from outstanding_amount; ageing from due_date.', direction: 'read' },
  { domain: 'CustomerPayment', doctype: 'Payment Entry', keyField: 'name', notes: 'Allocation to invoices via Payment Entry Reference.', direction: 'read' },
  { domain: 'PriceListVersion', doctype: 'Price List / Item Price', keyField: 'price_list', notes: 'ERPNext has no native price-list versioning; valid_from on Item Price is the closest fit.', direction: 'read' },
];

export interface ErpNextAdapter {
  status(): AdapterStatus;
  probe(): Promise<AdapterStatus>;
  listCustomers(): Promise<{ id: string; name: string; creditLimit: number }[]>;
  listItems(): Promise<{ id: string; description: string }[]>;
  listOpenInvoices(customerId: string): Promise<{ id: string; dueOn: string; outstanding: number }[]>;
}

/** The only adapter wired into the demo. No network, no credentials. */
export class DemoAdapter implements ErpNextAdapter {
  constructor(private readonly state: DemoState) {}

  status(): AdapterStatus {
    return {
      label: 'ERPNext demo adapter',
      mode: 'demo',
      connected: false,
      detail:
        'Reading the local fictional dataset. No ERPNext instance is configured and no network request is made. Figures shown are demo data, not live records.',
    };
  }

  async probe(): Promise<AdapterStatus> {
    // Deliberately does not attempt a connection: there is nothing configured.
    return this.status();
  }

  async listCustomers() {
    return this.state.customers.map((c) => ({ id: c.id, name: c.name, creditLimit: c.creditLimit }));
  }

  async listItems() {
    return this.state.skus.map((s) => ({
      id: s.id,
      description: `${s.brand} ${s.pattern} ${s.size} ${s.ply}`,
    }));
  }

  async listOpenInvoices(customerId: string) {
    return this.state.invoices
      .filter((i) => i.customerId === customerId && i.outstanding > 0)
      .map((i) => ({ id: i.id, dueOn: i.dueOn, outstanding: i.outstanding }));
  }
}

/**
 * Resolves the adapter for the current process.
 *
 * Even when ERPNEXT_BASE_URL is set, the demo stays on the demo adapter and
 * says so: connectivity has not been verified and no live adapter exists yet.
 */
export function resolveAdapter(state: DemoState): ErpNextAdapter {
  return new DemoAdapter(state);
}

export function adapterStatusForDisplay(state: DemoState): AdapterStatus {
  const configured = Boolean(process.env.ERPNEXT_BASE_URL);
  const base = resolveAdapter(state).status();
  if (!configured) return base;
  return {
    ...base,
    detail:
      'ERPNEXT_BASE_URL is set, but no live adapter is implemented and connectivity has not been verified. The demo continues to read the local fictional dataset.',
  };
}
