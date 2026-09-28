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
- Microsoft Graph (sending and collection), live ERPNext and the AI fallback are
  written but have **not** been verified against live services from this
  environment. Graph collection is tested against a faked Graph only.
- `ingestMessage()` is not atomic: if quote extraction throws after the message
  row is written, a later run sees the message as already collected and no
  quote is created. Rare, but worth closing before live use.

## 2026-09-27 — W1: scheduled reply collection

Branch: `feat/freight-mailbox`. Requires Node 22.5+ (`node:sqlite`).

- [x] Baseline verified on a clean checkout: 118 unit, 9 browser, 54 journey
- [x] Mailbox Collector system identity (`src/freight/system.ts`): not a user
      row, cannot be acted as, cannot edit, approve or send; sees every company
- [x] `adapters/mailbox.ts`: `SimulatedMailbox` and `GraphMailbox` (Inbox
      delta query, read-only), `resolveMailbox()` on `MAILBOX_ADAPTER`
- [x] `service/collect.ts`: feeds the existing `ingestMessage()`; cursor moves
      only after a whole page is filed; database lease against overlap; a
      failing message is retried twice then set aside with an audit entry
- [x] Triggers: `MAILBOX_POLL_SECONDS` timer (`src/instrumentation.ts`),
      `POST /api/freight/collect` with `MAILBOX_COLLECT_TOKEN`, "Collect now"
- [x] Settings → Connections: incoming email row, reply-collection status,
      *Check connection* for outgoing and incoming email
- [x] `.env.example` committed (it was excluded by `.env*` before)
- [x] Tests: 19 unit (`tests/mailbox.test.ts`), 7 journey checks. Totals now
      137 unit, 21 browser, 61 journey

Defects found while doing it:

7. **The Graph probe was never called.** Adapters are rebuilt per request and
   nothing invoked `probe()`, so Settings could never say "connected" — W2's
   done-condition was unreachable. Checks are now an action and the result is
   stored against the configuration it was made for.
8. **The send probe needed a permission the guide does not grant.**
   `GET /users/{id}` requires `User.Read.All`; the guide grants `Mail.Send` and
   `Mail.ReadWrite`. The probe now reads Sent Items, which `Mail.ReadWrite`
   covers.

## 2026-09-27 — W2: live email readiness (code side)

Branch: `dev`. The live test itself needs a tenant; it is written up as a
checklist in `docs/FREIGHT_W2_LIVE_TEST.md`.

- [x] Graph sending creates a draft, then sends it, and stores the real
      Message-ID as the transport id
- [x] Reserved addresses and attachments over 3 MB refused before Graph is
      called; a refused send deletes its draft; a dropped connection mid-send
      says to check Sent Items rather than inviting a retry
- [x] The matcher tries both the conversation id and In-Reply-To
- [x] "Freight RFQ" link in the operations navigation
- [x] Tests: 9 unit (`tests/graph-mail.test.ts`), including a full round trip:
      send through Graph, reply with no reference, matched by thread. Totals
      146 unit

Defect found while doing it:

9. **In-Reply-To was never consulted.** The matcher used
   `threadId ?? inReplyTo`, and Graph supplies a conversation id on every
   message, so a reply's In-Reply-To was ignored even had a real Message-ID
   been stored. Both are now tried. Undoing the fix fails two tests.

## 2026-09-27 — Atomic filing, W3, W4, W5 (code side)

Branch: `dev`.

- [x] A reply and its quotation are filed in one transaction; a failed read
      leaves nothing behind (2 tests fail on the old code)
- [x] W3: the live ERPNext adapter checks the destination DocType before every
      write (all fields, `offers` table, Unique key); a failed duplicate check
      stops the write; a racing insert is recovered; the workbook is attached
      once; `ERPNEXT_COMPANY_MAP`; Check connection; a script to create the
      proposed DocType, checked against the payload by a test
- [x] W4: `AUTH_MODE=entra` Sign in with Microsoft (OIDC + PKCE, full ID token
      verification), People screen, account binding on first sign-in,
      bootstrap administrator, fail-closed configuration
- [x] W5: `RFQ_EMAIL_INTAKE=on` turns a colleague's "New RFQ" email (labelled
      lines or the Excel template) into draft RFQs; unreadable requests are
      listed with reasons on Replies
- [x] Tests: 210 unit, 21 browser, 61 journey

Defects found while doing it:

10. **Creating a company gave access only in memory.** The creator lost sight
    of the new company on the next request. Now saved.
11. **Thousands separators split container weights.** "6 x 40HC, tyres,
    21,500 kg" read the weight as 500, because the line is split on commas.
    Found by a parser test written before the code was trusted, exactly as the
    handover advised; separators are now removed first.

## 2026-09-28 — Import, optional automation, dependencies (merged onto main)

Branch: `dev`, merged with `main` (which by then had password sign-in, `.eml`
reading, the ERPNext quotation destination, n8n automation and a Docker-verified
deployment kit).

- [x] Import a filled-in RFQ template on New request (only the download
      existed); it fills the form and never writes
- [x] Settings → Optional automation, both off: pre-select providers serving
      the lane; close collection at the deadline (`collection.autoCloseOnDeadline`,
      which `closeRfq`'s comment promised but nothing implemented), as the
      system identity "Response deadline (automatic)"
- [x] `npm audit`: 5 moderate left on `main` to 0 (Vitest 5, uuid 11 override)
- [x] `.gitattributes`: Unix line endings for the Dockerfile and scripts
- [x] A parallel deployment kit written on `dev` was dropped in favour of
      `main`'s, which had been built and run with Docker
- [x] Tests: 339 unit (+6 skipped), 24 browser (+4 skipped), 65 journey

Found while merging: a blanket "system identities cannot edit" check would have
stopped `main`'s scheduled automation preparing reminders; it now refuses only
the deadline identity, and `assertCanSend` refuses every system identity.

Worth knowing on Windows hosts: SQLite cannot open a database whose full path
exceeds 260 characters. Keep `FREIGHT_DATA_DIR` short.

## 2026-09-28 — Preparing the handover

Branch: `dev`, then `main`, tagged `v1.0-handover`.

- [x] Backups include the attachments; `scripts/restore.mjs` checks a backup
      in a throwaway copy (`--check`) or restores one, keeping what it replaced
- [x] `OPERATIONS_DEMO=off` removes the fictional operations demo from inside
      the application (`src/proxy.ts`)
- [x] Settings → Go-live readiness: sign-in, HTTPS, demo data, people,
      companies, data folder, backup age, email, collection, ERPNext, the
      operations demo — each with what to do
- [x] `docs/FREIGHT_ACCEPTANCE.md`, `docs/FREIGHT_OWNERSHIP.md`,
      `docs/FREIGHT_USER_GUIDE.md`
- [x] Tests: 355 unit (+6 skipped), 24 browser (+4 skipped), 65 journey

Found while doing it: an empty `FREIGHT_DB_FILE=` line made the backup
script, and the application, look for a database with no path, because `??`
does not treat an empty string as unset. Both now fall back to the default.

