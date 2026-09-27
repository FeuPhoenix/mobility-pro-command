/**
 * The ERPNext destination for raw freight quotations, as Frappe DocType
 * definitions. This is the primary destination the customer asked for: store
 * the quotations as they arrive, and build the analysis on top in ERPNext.
 *
 * See docs/FREIGHT_ERPNEXT.md for the reasoning and the field-by-field notes.
 *
 * A unit test checks these definitions hold every field
 * `quotationPayload()` writes. If you change one, change the other; the test
 * fails until they agree.
 */

export const PARENT = 'Freight Quotation';
export const CHILD = 'Freight Quotation Charge';
export const INTEGRATION_ROLE = 'Freight RFQ Integration';

const perms = (role) => [
  { role: 'System Manager', read: 1, write: 1, create: 1, delete: 1, report: 1, export: 1 },
  { role, read: 1, write: 1, create: 1, report: 1 },
];

/**
 * One charge line.
 *
 * `amount` is deliberately **not** required and has no default. A provider that
 * names a surcharge without pricing it must land here as empty, because zero
 * would make their offer look cheaper than it is.
 */
export function childDoctype({ module }) {
  return {
    doctype: 'DocType',
    name: CHILD,
    module,
    custom: 1,
    istable: 1,
    editable_grid: 1,
    fields: [
      { fieldname: 'charge_code', label: 'Code', fieldtype: 'Data', in_list_view: 1, reqd: 1 },
      { fieldname: 'charge_label', label: 'Charge', fieldtype: 'Data', in_list_view: 1 },
      {
        fieldname: 'amount',
        label: 'Amount',
        fieldtype: 'Float',
        in_list_view: 1,
        precision: '2',
        description: 'Empty means the provider did not state an amount. It is not zero.',
      },
      { fieldname: 'currency', label: 'Currency', fieldtype: 'Data', length: 3 },
      {
        fieldname: 'basis',
        label: 'Charged on',
        fieldtype: 'Select',
        options: ['per_container', 'per_shipment', 'per_bl', 'per_cbm', 'per_tonne', 'unknown'].join('\n'),
      },
      {
        fieldname: 'confidence',
        label: 'Confidence',
        fieldtype: 'Select',
        options: ['high', 'medium', 'low', 'missing'].join('\n'),
      },
      { fieldname: 'source_reference', label: 'Read from', fieldtype: 'Data', read_only: 1 },
    ],
    permissions: [],
  };
}

