# Freight RFQ — handoff

**For whoever picks this up next.** Phase one is built, tested and on `main`.
This document is the orientation; the deeper documents are linked where they
matter.

Last updated 27 September 2026.

---

## 1. Read this much, then start

| Document | When you need it |
| --- | --- |
| This file | First. Orientation and what to do next. |
| `FREIGHT_SETUP.md` | Running it, configuration, access control. |
| `FREIGHT_HANDOVER.md` | Full capability list and the demonstration walkthrough. |
| `FREIGHT_ERPNEXT.md` | Before touching ERPNext. Has the open questions. |
| `FREIGHT_N8N.md` | Before touching the automation. |
| `FREIGHT_W2_LIVE_TEST.md` | When you have Microsoft 365 credentials. |

### Get it running (5 minutes)

```bash
npm install
npm run build && npm start        # http://localhost:4310/freight
```

Sign in, or press **Load demo data** if the workspace is empty. The demo
accounts and their shared password are listed on the sign-in page whenever the
workspace holds fictional data.

### Confirm it is green before you change anything

```bash
npm test                 # 202 unit tests
npm run test:e2e         # 13 browser tests, needs a production build first
node scripts/journey.mjs # 72 end-to-end checks, needs the server running
```

All three should pass on a clean checkout. If they do not, stop and say so —
do not build on a red suite.

---

## 2. The invariants

These are the product's actual guarantees. Each is enforced server-side and
covered by tests. **A test failing here means the change is wrong, not the
test.**

1. **Nothing sends without an explicit approval**, and the approval is bound to
   a hash of the reviewed content. Any edit to recipients, subject, body or
   attachments revokes it.
2. **One email per provider.** No provider may ever see another's identity,
   contacts or quote.
3. **A missing charge is never zero.** It blocks comparability and the screen
   says what is needed.
4. **Never rank incompatible things** — a different currency without a recorded
   rate, a different container basis, or figures nobody has reviewed.
5. **Simulated output is never presented as live.** A simulated ERPNext record
   cannot be read back as a successful write.
6. **Recommended is not selected.** This system never selects, negotiates or
   books. That stays with the team.
7. **Automation can prepare, never send.** The `system_automation` identity is
   refused by both `assertCanApprove` and `assertCanSend`, even for an email a
   person already approved.
8. **No anonymous access.** Every freight screen and endpoint needs a session.
   The two token-protected automation endpoints are the deliberate exception,
   and they run as system identities.

---

## 3. What is done

- The whole journey: company → providers → shipping requirement → provider
  selection → RFQ approval → send → reply collection → extraction review →
  comparison and recommendation → outcome email → ERPNext record.
- Spreadsheet import for provider lists, with validation and duplicate
  detection. Excel comparison output.
- **Authentication** — scrypt passwords, revocable database sessions, throttled
  attempts, first-run setup.
- **Scheduled reply collection** from a shared mailbox.
- **n8n automation** — seven endpoints, five workflows, verified end to end
  against a real n8n 2.40.7 instance.
- A demonstration dataset built by running the real workflow, so seeding fails
  if a rule breaks.

## 4. What is simulated

Email and ERPNext. Both are labelled as simulated on every screen where it
matters. The code for the live path is written for both; neither has ever
touched a real system.

**All the data is fictional.** Nobody has imported Mobility Pro's real provider
list. Every demo address ends in `.test`, a reserved TLD that cannot receive
mail, so a misconfiguration cannot reach a real provider.

---

## 5. The work left, in priority order

### A. Agree the ERPNext destination — *blocked on the customer, then 2–3 days*

**The single biggest blocker.** ERPNext has no native "freight comparison"
document, so the live adapter deliberately refuses to write rather than guess.
Do not remove that guard.

Needs an hour with whoever owns the ERPNext instance. `FREIGHT_ERPNEXT.md` has
a proposed `Freight Comparison` DocType, the full field mapping, and five
questions to answer. When you build it, add a **unique index** on
`freight_idempotency_key` — the lookup-then-write is not atomic, so the database
constraint is the real duplicate guard.

### B. Verify Microsoft Graph sending — *1 day once credentials exist*

The code path is complete but **has never run against a real tenant**. Needs an
Entra app registration with `Mail.Send` application permission, admin consent,
and an ApplicationAccessPolicy scoping it to one mailbox. Exact steps and a
results table are in `FREIGHT_W2_LIVE_TEST.md`.

Send the first one to an internal address. The demo addresses are reserved and
the live adapter refuses them on purpose.

### C. Deploy it — *1 day*

Never deployed anywhere. It needs a **writable filesystem** — it will not run on
read-only serverless. Any normal Node host is fine.

