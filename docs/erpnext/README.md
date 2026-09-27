# Freight quotation DocTypes

**Generated — do not edit.** Regenerate with `node scripts/erpnext/emit-doctypes.mjs`.
The reasoning behind these fields is in `docs/FREIGHT_ERPNEXT.md`.

## How to create them

1. Create the child table **before** the parent: `Freight Quotation Charge`, then `Freight Quotation`.
2. Developer → DocType → Menu → Import, one JSON file each.
3. Confirm the unique index on `freight_idempotency_key` exists. Without it a retry after a
   timeout writes a second record instead of finding the first.
4. Create the role **Freight RFQ Integration** and give the integration user only that role.

## Two things to keep as they are

- **`amount` and `base_freight` stay optional with no default.** A provider naming a charge
  without pricing it is ordinary; a zero makes their offer look like the cheapest when it is not.
  Reports should read empty as unknown.
- **Each revision is its own record.** Filter to `quotation_status = 'confirmed'` and exclude
  rows named in another row's `supersedes_quotation`, or the same offer is counted twice.

### Freight Quotation Charge (child table)

| Field | Type | Flags | Notes |
| --- | --- | --- | --- |
| `charge_code` | Data | required |  |
| `charge_label` | Data | — |  |
| `amount_missing` | Check | read-only | Set when the provider named this charge without pricing it. The amount is then 0 only because Frappe cannot store an empty number - treat it as unknown, never as free. |
| `amount` | Float | — | Optional, no default. A charge named without a price is empty, never zero. |
| `currency` | Data | — |  |
| `basis` | Select → per_container / per_shipment / per_bl / per_cbm / per_tonne / unknown | — |  |
| `confidence` | Select → high / medium / low / missing | — |  |
| `source_reference` | Data | read-only |  |

### Freight Quotation

| Field | Type | Flags | Notes |
| --- | --- | --- | --- |
| `record_slug` | Data | unique, read-only | Readable name ending in part of the integration key, so two quotations cannot collide. |
| `freight_idempotency_key` | Data | required, unique, read-only | What a retry searches on. The unique index is what makes a retry safe. |
| `company` | Link → Company | required |  |
| `supplier` | Link → Supplier | — |  |
| `provider_name` | Data | required |  |
| `section_request` | Section Break | — |  |
| `rfq_reference` | Data | required |  |
| `route` | Data | — |  |
| `origin_port` | Data | — |  |
| `destination_port` | Data | — |  |
| `incoterm` | Data | — |  |
| `section_version` | Section Break | — |  |
| `quotation_version` | Int | required | 1, then 2 for a revision. A revision is a separate record. |
| `supersedes_quotation` | Data | read-only | Set on a revision. Exclude superseded rows when aggregating. |
| `quotation_status` | Data | read-only | Only confirmed quotations are ever written. |
| `received_at` | Date | — |  |
| `reviewed_at` | Date | — |  |
| `section_offer` | Section Break | — |  |
| `shipping_line` | Data | — |  |
| `currency` | Data | — |  |
| `container_basis` | Data | — |  |
| `base_freight` | Float | — | Optional, no default. Empty means the provider did not state it. |
| `total_quoted_by_provider` | Float | — | Optional. Only meaningful when the provider gave a total themselves. |
| `column_offer` | Column Break | — |  |
| `transit_days` | Int | — |  |
| `free_days_destination` | Int | — |  |
| `valid_until` | Date | — |  |
| `sailing_date` | Date | — |  |
| `payment_terms` | Small Text | — |  |
| `section_charges` | Section Break | — |  |
| `charges` | Table → Freight Quotation Charge | — |  |
| `section_terms` | Section Break | — |  |
| `inclusions` | Small Text | — |  |
| `exclusions` | Small Text | — |  |
| `conditions` | Small Text | — |  |
| `section_provenance` | Section Break | — |  |
| `source_kind` | Data | read-only | email_body, excel, pdf_text or manual. |
| `source_attachment` | Data | read-only |  |
| `extractor` | Data | read-only |  |
| `unstated_numbers` | Small Text | read-only | Comma separated field names that are 0 only because the provider never stated them. Treat each as unknown, not as zero. |
| `field_confidence` | Code → JSON | read-only | Per field: high, medium, low, missing, corrected_by_reviewer. |

