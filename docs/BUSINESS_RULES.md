# Business rules and demo assumptions

Every rule below is **fictional**, written to make the demonstration coherent. Each one is
visible inside the application with the identifier shown here. Replacing them with the
client's real policies is the first substantive piece of work after the demo.

---

## 1. Global demo assumptions

| Assumption | Value | Where |
| --- | --- | --- |
| Business | Tyre importer / distributor operating in Egypt | `seed.ts` |
| Currency | EGP throughout | `money.ts` |
| Supplier document currency | USD at a fixed **48.50 EGP/USD**, recorded on the document | `money.ts`, each `PurchaseOrder.fxRate` |
| "Today" | **17 Sep 2026**, pinned | `seed.DEMO_TODAY` |
| Warehouses | 6th of October (Giza), Obour City (Qalyubia), Alexandria Free Zone | `seed.ts` |
| Catalogue | 17 SKUs across PCR, SUV/LT, TBR, OTR | `seed.ts` |
| Customers | 11 accounts across retail chain, fleet, wholesale, export, government | `seed.ts` |
| Inventory carrying cost | **18% per year** of landed cost | `scenarios.CARRYING_COST_ANNUAL_PCT` |
| Inter-warehouse transfer handling | **EGP 185 per piece** | `scenarios.TRANSFER_COST_PER_UNIT` |

Why a tyre catalogue: the client's briefing workbook repeatedly references *size*, *ply*
and *pattern*. That is an assumption about the product line, not a verified description of
the client's full business.

---

## 2. Import document control SOP — POL-PROC v1.9

Applied by `documentRules.validateDocument`.

| Clause | Rule | Severity |
| --- | --- | --- |
| **PR-1.2** | Every supplier pro forma invoice is checked against the purchase order for size, ply, pattern, quantity, unit price, incoterm and payment terms before any payment instruction is raised. A descriptive field differing in wording only is recorded as advisory. | Advisory |
| **PR-2.1** | A mismatch in size, ply rating or pattern is blocking. | **Blocking** |
| **PR-2.2** | A quantity variance above **2%** of ordered quantity is blocking. Below it, advisory. | **Blocking** |
| **PR-2.3** | A unit price variance above **0.5%** of ordered price is blocking. Below it, advisory. | **Blocking** |
| **PR-2.4** | A change in payment terms is blocking and must be confirmed by Finance. | **Blocking** |
| **PR-3.1** | Resolving a document case does **not** mean goods arrived, were counted, or that payment is approved. | — |

### Pattern matching

`"Hauler SD-7 (HD)"` against an ordered `"Hauler SD-7"` is treated as the **same product
described differently** — advisory, not blocking. A genuinely different pattern name is
blocking. The comparison strips a trailing parenthetical suffix and normalises whitespace
and case.

### Receiving readiness (derived, never stored)

| State | Condition |
| --- | --- |
| `Goods received` | The shipment has already been received into stock. |
| `Not yet arrived` | The shipment is still in transit. |
| `Held - document control` | At least one unresolved **blocking** mismatch on a document for this shipment, and no override. |
| `Ready for receiving` | No unresolved blocking mismatch, **or** an authorised override exists. Advisory differences never block. |

An override does not correct anything. The mismatches remain on record and readiness is
released on the authority of the override.

---

## 3. Credit and release policy — POL-CREDIT v3.1

Applied by `credit.checkCredit`. Configurable in `credit.CREDIT_RULES`.

| Clause | Rule |
| --- | --- |
| **CR-2.1** | **Credit exposure = open receivables (invoiced, unpaid) + value of approved but undelivered sales orders.** Draft orders are not exposure. |
| **CR-3.0** | An order releases automatically when all three hold: the customer is not on hold; exposure after the order is within the credit limit; and **no invoice is more than 30 days past due**. |
| **CR-4.2** | Where an invoice is more than 30 days past due, automatic release is withheld. The Finance Director may approve release against: **(a)** an advance deposit of at least **30%** of order value, **(b)** a partial release limited to the uncovered portion of the limit, or **(c)** a documented finance review with a dated collection commitment. |
| **CR-5.4** | An approval **lapses** if any material input changes after it was requested: order quantity, unit price, customer credit limit, or overdue balance. |

### Demo policy assumptions attached to the options

