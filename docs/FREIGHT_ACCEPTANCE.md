# Freight RFQ — acceptance and sign-off

The record that closes the handover. Part 1 is already true and proven by
tests. Part 2 is filled in as each live check is run. Part 3 is signed when
both are complete.

---

## Part 1 — The guarantees, and the tests that prove them

These are the invariants in `docs/HANDOFF.md` section 2. Each is enforced on
the server, not only in the screens, and each has tests that fail if it breaks.
Run `npm test` to see them pass.

| # | Guarantee | Proven by |
| --- | --- | --- |
| 1 | Nothing sends without an explicit approval, and the approval is bound to the reviewed content; any edit revokes it | `freight.test.ts`: *binds the approval to the reviewed content*, *refuses an unapproved send…*, *invalidates the approval when the content changes afterwards*; browser: *an email cannot be sent without approval, and editing revokes it* |
| 2 | One email per provider; no provider sees another's identity, contacts or quote | `freight.test.ts`: *addresses one provider per email so none sees another*, *does not prepare a second email for the same provider* |
| 3 | A missing charge is never zero | `freight.test.ts`: *returns null rather than zero when a charge has no amount*, *refuses to treat a missing surcharge as zero* |
| 4 | Never rank incompatible things | `freight.test.ts`: *will not rank a different currency without a recorded rate*, *…a different container basis…*, *never recommends anything when nothing is comparable* |
| 5 | Simulated output is never presented as live | `freight.test.ts` ERPNext retry tests; browser: *a failed ERPNext record can be retried and is never called live*; `mailbox.test.ts` connection checks |
| 6 | Recommended is not selected | `freight.test.ts`: *separates the cheapest offer from the recommended one*; every ERPNext record carries *Recommended, not selected* |
| 7 | Automation can prepare, never send | `automation.test.ts`: *is refused by the approval guard*, *…by the send guard*, *cannot send an email even when a person has already approved it*; `mailbox.test.ts`: the Mailbox Collector may not edit or approve; `automation-settings.test.ts`: the deadline identity has no other powers |
| 8 | No anonymous access in the real sign-in modes | `auth.test.ts`, `auth-password.test.ts` (sessions, revocation, expiry, a coordinator still cannot approve); journey script in the signed-in modes |
| 9 | Only checked quotations reach ERPNext, one record per version | `erpnext-quotation-sync.test.ts`: *refuses one nobody has checked…*, *does not send a quotation that has already been recorded*, *will not send a superseded version…* |
| — | Company isolation | `freight.test.ts`: *refuses a provider belonging to another company*, *refuses a direct read of another company's request*; browser: *company boundaries hold…* |
| — | A reply is filed once, with its quotation, or not at all | `mailbox.test.ts`: *creates no duplicates…*; `ingest-atomic.test.ts` |

Suite totals at handover (29 September 2026): 394 unit tests
(9 more skip without a live ERPNext), 26 browser tests (4 skip), 65 journey
checks. `npm audit`: 0 vulnerabilities.

**Signed off by** (name, role, date): ______________________________

---

## Part 2 — Live checks (fill in as each is run)

Nothing below has run against the customer's real systems yet. Each row
links to the step-by-step instructions.

| # | Check | How | Date | Result | By |
| --- | --- | --- | --- | --- | --- |
| L1 | Extraction on the customer's real `.eml` quotations; a parser test added for each new format | `docs/HANDOFF.md` §5A | | | |
| L2 | Microsoft 365: send, reply matched by thread, no duplicate on re-collect, unknown sender to review, scheduled collection | `docs/FREIGHT_W2_LIVE_TEST.md` (its results table) | | | |
| L3 | ERPNext against the customer's test site: `tests/erpnext-instance.test.ts`, then *Record quotations* twice from the app — one record per version, no duplicates | `docs/FREIGHT_ERPNEXT.md` | | | |
| L4 | Real sign-in: each person signs in; coordinator cannot approve; unknown person refused; switching access off locks out | `docs/FREIGHT_GO_LIVE.md` D | | | |
| L5 | Teams: a notification arrives in the channel | `docs/HANDOFF.md` §5D | | | |
| L6 | Production: `/api/freight/health` answers `{"ok":true}` through HTTPS; data survives a restart | `docs/FREIGHT_GO_LIVE.md` F | | | |
| L7 | A backup restored and checked: `npm run restore -- --from=<backup> --check` | `docs/FREIGHT_GO_LIVE.md` F | | | |
| L8 | **Settings → Go-live readiness** shows *Ready* on the production workspace | Settings, as a manager | | | |
| L9 | The logistics team walked through the workflow | `docs/FREIGHT_USER_GUIDE.md` | | | |

---

## Part 3 — Handover

| | Name | Date | Signature |
| --- | --- | --- | --- |
| Handed over by | | | |
| Accepted for Mobility Pro by | | | |
| Owner of day-to-day operation (see `docs/FREIGHT_OWNERSHIP.md`) | | | |
