# Freight RFQ module — progress log

Branch: `feat/freight-rfq`. Built 2026-09-26.

## Context discovered

- This repository already contained "Mobility Pro Command": a Next.js 16 /
  React 19 client demonstration covering supplier-document control and
  aging-stock decisions, for the same client.
- Its architecture is deliberately **stateless**: the browser holds the demo
  document and posts it to `/api/action`, the single server-side rule boundary.
- Strong existing conventions, followed throughout: integration honesty (never
  claim "connected" without a successful probe), the accessible UI kit in
  `src/components/ui.tsx`, plain operational language, a document per
  integration.

## Decision record

1. **Extend this repository rather than start a new application.** Same product,
   same client, reusable shell, UI kit, adapter conventions and test setup.
2. **The freight module gets real server-side persistence** — SQLite through
   Node's built-in `node:sqlite`, so no native build and no extra service. The
   brief requires persistent storage, server-enforced company isolation, an
   audit trail and idempotent sync; a client-held document cannot honestly
   provide any of them. The existing demo module was left exactly as it was.
3. **New surface is namespaced**: `src/freight/**`, `/api/freight/*`,
   `/freight/*`. The operations demo shares only the CSS and the UI primitives.
4. **Adapters with a simulated default**: mail, mailbox, ERPNext and AI all sit
   behind an interface. Simulated output is labelled as simulated everywhere it
   appears and can never be read back as a live result.
5. **The demonstration dataset runs the real workflow** rather than inserting
   finished rows, so seeding fails if a rule breaks.
6. **Approval is bound to a content hash**, not to a flag, so an edit after
   approval provably revokes it.
7. **The live ERPNext adapter refuses to write** until a destination DocType has
   been agreed and verified. ERPNext has no native freight comparison document,
   and guessing one would be worse than waiting.

## Status — complete

- [x] Inspect the repository, preserve existing work
- [x] Data model and SQLite persistence
- [x] Companies and providers, with spreadsheet import and duplicate detection
- [x] Shipping requirements, RFQ references and recipient selection
- [x] Email preparation, approval binding and duplicate-send prevention
- [x] Reply collection, matching, extraction and human review
- [x] Comparison, ranking and recommendation
- [x] Excel comparison output and import templates
- [x] ERPNext recording: idempotent, retryable, honest about being simulated
- [x] The workspace UI
- [x] Tests: 36 unit, 9 browser, 54 end-to-end over HTTP
- [x] Documentation and handover

## Defects found by testing, and fixed

1. **Surcharge false positives.** An "Excludes: destination THC, customs
   clearance" line was read as two charges with no amount, which wrongly blocked
   offers from being compared. Lines that describe cover are now skipped for
   charge detection.
2. **Duplicate THC.** "Origin THC" matched both the origin rule and the generic
   rule, counting the charge twice. Patterns are most-specific-first and stop at
   the first match per line.
3. **Four-digit amounts misparsed.** `USD 1200.00` became `120`, because the
   regex's first alternative capped the integer part at three digits. The
   fixtures used comma separators, so it stayed hidden until a unit test used a
   plain number. This was the most serious of the three.
4. **Prepared emails were invisible.** They were created as drafts, so they
   never reached the manager's approval queue. They are now created awaiting
   approval.
5. **Nested shells.** The freight workspace rendered inside the operations
   shell, giving two navigations and two top bars. The operations shell now
   steps aside for `/freight`.
6. **Unreadable provenance.** The three-column source row collapsed to a sliver
   at half-page width, defeating the point of showing provenance. It is now two
   columns with the source spanning underneath, and a browser test asserts the
   rendered width.

## Known limits

- No authentication. The acting person is a demonstration control; see
  `FREIGHT_SETUP.md` for what is built and what replacing it involves.
- No scheduled inbound mail collection. Matching, extraction and review are
  complete and exercised; only the trigger is missing.
- Microsoft Graph, live ERPNext and the AI fallback are written but have **not**
  been verified against live services from this environment.