- A deposit reduces uncovered exposure but does **not** settle the existing overdue balance.
- A partial release is proportional across order lines and rounded **down** to whole pieces.
- A collection commitment is recorded as a note, **not** as cash received.

### Staleness

`credit.approvalInputHash` hashes order id, every line (`sku:qty:price:warehouse`), the
customer credit limit and the overdue balance. It is checked both when the order is edited
and again at the moment of decision, so an approval cannot be applied to inputs it was not
granted against.

---

## 4. Commercial approval matrix — POL-APPROVAL v2.4

| Clause | Rule |
| --- | --- |
| **AM-1.1** | Discount up to 5% of list: Key Accounts Manager (no approval request needed). |
| **AM-1.2** | Discount above 5% and up to 10%: Commercial Director. |
| **AM-1.3** | Discount above 10%: Commercial Director **and** Finance Director jointly. |
| **AM-2.1** | Credit release outside policy: Finance Director. |
| **AM-3.1** | Supplier document override: Procurement Manager, with a written reason (minimum 15 characters) retained on the case. |

Authorisation is enforced in `server/actions.ts`, server-side. Disabling a button in the
UI is a courtesy; the refusal is real.

---

## 5. Trade pricing policy — POL-PRICE v2.0

| Clause | Rule |
| --- | --- |
| **PP-1.1** | Quotations must use the price list version active on the quotation date. A superseded version requires re-pricing before confirmation, and release is refused until then. |
| **PP-2.3** | Stock held beyond 180 days is eligible for a managed discount programme, subject to the approval matrix. |
| **PP-3.1** | No sale may be confirmed below weighted landed cost without Finance Director approval. Order creation and revision both refuse it. |

Price lists in the demo: `PL-2026-Q2` (effective 01 Apr, superseded 01 Aug, 95.5% of the
current list) and `PL-2026-Q3` (effective 01 Aug, **active**).

---

## 6. Inventory rules

| Rule | Trigger |
| --- | --- |
| **INV-AGE-180** | A lot held beyond 180 days with a falling shipped rate is raised as an opportunity. |
| **INV-IMB-01** | One location below 20 pcs available while another holds 400 or more. |

---

## 7. Scenario modelling — what is arithmetic and what is assumed

`scenarios.ts` enforces this split, and the UI renders the two in different colours.

### Deterministic (given quantity and discount, this is not open to debate)

```
unit price       = list price x (1 - discount%)
revenue          = unit price x quantity
cost of goods    = weighted landed cost x quantity
gross profit     = revenue - cost of goods
gross margin %   = gross profit / revenue
remaining stock  = lot quantity - quantity committed
due date         = today + customer payment terms
transfer cost    = units moved x EGP 185
carrying cost    = units x landed cost x 18% x (months / 12)
```

### Assumption-led (editable, labelled, never presented as a forecast)

```
assumed rate       = baseline units/month + (units per discount point x discount%)
assumed volume     = assumed rate x horizon months
months to clear    = remaining stock / assumed rate
carrying avoided   = carrying cost of holding - carrying cost after the action
collection date    = due date + assumed collection delay
```

`baselineUnitsPerMonth` is **observed** (trailing three months of shipped sales) and is
not editable. `unitsPerDiscountPoint`, `horizonMonths` and `collectionDelayDays` are
assumptions and are editable on the opportunity.

**Changing an assumption must never change a deterministic figure.** This is asserted by
a test (`tests/scenarios.test.ts`).

---

## 8. Measure definitions — deliberately never blended

| Measure | Definition | What it is not |
| --- | --- | --- |
| **Inventory carrying value** | Landed cost of physical stock on hand | Not sales value, not profit |
| **Potential sales value** | Quantity x active list price, where no order exists | Not revenue, not committed |
| **Gross profit** | Revenue minus cost of goods on a specific proposal | Not cash, not recognised |
| **Receivables at risk** | Invoiced, unpaid, past due | Not revenue for the period |
| **Purchase value exposed** | Ordered value of affected purchase order lines | Not a loss, not a payment |

The daily briefing lists them separately with a note on each. Nothing in the application
sums across this table.

---

## 9. What approval does and does not do

Approving a credit release:

- **does** create reservations, reduce available stock, move the order to
  `Approved - reserved`, increase credit exposure, and write the activity trail;
- **does not** recognise revenue, collect cash, settle the overdue balance, create an
  invoice, or dispatch anything.

This is asserted by `tests/workflow.test.ts`.
