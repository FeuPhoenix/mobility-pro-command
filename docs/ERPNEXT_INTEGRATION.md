# ERPNext integration outline

**Status: not implemented.** The application ships with one adapter — `DemoAdapter` —
which reads the local fictional dataset and makes no network request. The UI is required
to display **"ERPNext demo adapter"** and must never display "Connected to ERPNext"
unless a probe against a configured instance has actually succeeded.

This document records the proposed mapping, the sequencing, and — most importantly — the
questions that have to be answered against the live site **before** any of it is built.

---

## 1. The boundary

`src/lib/erpnext/adapter.ts` defines `ErpNextAdapter`. Application logic never references
ERPNext directly; it depends on this interface only. That gives three things:

- The demo runs with zero ERPNext access.
- A live adapter can be added without touching domain logic.
- Failure modes (permission denied, stale record, retry, duplicate submission) are
  modelled at one place rather than scattered through the UI.

Credentials stay server-side. No ERPNext token is ever sent to the browser.

---

## 2. Proposed record mapping

| This application | ERPNext doctype | Key | Notes and risks |
| --- | --- | --- | --- |
| `Customer` | `Customer` | `name` | Credit limit lives on the `Customer Credit Limit` child table and is **per company**. Confirm which company. |
| `Sku` | `Item` | `item_code` | **Risk:** size, ply and pattern are core to this product but are not standard Item fields. They are likely custom fields, Item Attributes (if variants are used), or embedded in `item_name`. Must be confirmed. |
| `Warehouse` | `Warehouse` | `name` | Tree doctype; only leaf warehouses hold stock. |
| `StockLot` | `Bin` + `Stock Ledger Entry` / `Batch` | `name` | **Risk:** lot *age* is central to Journey B. If batch tracking is not enabled, age must be derived from `Stock Ledger Entry` under FIFO, which is materially harder and slower. |
| `Reservation` | `Stock Reservation Entry` | `name` | **Risk:** only available from ERPNext v15 and only when stock reservation is enabled. On earlier versions reservations must live outside ERPNext, which changes what "available" means. |
| `PurchaseOrder` | `Purchase Order` + `Purchase Order Item` | `name` | Maps cleanly. Ordered spec fields inherit the `Item` risk above. |
| `SupplierDocument` (PI, packing list) | none | — | **Gap:** ERPNext has no pro-forma-invoice doctype. Options: a custom doctype, or `File` attachments on the Purchase Order with extracted fields held in this application. Recommend a custom doctype so the case links to something durable. |
| `Shipment` | `Shipment`, or custom | `name` | **Risk:** pre-receipt tracking (vessel, BL, ETA, containers) is usually custom. `Purchase Receipt` only exists *after* receiving, which is too late for the readiness gate. |
| `SalesOrder` | `Sales Order` + `Sales Order Item` | `name` | Fulfilment plan and credit decision are custom fields in this design. |
| `SalesInvoice` | `Sales Invoice` | `name` | `outstanding_amount` and `due_date` map directly. |
| `CustomerPayment` | `Payment Entry` + `Payment Entry Reference` | `name` | Allocation to invoices comes from the reference child table. |
| `PriceListVersion` | `Price List` + `Item Price` | `price_list` | **Gap:** ERPNext has no price-list *versioning*. `Item Price.valid_from` / `valid_upto` is the closest fit, but "which version was this quote priced on" needs a custom field on the Sales Order. |
| `DiscrepancyCase`, `ApprovalRequest`, `ActivityEvent` | none | — | These are this application's own records. They reference ERPNext documents; they do not live in ERPNext. |

---

## 3. Sequencing

**Phase 0 — discovery (before any code).** Answer section 5 below against the live site.

**Phase 1 — read-only.** A `ReadOnlyAdapter` using the REST API with a dedicated ERPNext
user whose role profile grants read on exactly the listed doctypes and nothing else.
Verified by a `probe()` that reads the version and one record of each doctype. Only after
a successful probe may the UI change its label from "demo adapter" to a connected state,
and it should name the instance and the probe time.

**Phase 2 — reconciliation.** Run the rule engine against real data and compare its output
with what the team already knows. This is where the fictional rules get replaced with the
client's real thresholds. Expect this phase to take longer than building the adapter.

**Phase 3 — writes, if and only if separately authorised.** Writes require explicit
configuration (`ERPNEXT_MODE=write`), a named ERPNext user with a scoped role, and a
documented list of exactly which doctypes may be written. Every write is idempotent on an
application-generated key so a retry cannot create a duplicate submission.

---

## 4. Failure modes the adapter must model

| Failure | Handling |
| --- | --- |
| Permission denied | Surface the doctype and the permission, do not silently show empty data. An empty list and a refused read must look different. |
| Stale record | Every read carries `modified`. A write sends it back; a mismatch is a conflict, and the user is shown what changed. |
| Duplicate submission | Application-generated idempotency key on every write; a repeat returns the original result. |
| Transient network / 5xx | Bounded retry with backoff on reads only. Never blind-retry a write. |
| Partial sync | The UI states the freshness of every synced figure. A figure with unknown freshness is not shown. |
| Version mismatch | `probe()` records the Frappe/ERPNext version; the adapter refuses to run against an unverified major version. |

---

## 5. Open discovery questions

These must be answered against the client's actual instance. Several of them can change
the design, not just the implementation.

**Environment**
1. What exact ERPNext and Frappe versions are installed? Self-hosted or Frappe Cloud?
2. Is there a non-production instance we can develop against?
3. How many companies are configured, and which one governs credit limits?

**Item and stock**
4. How are size, ply and pattern actually stored on `Item`? Custom fields, attributes, or
   only inside the item name?
5. Is batch or serial tracking enabled for tyres? If not, how is stock age determined
   today?
6. Which valuation method is in use (FIFO / moving average)? "Weighted landed cost" in
   this demo assumes a per-lot landed cost exists.
7. Are freight, duty and clearing costs landed onto item cost (Landed Cost Voucher), or
   held separately? This determines whether the margins shown here are real margins.
8. Is stock reservation enabled? If not, what does the business currently treat as
   "available to promise"?

**Procurement and documents**
9. Is there any existing doctype or attachment convention for pro forma invoices and
   packing lists?
10. How is a shipment tracked between PO and Purchase Receipt today — spreadsheet, custom
    doctype, or freight forwarder portal?
11. What are the real tolerances for quantity and price variance, and who sets them?
12. Who today is authorised to accept a supplier discrepancy without correction?

**Credit and pricing**
13. Where is the real credit limit maintained, and who can change it?
14. What is the actual overdue threshold that withholds release, and is it uniform across
    customer segments?
15. Does the business use deposits or partial releases in practice, and how are they
    recorded?
16. How are price list versions managed and communicated today? Is `Item Price.valid_from`
    actually populated?
17. What is the real discount approval matrix, and is it enforced anywhere today?

**Process and people**
18. Which of these decisions are currently made in ERPNext, and which happen in email,
    WhatsApp or spreadsheets? (The value of this layer is mostly in the second group.)
19. Who should receive supplier clarifications, and from which mailbox?
20. What audit or retention requirements apply to approval decisions?

---

## 6. What this demo deliberately does not claim

- It has never connected to an ERPNext instance.
- It has not parsed a real supplier document.
- The rules in it are fictional and were written to make the demo coherent.
- The figures are a fictional dataset and do not describe the client's business.