export function parentDoctype({ module, supplierLink }) {
  return {
    doctype: 'DocType',
    name: PARENT,
    module,
    custom: 1,
    naming_rule: 'Expression (old style)',
    autoname: 'format:FQ-{rfq_reference}-{provider_name}-v{quotation_version}',
    title_field: 'provider_name',
    track_changes: 1,
    fields: [
      // --- identity -------------------------------------------------------
      {
        fieldname: 'freight_idempotency_key',
        label: 'Integration key',
        fieldtype: 'Data',
        unique: 1,
        read_only: 1,
        reqd: 1,
        description:
          'Set by the freight application. A retry searches on this, so add a unique index and never edit it by hand.',
      },
      { fieldname: 'company', label: 'Company', fieldtype: 'Link', options: 'Company', reqd: 1 },
      supplierLink
        ? { fieldname: 'supplier', label: 'Supplier', fieldtype: 'Link', options: 'Supplier' }
        : { fieldname: 'supplier', label: 'Supplier', fieldtype: 'Data' },
      { fieldname: 'provider_name', label: 'Provider', fieldtype: 'Data', reqd: 1, in_list_view: 1 },

      // --- what was asked for ---------------------------------------------
      { fieldname: 'section_request', label: 'Request', fieldtype: 'Section Break' },
      { fieldname: 'rfq_reference', label: 'RFQ reference', fieldtype: 'Data', reqd: 1, in_list_view: 1 },
      { fieldname: 'route', label: 'Route', fieldtype: 'Data', in_list_view: 1 },
      { fieldname: 'origin_port', label: 'Origin port', fieldtype: 'Data' },
      { fieldname: 'destination_port', label: 'Destination port', fieldtype: 'Data' },
      { fieldname: 'incoterm', label: 'Incoterm', fieldtype: 'Data' },

      // --- which version this is ------------------------------------------
      { fieldname: 'section_version', label: 'Version', fieldtype: 'Section Break' },
      {
        fieldname: 'quotation_version',
        label: 'Version',
        fieldtype: 'Int',
        reqd: 1,
        description: 'Providers revise. Each version is its own record; do not aggregate across them blindly.',
      },
      { fieldname: 'supersedes_quotation', label: 'Supersedes', fieldtype: 'Data', read_only: 1 },
      { fieldname: 'quotation_status', label: 'Status', fieldtype: 'Data', read_only: 1 },
      { fieldname: 'received_at', label: 'Received', fieldtype: 'Date' },
      { fieldname: 'reviewed_at', label: 'Checked by a person', fieldtype: 'Date' },

      // --- the offer --------------------------------------------------------
      { fieldname: 'section_offer', label: 'Offer', fieldtype: 'Section Break' },
      { fieldname: 'shipping_line', label: 'Shipping line', fieldtype: 'Data' },
      { fieldname: 'currency', label: 'Currency', fieldtype: 'Data', length: 3 },
      { fieldname: 'container_basis', label: 'Rate basis', fieldtype: 'Data' },
      {
        fieldname: 'base_freight',
        label: 'Base freight',
        fieldtype: 'Float',
        precision: '2',
        description: 'Per container, on the basis in Rate basis. Empty means not stated.',
      },
      { fieldname: 'total_quoted_by_provider', label: 'Total quoted by provider', fieldtype: 'Float', precision: '2' },
      { fieldname: 'column_offer', fieldtype: 'Column Break' },
      { fieldname: 'transit_days', label: 'Transit days', fieldtype: 'Int' },
      { fieldname: 'free_days_destination', label: 'Free days at destination', fieldtype: 'Int' },
      { fieldname: 'valid_until', label: 'Valid until', fieldtype: 'Date' },
      { fieldname: 'sailing_date', label: 'Sailing date', fieldtype: 'Date' },
      { fieldname: 'payment_terms', label: 'Payment terms', fieldtype: 'Small Text' },

      // --- charges ----------------------------------------------------------
      { fieldname: 'section_charges', label: 'Charges', fieldtype: 'Section Break' },
      { fieldname: 'charges', label: 'Charges', fieldtype: 'Table', options: CHILD },

      // --- terms ------------------------------------------------------------
      { fieldname: 'section_terms', label: 'Terms', fieldtype: 'Section Break' },
      { fieldname: 'inclusions', label: 'Included', fieldtype: 'Small Text' },
      { fieldname: 'exclusions', label: 'Excluded', fieldtype: 'Small Text' },
      { fieldname: 'conditions', label: 'Conditions', fieldtype: 'Small Text' },

      // --- where the figures came from ---------------------------------------
      { fieldname: 'section_provenance', label: 'Provenance', fieldtype: 'Section Break', collapsible: 1 },
      {
        fieldname: 'source_kind',
        label: 'Read from',
        fieldtype: 'Data',
        read_only: 1,
        description: 'email_body, excel, pdf_text or manual.',
      },
      { fieldname: 'source_attachment', label: 'Source file', fieldtype: 'Data', read_only: 1 },
      { fieldname: 'extractor', label: 'Extractor', fieldtype: 'Data', read_only: 1 },
      {
        fieldname: 'field_confidence',
        label: 'Field confidence',
        fieldtype: 'Code',
        options: 'JSON',
        read_only: 1,
        description:
          'Per field: high, medium, low, missing, or corrected_by_reviewer. Treat anything below high as needing a human before it drives a decision.',
      },
    ],
    permissions: perms(INTEGRATION_ROLE),
  };
}

/** Both definitions, in the order they must be created. */
export function doctypes(opts) {
  return [childDoctype(opts), parentDoctype(opts)];
}
