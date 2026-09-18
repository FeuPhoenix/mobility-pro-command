# Validation report

What was actually tested, by what means, and what was not tested. Everything below was
run on this build; nothing is asserted from inspection alone.

Environment: Windows 11, Node v24.18.0, Next.js 16.3.5, React 19.1.1. Browser tests run
against the installed Google Chrome on a production build.

---

## 1. Summary

| Check | Result |
| --- | --- |
| TypeScript, strict mode, whole project | **Clean** — `npx tsc --noEmit`, no errors |
| Production build | **Compiled successfully** — `npm run build` |
| Business-logic tests (Vitest) | **54 / 54 passing** across 4 files |
| Browser journey tests (Playwright) | **10 / 10 passing** |
| Manual browser inspection | Performed on Overview, Document control (list + detail + revision), Inventory (list + opportunity), Orders (list + detail), Customers (list + detail), Approvals, Assistant |

---

## 2. Business-logic tests — 54 passing

### `tests/money.test.ts` (5)
- EGP is the demo currency and formats as `EGP 1,234,567` / `EGP 1,234.50`.
- Half-up rounding at the cent boundary; `round2(0.1 + 0.2) === 0.3` (no float drift).
- USD→EGP at the fixed 48.50 rate: `usdToEgp(10,720) === 519,920`.
- Day counts verified against the pinned clock: 14 Feb → 17 Sep 2026 = **215 days**;
  27 Jul → 17 Sep = **52 days**; 31 Aug → 17 Sep = **17 days**.
- Date addition across month boundaries: `17 Sep + 90 = 16 Dec`, `+12 = 28 Dec`.

### `tests/documentRules.test.ts` (13)
- The seeded pro forma invoice raises **exactly 4 blocking and 1 advisory** difference,
  on exactly the expected field keys.
- A wording-only pattern difference (`Hauler SD-7 (HD)`) is advisory under PR-1.2, not
  blocking.
- Variance is priced in EGP: 40 pcs short at USD 268 = **EGP 519,920**; 320 pcs
  overcharged by USD 4.50 = **EGP 69,840**.
- The 2% quantity tolerance holds: 634 against 640 ordered (0.94%) is advisory, not
  blocking.
- The 0.5% price tolerance holds: USD 285.50 against 284.50 (0.35%) is advisory.
- The clean supplier document raises **zero** differences.
- The packing list agrees with the order, isolating the fault to the invoice.
- Document totals reconcile: ordered 1,140 pcs / USD 320,340; document 1,100 pcs /
  USD 311,060; variance **−USD 9,280**.
- Readiness is `Held - document control` with 4 blocking while the case is open.
- A shipment still at sea reports `Not yet arrived`, **not** blocked.
- After the full correction cycle readiness becomes `Ready for receiving`, the advisory
  survives, the case is `Resolved`, **the shipment status remains `Arrived`**, and the
  readiness reasons still state that goods have not been counted.
- An override releases readiness while the blocking differences **remain unresolved on
  record**.
- The generated revision corrects ply, quantity, price and payment terms, leaves the
  wording-only difference untouched, and re-validates to zero blocking.

### `tests/scenarios.test.ts` (12)
- Deal arithmetic at 420 pcs and 8%: unit **EGP 4,241.20**, revenue **EGP 1,781,304**,
  cost of goods **EGP 1,486,800**, gross profit **EGP 294,504**, margin **16.53%**.
- 5% / 8% / 10% move monotonically; cost of goods is unaffected by a price decision.
- Output scales linearly with quantity and margin percentage is invariant to it.
- Below-cost detection: 10% is above cost, 30% is below.
- Collection date derives from terms plus the assumed delay (16 Dec → 28 Dec).
- Carrying cost is annual-rate pro-rated: 412 pcs × EGP 3,540 × 18% × 3/12 =
  **EGP 65,631.60**; over 12 months it is exactly 4×.
