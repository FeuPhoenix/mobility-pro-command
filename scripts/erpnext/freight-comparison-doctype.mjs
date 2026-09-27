/**
 * The proposed ERPNext destination for freight comparison outcomes, as Frappe
 * DocType definitions. See docs/FREIGHT_ERPNEXT.md for the reasoning.
 *
 * Used by scripts/erpnext-create-doctype.mjs to create it, and by the unit
 * tests to prove it holds every field the application writes. If you change
 * erpPayload() in src/freight/adapters/erpnext.ts, change this too; the test
 * fails until they agree.
 */

export const PARENT = 'Freight Comparison';
export const CHILD = 'Freight Comparison Offer';
export const INTEGRATION_ROLE = 'Freight RFQ Integration';

const perms = (role) => [
  { role: 'System Manager', read: 1, write: 1, create: 1, delete: 1, report: 1, export: 1 },
  { role, read: 1, write: 1, create: 1, report: 1 },
];

/** @param {{ module: string, supplierLink: boolean }} opts */
export function childDoctype({ module }) {
  return {
    doctype: 'DocType',
    name: CHILD,
    module,
    custom: 1,
    istable: 1,
    editable_grid: 1,
    fields: [
      { fieldname: 'provider', label: 'Provider', fieldtype: 'Data', in_list_view: 1, reqd: 1 },
      { fieldname: 'quote_version', label: 'Quote version', fieldtype: 'Int' },
      { fieldname: 'comparable', label: 'Comparable', fieldtype: 'Check', in_list_view: 1 },
      { fieldname: 'total_quote_currency', label: 'Total (quote currency)', fieldtype: 'Float', precision: '2' },
      { fieldname: 'quote_currency', label: 'Quote currency', fieldtype: 'Data' },
      { fieldname: 'total_base_currency', label: 'Total (base currency)', fieldtype: 'Float', precision: '2', in_list_view: 1 },
      { fieldname: 'transit_days', label: 'Transit days', fieldtype: 'Int', in_list_view: 1 },
      { fieldname: 'free_days', label: 'Free days', fieldtype: 'Int' },
      { fieldname: 'valid_until', label: 'Valid until', fieldtype: 'Date' },
      { fieldname: 'rank', label: 'Rank', fieldtype: 'Int', in_list_view: 1 },
      { fieldname: 'score', label: 'Score', fieldtype: 'Float', precision: '2' },
    ],
    permissions: [],
  };
}

/** @param {{ module: string, supplierLink: boolean }} opts */
export function parentDoctype({ module, supplierLink }) {
  // Recommended != selected: say so on every record, where ERPNext users read it.
  const providerField = (fieldname, label) =>
    supplierLink
      ? { fieldname, label, fieldtype: 'Link', options: 'Supplier' }
      : { fieldname, label, fieldtype: 'Data' };

  return {
    doctype: 'DocType',
    name: PARENT,
    module,
    custom: 1,
    autoname: 'format:FC-{YYYY}-{#####}',
    track_changes: 1,
    title_field: 'rfq_reference',
    search_fields: 'rfq_reference,recommended_provider',
    fields: [
      { fieldname: 'freight_idempotency_key', label: 'Idempotency key', fieldtype: 'Data', unique: 1, read_only: 1, hidden: 1, reqd: 1 },
      { fieldname: 'rfq_reference', label: 'RFQ reference', fieldtype: 'Data', in_list_view: 1, in_standard_filter: 1, reqd: 1 },
      { fieldname: 'company', label: 'Company', fieldtype: 'Link', options: 'Company', in_standard_filter: 1, reqd: 1 },
      { fieldname: 'comparison_date', label: 'Comparison date', fieldtype: 'Date', in_list_view: 1 },
      { fieldname: 'col_route', fieldtype: 'Column Break' },
      { fieldname: 'route', label: 'Route', fieldtype: 'Data', in_list_view: 1 },
      { fieldname: 'origin_port', label: 'Origin port', fieldtype: 'Data' },
      { fieldname: 'destination_port', label: 'Destination port', fieldtype: 'Data' },
      { fieldname: 'incoterm', label: 'Incoterm', fieldtype: 'Data' },

      { fieldname: 'sec_outcome', label: 'Outcome', fieldtype: 'Section Break' },
      {
        fieldname: 'recommendation_status',
        label: 'Recommendation status',
        fieldtype: 'Select',
        options: 'Recommended, not selected',
        default: 'Recommended, not selected',
        read_only: 1,
        description: 'This record is a recommendation. The logistics team selects, negotiates and books.',
      },
      providerField('recommended_provider', 'Recommended provider'),
      { fieldname: 'recommended_total', label: 'Recommended total', fieldtype: 'Currency', options: 'base_currency' },
      { fieldname: 'recommended_transit_days', label: 'Recommended transit days', fieldtype: 'Int' },
      { fieldname: 'col_outcome', fieldtype: 'Column Break' },
      providerField('cheapest_provider', 'Cheapest provider'),
      { fieldname: 'cheapest_total', label: 'Cheapest total', fieldtype: 'Currency', options: 'base_currency' },
      { fieldname: 'base_currency', label: 'Base currency', fieldtype: 'Link', options: 'Currency' },
      { fieldname: 'offers_received', label: 'Offers received', fieldtype: 'Int' },
      { fieldname: 'offers_comparable', label: 'Offers comparable', fieldtype: 'Int' },

      { fieldname: 'sec_reasons', label: 'Reasoning', fieldtype: 'Section Break' },
      { fieldname: 'recommendation_reasons', label: 'Why it is recommended', fieldtype: 'Small Text' },
      { fieldname: 'recommendation_tradeoffs', label: 'Trade-offs', fieldtype: 'Small Text' },
      { fieldname: 'not_compared_notes', label: 'Offers not compared, and why', fieldtype: 'Small Text' },

      { fieldname: 'sec_offers', label: 'Offers', fieldtype: 'Section Break' },
      { fieldname: 'offers', label: 'Offers', fieldtype: 'Table', options: CHILD },

      { fieldname: 'sec_basis', label: 'Basis', fieldtype: 'Section Break', collapsible: 1 },
      { fieldname: 'ranking_criteria', label: 'Ranking criteria', fieldtype: 'Code', options: 'JSON', read_only: 1 },
      { fieldname: 'fx_rates_applied', label: 'Exchange rates applied', fieldtype: 'Code', options: 'JSON', read_only: 1 },
    ],
    permissions: perms(INTEGRATION_ROLE),
  };
}
