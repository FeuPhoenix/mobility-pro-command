# Mobility Pro Command

An intelligent operational layer for demand-to-cash, inventory and pricing decisions,
demonstrated **alongside ERPNext**. ERPNext remains the intended system of record; this
application is where exceptions are surfaced, evidence is assembled, and controlled
decisions get made.

This repository is an **interactive client demonstration**, not a production system.
Everything in it runs locally with no ERPNext access, no messaging account and no paid
AI credentials.

---

## Run it

```bash
npm install
npm run dev        # http://localhost:4310
```

Production mode:

```bash
npm run build
npm start          # http://localhost:4310
```

Tests:

```bash
npm test           # 394 unit tests (Vitest), 9 skipped without a live ERPNext
npm run test:e2e   # browser journey tests (Playwright, uses your installed Chrome)

# Freight module only:
npx vitest run tests/freight.test.ts        # 36 business-rule tests
npx playwright test tests/e2e/freight.spec.ts
node scripts/journey.mjs                    # 54 end-to-end checks over HTTP
```

`npm run test:e2e` needs a production build first (`npm run build`); it starts its own
server on port 4311.

### Configuration

None is required. `.env.example` documents the optional variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `ERPNEXT_BASE_URL` / `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | unset | For the **operations demo**, reserved: no live adapter is implemented there. The freight module does implement a live adapter; see `docs/FREIGHT_SETUP.md`. |
| `ANTHROPIC_API_KEY` | unset | Reserved. The operations assistant is deterministic and does not call a model. |

The freight module has its own configuration, all optional, documented in
[`docs/FREIGHT_SETUP.md`](docs/FREIGHT_SETUP.md). With none of it set, the whole
freight workflow runs locally with simulated mail and ERPNext.

---

## Two modules

This repository now holds two workspaces, side by side and independent.

### Freight RFQ — `/freight`

Phase one of the freight brief: maintain freight-provider lists for several
companies, issue shipping requirements and RFQs, collect and check quotations,
compare them, recommend an offer, email the outcome and record it in ERPNext.
The team keeps final selection, negotiation and booking.

Unlike the operations demo below, this module keeps a **real server-side store**
(SQLite via Node's built-in `node:sqlite`, no native build). It has to: an
approval that does not survive a reload is not an approval, and duplicate-send
protection a client can forget is not protection.

- **Taking this over? Start here:** [`docs/HANDOFF.md`](docs/HANDOFF.md)
- Setup and configuration: [`docs/FREIGHT_SETUP.md`](docs/FREIGHT_SETUP.md)
- What works, what is simulated, and the demo walkthrough: [`docs/FREIGHT_HANDOVER.md`](docs/FREIGHT_HANDOVER.md)
- ERPNext mapping and open questions: [`docs/FREIGHT_ERPNEXT.md`](docs/FREIGHT_ERPNEXT.md)

Open `http://localhost:4310/freight` and press **Load demo data**.

Email is **simulated by default**: prepared, approved and recorded exactly as in
production, but never transmitted. ERPNext records are local and are labelled
*"Simulated, not in ERPNext"* everywhere they appear.

### Operations demo — `/`

The original supplier-document and aging-stock demonstration, described below.
It is unchanged.

---

## What a visitor can do

**Two complete journeys**, connected by a shared dashboard, records, approval inbox,
activity trail and contextual assistant.

### Journey A — Supplier document control
`Overview → Document cases → PI-ORI-88412`

A supplier pro forma invoice from Orient Rubber disagrees with purchase order
PO-2026-0418 on four blocking points and one advisory point. The visitor can read the
original document beside the extracted fields, correct or confirm any extracted value
and watch the comparison recompute, raise a discrepancy case, generate and edit a
supplier clarification, simulate receipt of a corrected document, re-run validation and
watch receiving readiness release — or override the block with a written reason under an
authorised role.

A second shipment (Siam Tread, PI-STP-20714) is included as a **clean** comparison.

### Journey B — Aging stock to a controlled sale
`Overview → Inventory → OPP-2026-014`

812 pieces of 265/70R16 10PR have sat at the Obour City Hub for 215 days while shipped
volume fell from 157 to 56 pcs/month. The visitor compares holding, transferring and
discounting at 5% / 8% / 10%, adjusts the quantity and the demand assumption, picks a
customer from real purchase history, prepares an order — and hits a genuine block:
**stock is available and the credit limit has room, but an invoice is 52 days past due**,
so automatic release is withheld. Three explainable options follow (deposit, partial
release, finance review), routed to the Finance Director, decided in the approval inbox,
with reservations, availability, exposure and the activity trail all updating
consistently afterwards.

### Demo controls

- **Start guided demo** — an eight-step narrated walkthrough (top bar).
- **Explore freely** — nothing is gated.
- **Reset demo** — bottom of the navigation rail, with confirmation.
- **Acting as** — role selector in the top bar; authorisation is enforced server-side.

---

## Architecture