- Hold produces no revenue and a negative contribution.
- Transfer costs 240 × EGP 185 and produces no revenue; the caution text says so.
- A discount commits the proposed quantity and reduces remaining stock correctly.
- The engine never commits more than the lot holds (5,000 requested on 812 → 812).
- **Changing the uplift assumption changes the assumed rate (56 → 156 pcs/month) but
  leaves revenue and gross profit identical.** This is the central separation claim.
- A below-cost discount surfaces the PP-3.1 caution first.

### `tests/workflow.test.ts` (24)

*Credit* — exposure equals receivables plus approved undelivered orders; Nile Fleet's
position (EGP 13,223,000 open, EGP 7,110,000 overdue, worst 52 days) is exact; a draft
order does **not** change exposure; the block is `blocked_overdue` **while stock passes
and the limit still has headroom**; three options are offered, all requiring approval,
with the deposit computed at 30% of order value; a different customer blocks for a
different, correctly-identified reason (`blocked_limit`).

*Order guards* — over-available quantity, fractional quantity, below-cost pricing and a
second order from the same opportunity are each refused with the right message and HTTP
status.

*Approvals* — direct release refused while held; a second pending request refused (409);
a decision from an unauthorised role refused (403); editing the order after a request
marks the approval `Stale - inputs changed` and a decision on it is then refused (CR-5.4);
approval creates exactly one reservation, leaves physical stock at 812, sets reserved to
420 and available to 392, increases exposure by the order value, **leaves receivables
unchanged**, and marks the opportunity `Actioned`; a second decision on the same request
is refused; a duplicate release is refused and available stock never goes negative; a
rejection reserves nothing and leaves availability at 812; an approved order cannot be
edited.

*Pricing* — release on a superseded price list is refused; re-pricing moves the order onto
the active list and updates the line price; re-pricing twice is refused.

*Exceptions* — the queue ranks critical first, contains all four seeded kinds, and every
entry carries exactly one typed measure with a note; the aging measure reconciles exactly
to the underlying lot (812 × EGP 3,540 = **EGP 2,874,480**); the document exception
disappears once the case resolves.

*Reset* — two freshly seeded states are byte-identical apart from session id and
timestamp; the seed contains no cases, approvals or discrepancies before validation runs.

---

## 3. Browser journey tests — 10 passing

| # | Test | What it proves |
| --- | --- | --- |
| 1 | Opening experience | Populated workspace, "Demo data" chip, "ERPNext demo adapter / Not connected", all four exception kinds present, critical ranked first, measures listed separately |
| 2 | Persistence and reset | A case created in the UI survives a full page reload; **Reset demo** returns the scenario to its original state |
| 3 | Journey A, full cycle | Readiness held → source document renders with flagged lines → cross-document check → **editing an extracted field moves the blocking count 4 → 3 → 4** → case created → draft generated containing the PO reference and the disputed value → edited → recorded as sent with the "nothing leaves this application" notice → revision received → re-validated → **Ready for receiving** with 1 advisory retained and the case `Resolved` |
| 4 | Override authorisation | The override is disabled for the wrong role with an explanation; disabled again for a too-short reason under the right role; succeeds with a valid reason and releases readiness |
| 5 | Clean comparison | The second supplier document reports 0 blocking and says it matches |
| 6 | Journey B, full cycle | Evidence and limitations both present → **EGP 4,241.20 / 1,781,304 / 294,504 at 8%** → 10% recalculates to EGP 4,149.00 → **changing the uplift assumption leaves the arithmetic unchanged** → customer suggestions with history → order prepared → **blocked on a 52-day overdue invoice while the stock check passes** → three options shown → approval requested → **Approve disabled for the wrong role** → approved as Finance Director → available stock now 392 → **receivables unchanged at EGP 13,223,000** |
| 7 | Stale price list | Release blocked, re-price clears the warning |
| 8 | Assistant | Labelled "Simulated", shows the record context, answers in facts / calculations / assumptions bands, links records, offers an action preview |
| 9 | Assistant honesty | An out-of-scope question returns a limitation band, not invented data |
| 10 | Responsive | At 390 × 844 there is **no horizontal overflow** and the rail collapses behind a working menu button |

