# Freight RFQ module — progress log

Branch: `feat/freight-rfq`. Started 2026-09-26.

## Context discovered
- This repo already contains "Mobility Pro Command": a Next.js 16 / React 19 client
  demonstration covering supplier-document control and aging-stock decisions.
- Its architecture is deliberately **stateless**: the browser holds the demo document
  and posts it to `/api/action`, which is the single server-side rule boundary.
- Strong existing conventions to follow: integration honesty (never claim "connected"
  without a successful probe), accessible UI kit in `src/components/ui.tsx`, plain
  operational language, docs per integration.

## Decision record
1. **Extend this repo, do not start a new app.** Same product, same client, reusable
   shell, UI kit, adapter conventions and test setup.
2. **The freight module gets real server-side persistence** (SQLite via Node's built-in
   `node:sqlite`, no native build). The brief requires persistent storage, server-enforced
   company isolation, an audit trail and idempotent sync — none of which a client-held
   document can honestly provide. The existing demo module is left exactly as it is.
3. New surface is namespaced: `src/freight/**`, `/api/freight/*`, `/freight/*` pages.
4. Adapters (mail, mailbox, ERPNext, AI) sit behind interfaces with a simulated
   implementation as the default. Simulated output is labelled as simulated everywhere.

## Status
- [x] Inspect repo, preserve existing work
- [ ] Data model + SQLite persistence
- [ ] Companies & providers (+ spreadsheet import)
- [ ] Shipping requirements & RFQ
- [ ] Email approval & sending
- [ ] Response collection & extraction
- [ ] Comparison & recommendation
- [ ] ERPNext recording
- [ ] UI
- [ ] Tests, verification, handover