```
src/
  domain/          Pure business logic. No React, no I/O, no framework.
    money.ts         EGP formatting, rounding, date arithmetic, fixed demo FX
    types.ts         The domain model
    seed.ts          The single fictional dataset + every demo assumption
    documentRules.ts Supplier-document validation and receiving readiness
    scenarios.ts     Deal arithmetic (deterministic) vs demand modelling (assumed)
    credit.ts        Credit rules, fulfilment options, approval staleness hash
    selectors.ts     Derived reads: stock, receivables, exposure, history
    exceptions.ts    The ranked exception queue and the daily briefing
    cycle.ts         The demand-to-cash map, transcribed from the client workbook
    automations.ts   The n8n workflows that surround the app
    assistant.ts     Deterministic contextual assistant
  server/
    demoState.ts     Seeding and validation of the demo document (stateless)
    actions.ts       THE mutation boundary: validation + authorisation
  lib/erpnext/
    adapter.ts       The ERPNext integration boundary + proposed doctype mappings
  lib/n8n/
    adapter.ts       The n8n boundary: inbound endpoints and outbound events
  app/               Next.js App Router pages and API routes
  components/        Accessible UI primitives, shell, assistant, guided demo
tests/               Vitest business-logic tests
tests/e2e/           Playwright journey tests
docs/                Presentation script, ERPNext outline, validation report, rules
```

### Principles the code holds to

1. **One mutation boundary.** Every state change — from a button, or from the
   assistant — goes through `applyAction` in `src/server/actions.ts`, which validates and
   authorises server-side. The browser cannot skip a rule: it can only ask the server to
   compute the next state.
2. **Money, stock, credit and workflow are calculated, never inferred.** The assistant
   calls the same functions the UI does.
3. **Measures are typed and never blended.** Inventory carrying value, potential sales
   value, gross profit, receivables at risk and purchase value exposed are distinct, are
   labelled, and are never summed.
4. **Deterministic results are separated from assumptions.** Price, revenue, cost, gross
   profit, margin, remaining stock and collection dates are arithmetic. How many units
   move is an editable assumption, shown in its own band.
5. **Nothing claims more than it did.** Document extraction is labelled simulated. The
   assistant is labelled simulated. The ERPNext adapter says "demo adapter", never
   "connected". Resolving a document case does not mean goods arrived. Approving an order
   does not recognise revenue or collect cash.

### Session isolation and persistence

**The browser owns the demo document.** It is seeded by the server, held in
`localStorage` (~42 KB), and sent back with every request. Two people opening the same
link therefore get genuinely independent sessions with no server-side session store at
all, and refresh, navigation, new tabs and server restarts all preserve state.

This is deliberate: the demo is deployed to a serverless host, where the filesystem is
read-only and consecutive requests are not guaranteed to reach the same instance. Keeping
state on the server would make it reset at unpredictable moments — the worst possible
failure during a presentation.

The honest limit: because the client carries the document, it could submit a doctored one.
That is not worth defending against here — the dataset is fictional, there is no
authentication, and nothing touches a real record. What a client still cannot do is bypass
a rule; every transition is computed server-side from the document it supplied.

---

## Currency and locale

Everything is denominated in **EGP**, handled centrally in `src/domain/money.ts`.
Supplier documents are quoted in USD and carry a fixed demo rate of **48.50 EGP/USD**
recorded on the document itself; the UI always shows the EGP value beside the USD one.
Dates render as `17 Sept 2026` throughout. The demo clock is pinned to **17 Sep 2026** so
every visitor sees the same ages, overdue days and scenario results.

---

## Honest status

| Area | Status |
| --- | --- |
| Both primary journeys | **Functional**, verified in a browser |
| Business calculations | **Functional**, covered by tests |
| Permissions, invalid transitions, duplicate actions | **Functional**, enforced server-side |
| Persistence, session isolation, reset | **Functional** |
| Document extraction | **Simulated** — sample documents ship with pre-extracted fields; no PDF is parsed |
| Contextual assistant | **Simulated** — deterministic rules over the dataset; no model call |
| Supplier / customer messaging | **Simulated** — drafts never leave the application |
| ERPNext connection | **Not implemented** — mock adapter only; see `docs/ERPNEXT_INTEGRATION.md` |
| n8n workflows | **Designed** — 7 real, importable exports under `public/n8n/`, visible in the app. No instance is connected and no workflow has executed; see `docs/N8N_INTEGRATION.md` |
| Picking, dispatch, invoicing, payment posting | **Not modelled** — shown as context only |

See `docs/VALIDATION_REPORT.md` for exactly what was tested.

---

## Deploying the demo

The app is stateless on the server, so it deploys to any serverless host with **no
configuration, no database and no environment variables**.

```bash
npx vercel login      # one-time, opens a browser
npx vercel            # preview deployment
npx vercel --prod     # production URL to share
```

`vercel.json` pins the function region to `fra1` (Frankfurt) — the closest Vercel region
to Egypt — and `.vercelignore` keeps the upload to the application itself. The demo is
marked `noindex`, so the link is shareable but will not turn up in search results.

Anything else that runs a Node process works too (Render, Railway, Fly.io); nothing in the
app is Vercel-specific.

---

## Further reading

- `docs/PRESENTATION_SCRIPT.md` — a five-minute script covering both journeys
- `docs/BUSINESS_RULES.md` — every rule and demo assumption, with its identifier
- `docs/ERPNEXT_INTEGRATION.md` — proposed mappings and the open discovery questions
- `docs/N8N_INTEGRATION.md` — the division of labour between the app and n8n, the seam, the seven workflows, and the open discovery questions
- `docs/VALIDATION_REPORT.md` — what was actually tested, and what was not