---

## 4. Manual checks performed in a browser

- **Arithmetic reconciliation.** Every headline figure was traced to its records:
  carrying value 812 × EGP 3,540 = EGP 2,874,480; per-warehouse values 96 × 3,595 and
  41 × 3,595; Nile Fleet headroom 18,500,000 − 13,223,000 = EGP 5,277,000; the stale
  price-list gross-profit difference 120 × 187.20 + 60 × 225.225 = EGP 35,977.50.
- **Figure consistency.** An early inconsistency was found and fixed: the aging narrative
  quoted 41 pcs/month while the computed trailing-three-month rate was 56. All views now
  quote the same trailing-three-month figure.
- **Server-side enforcement via the API**, bypassing the UI entirely: invalid numeric
  edits, duplicate case creation, duplicate "record as sent", duplicate revision receipt,
  unauthorised override, unauthorised decision, duplicate approval request, decision on a
  stale approval, and editing an approved order were each refused with the correct status
  and message.
- **Visual inspection** at 1440px of every screen listed in section 1, checking for
  clipping, weak contrast, wrapped action buttons and confusing labels.

### Defects found and fixed during validation

| Defect | Fix |
| --- | --- |
| Demo state was persisted to the server filesystem, which a serverless host cannot do — state would have reset unpredictably once deployed | State moved to the browser (`localStorage`); the server is now stateless and still computes every transition |
| The case panel disappeared when a revision superseded the original document | Case lookup now follows the document chain (original ↔ revision) |
| Two buttons both labelled "Re-run validation" did different things | Renamed to "Re-check this document" and "Re-run validation and close the case" |
| The override modal let the user write a reason before revealing they lacked authority | The modal now states the required role up front and disables submission |
| `Field` labels were not associated with their controls | `Field` now generates an id and injects it into the control |
| An already-received shipment displayed "Ready for receiving" | Added a `Goods received` readiness state |
| "Order value" appeared twice on an approval; the collection date rendered as raw ISO | Impact rows de-duplicated; date formatted |
| Proposed quantity could exceed available stock in the input | Clamped to availability |
| Document facsimile column too narrow; action buttons wrapped | Dedicated wider grid for the document page; buttons kept on one line |
| Aging narrative quoted 41 pcs/month against a computed 56 | Seed and UI aligned on the trailing-three-month figure |

---

## 5. What was **not** tested

- **No ERPNext instance was contacted.** The live adapter does not exist, so nothing about
  ERPNext connectivity, permissions, field mapping or write behaviour has been verified.
  The mappings in `docs/ERPNEXT_INTEGRATION.md` are proposals, not tested facts.
- **No document extraction was tested**, because none is performed. The sample documents
  ship with pre-extracted fields.
- **No AI model was called.** The assistant is deterministic; its intent matching is
  keyword-based and will not understand arbitrary phrasing. Unmatched questions fall
  through to an explicit limitation.
- **No email or message was sent.** The "record as sent" action writes to the case only.
- **Cross-browser testing**: Chrome only. Firefox and Safari were not tested.
- **Screen-reader testing** was not performed. Semantic HTML, labelled controls, visible
  focus, `aria-live` on toasts and assistant answers, and reduced-motion support are all
  implemented, but no assistive technology was used to verify the experience.
- **Load and concurrency**: session isolation is now structural (each browser holds its own
  document), so there is no shared server state to contend for. No concurrent-load test was
  run against the deployed instance.
- **The deployed instance**: the full suite was run against a local production build. At the
  time of writing the hosted URL had not yet been created, so nothing in this report
  describes a deployed environment.
- **Picking, dispatch, invoicing and payment posting** are not modelled and therefore not
  tested.

---

## 6. Reproducing this report

```bash
npm install
npx tsc --noEmit     # expect: no output
npm test             # expect: 54 passed
npm run build        # expect: Compiled successfully
npm run test:e2e     # expect: 10 passed
```