The persistence is deliberate: an approval that does not survive a reload is not
an approval. The older operations demo in this repo is stateless and deploys
anywhere; do not "fix" the freight module to match it.

Behind TLS, either terminate with a proxy that sets `x-forwarded-proto`, or set
`FREIGHT_FORCE_SECURE_COOKIES=true`.

### D. Real accounts — *half a day*

Sign-in is built; the account list is not. You need the real people, their
roles, and which companies each may act on. There is no password reset,
invitation email or MFA yet — decide whether you need them before go-live.

### E. Import the real provider list — *depends on the data*

Use the template from the Providers screen. The importer validates in full and
reports problems by row number before writing anything.

### F. Optional, only if the customer asks

- **n8n notification delivery.** The workflows stop at a placeholder node; the
  Slack or Teams credential is the client's to add.
- **Email-triggered RFQ intake.** Currently a form plus Excel import, because
  the customer never confirmed which they want.
- **AI prose fallback.** Written, off by default, costs money. If it is turned
  on, keep its output low-confidence and human-checked.

---

## 6. Decisions still needed from the customer

Each has a working default, so these change scope, not correctness.

1. **Where do comparison outcomes go in ERPNext?** — blocks A
2. Are freight providers already Suppliers in ERPNext? If so, records should
   carry the supplier id
3. How do RFQs start — form, Excel or email?
4. Who selects providers? Currently explicit manager selection
5. When is collection complete? Currently explicit manager closure
6. Confirm ranking weights (cost 60 / transit 25 / free days 15 — a starting
   point, not a recommendation)
7. Currency policy — should a daily FX rate be pulled, and from where?
8. The real list of people, roles and companies — blocks D

---

## 7. Things that will bite you

Each of these cost real time to find. They are written down so they cost you
none.

- **The parsers are the most fragile part.** A regex once read `USD 1200.00` as
  `120`, because its first alternative capped the integer at three digits — and
  every fixture used comma separators, so it stayed invisible until a test used
  a plain number. **Add a parser test for each new quotation format before
  touching the regexes.**
- **Do not key cookie security off `NODE_ENV`.** `next start` sets production, a
  browser will not store a `Secure` cookie over plain HTTP, and sign-in then
  fails silently on an internal HTTP deployment. It follows the request
  protocol instead.
- **`Buffer.from(x, 'base64')` does not throw on rubbish.** It returns an empty
  buffer, and `timingSafeEqual` of two empty buffers is `true`. That once made a
  corrupt password hash accept any password. Length-check before comparing.
- **n8n Variables are a licensed feature.** `$vars` does not resolve on the
  community edition. The committed workflow exports use `$vars`; the provisioner
  rebuilds them with literal URLs.
- **The simulated adapters must not hold state in memory.** The ERPNext one
  counted attempts in a process-local map, so a restart made its scripted
  failure fire twice. It reads the persisted attempt count now.
- **Windows long paths are disabled on the original dev machine.** Installing
  n8n into a deep path fails; `C:\n8n-host` was used instead.

---

## 8. Where things live

```
src/freight/
  types.ts            the domain model, with provenance built in
  db.ts               SQLite schema and migrations (node:sqlite, no native build)
  repo.ts             data access; every company-scoped call takes a Ctx
  auth.ts             passwords, sessions, throttling
  session.ts          who is acting on this request
  actions.ts          the single mutation boundary, validated with zod
  automation-auth.ts  bearer-token auth for schedulers
  view.ts             read models for the screens
  domain/             the rules: comparison, chasing, email approval, extraction, matching
  parsers/            deterministic text, Excel and PDF readers
  adapters/           mail, mailbox, erpnext, ai - each with a simulated default
  service/            orchestration per area
  excel/              comparison workbook and import templates
  demo/               the demonstration dataset
  ui/                 client state and shared components
src/app/freight/      the screens
src/app/api/freight/  the routes
tests/                unit tests; tests/e2e for browser journeys
scripts/              journey, n8n provisioning, workflow generation, live tests
```

The operations demo that pre-dated this work is untouched. Its tests still pass
and its routes still build. The freight module keeps its own store, navigation
and routes.

---

## 9. The local machine this was built on

Two things were left running and are **not** part of the repository:

- **n8n 2.40.7** installed at `C:\n8n-host`, with the five workflows imported
  and both credentials attached. Delete that folder when you no longer want it.
- **`.env.local`** with two generated automation tokens. Git-ignored, throwaway,
  regenerate your own.

Neither is needed to run the application. Both are only needed to exercise the
n8n automation locally.
