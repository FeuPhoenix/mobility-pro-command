# Freight RFQ — handoff

**For whoever picks this up next.** Phase one is built, tested and on `main`.
This document is the orientation; the deeper documents are linked where they
matter.

Last updated 27 September 2026 (second revision — W3/W4/W5 merged, client
answers recorded, `.eml` reading and the ERPNext quotation destination added).

---

## 1. Read this much, then start

| Document | When you need it |
| --- | --- |
| This file | First. Orientation and what to do next. |
| `CLIENT_ASKS.md` | What we are waiting on from the customer, and who owns it. |
| `FREIGHT_SETUP.md` | Running it, configuration, access control. |
| `FREIGHT_HANDOVER.md` | Full capability list and the demonstration walkthrough. |
| `FREIGHT_ERPNEXT.md` | Before touching ERPNext. Has the open questions. |
| `FREIGHT_N8N.md` | Before touching the automation. |
| `FREIGHT_W2_LIVE_TEST.md` | When you have Microsoft 365 credentials. |
| `FREIGHT_GO_LIVE.md` | Everything left before production, and who does it. |
| `FREIGHT_ACCEPTANCE.md` | The guarantees and their tests, live-check results, sign-off. |
| `FREIGHT_OWNERSHIP.md` | Owners, secrets and their expiry dates, backups. |
| `FREIGHT_USER_GUIDE.md` | For the logistics team, day to day. |

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
npm test                 # 394 unit tests, 9 skipped without a live ERPNext
npm run test:e2e         # 26 browser tests + 4 skipped, needs a build first
node scripts/journey.mjs # 65 checks in demo mode, 12 in the signed-in modes
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
8. **No anonymous access** in the two real auth modes. Every freight screen and
   endpoint needs a session. The token-protected automation endpoints are the
   deliberate exception, and run as system identities. `AUTH_MODE=demo` is the
   picker and is a demonstration control only.
9. **A charge the reader cannot place is shown to a person**, never dropped.
10. **An email sent by a person is recorded as theirs.** Downloading the file
    passes the same approval gate as sending, and nothing claims this
    application sent what someone sent from their own mailbox.
11. **Only checked quotations reach ERPNext**, and each revision is its own
    record. A missing charge is sent as null — but Frappe stores a Float as 0
    regardless, so `amount_missing` and `unstated_numbers` carry the
    difference. Their reports must read those, and `docs/FREIGHT_ERPNEXT.md`
    says so.

---

## 3. What is done

- The whole journey: company → providers → shipping requirement → provider
  selection → RFQ approval → send → reply collection → extraction review →
  comparison and recommendation → outcome email → ERPNext record.
- Spreadsheet import for provider lists, with validation and duplicate
  detection. Excel comparison output.
- **Authentication**, three modes: `demo` (the picker), `password` (scrypt,
  revocable sessions, throttling, first-run setup), `entra` (Sign in with
  Microsoft, plus a People screen for managing access).
- **`.eml` reading and writing** — real provider quotations can be loaded
  through the same pipeline as live mail, and an approved email can be
  downloaded and sent from a person's own Outlook, then recorded. **A pilot can
  therefore run end to end with no Microsoft 365 credentials at all.**
- **ERPNext raw-quotation destination** — the one the customer chose.
- **Start an RFQ by email** (W5), off by default.
- **Import a filled-in shipping requirement template** on *Requests → New*; it
  fills the form and never writes by itself.
- **Optional automation**, both off (Settings): pre-select providers serving
  the lane; close collection at the response deadline, as the system identity
  *Response deadline (automatic)*.
- **Dependencies:** `npm audit` reports 0 vulnerabilities (Vitest 5, uuid 11
  forced under exceljs).
- **Operating it:** backups include attachments; `restore --check` and
  `restore --yes`; `OPERATIONS_DEMO=off`; a Go-live readiness check in
  Settings.
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

### A. Validate extraction against the customer's real quotations — *next*

Before they arrive, one thing was done to make that exercise safe: **a line
carrying an amount that matches no charge rule is reported rather than
dropped.** It appears under *Lines with an amount that were not recognised* on
the quote, and the summary stops saying "All figures read cleanly". Meeting an
unfamiliar charge is expected with every new provider; losing it in silence made
an offer look cheaper than it was, and nobody reviewing could tell.

He is sending sample replies as `.eml`. Load them from **Replies → Load .eml
files**; they go through the same matching and extraction as live mail. Expect
the parsers to need tuning — that is the point of the exercise, and it is the
step that has to happen before anything is stored in ERPNext.

Add a parser test for every new format you meet, **before** changing a regex.

### B. Build the ERPNext DocType — *customer's side, then ~1 day*

The destination is agreed: raw quotations. Send their team `docs/erpnext/` as it stands: importable JSON for both DocTypes
and a field table, generated by `node scripts/erpnext/emit-doctypes.mjs` from
the definitions in `scripts/erpnext/freight-quotation-doctype.mjs`. The
reasoning is in `docs/FREIGHT_ERPNEXT.md` section 1. Add the unique index on `freight_idempotency_key`, and keep
`amount` optional with no default.

Our side is written: `src/freight/service/erpQuotations.ts` walks the confirmed
quotations of a request and writes one record per quotation *version*, keyed by
a hash of the quote id so a retry updates rather than duplicating. Actions
`erp.syncQuotations` and `erp.syncQuotation`; state in `erp_quote_syncs`.
Covered by `tests/erpnext-quotation-sync.test.ts`. The RFQ **Record** tab lists
one row per quotation version with its record, and states in words why a
quotation cannot be written rather than leaving the row silently empty. What is
left on this item is theirs: create the DocType, then run it once against a real
instance.

**The whole application has now written to a real ERPNext** (15.121.4, in a
throwaway container): `ERPNEXT_ADAPTER=live`, Settings → Check connection
reporting *ERPNext connected*, then Record → *Record quotations* writing two
quotations as `live` (not simulated), and a repeated sync writing nothing new. `tests/erpnext-instance.test.ts` is that check, skipped unless
`ERPNEXT_LIVE_URL`/`_KEY`/`_SECRET` point at a **test** instance. Run it against
theirs once the DocType exists; it is the fastest way to know the integration
holds.

Both destinations have now been verified this way, quotations and comparison,
including the workbook upload (multipart, private file, and the duplicate check
that stops a retry attaching it twice).
Four things only the real instance found, all now fixed:

- **Frappe cannot store an empty number.** Our carefully sent `null` became
  `0.00`. Hence `amount_missing` and `unstated_numbers`.
- **A document name built from RFQ, provider and version collides**, and the
  collision surfaces as a duplicate whose record cannot be found by key — a
  write that then fails on every retry. Names now end in a hash of the key.
- **The module must exist first.** Stock ERPNext has no `Freight` module, and
  Frappe's error is a bare `LinkValidationError`. The script creates it.
- **The comparison DocType could never be created at all.** Its key field was
  hidden *and* mandatory without a default, which Frappe refuses. Nobody had
  ever run that script against a real instance.

`tests/erpnext-live-quotation.test.ts` remains the offline contract test against
a Frappe-shaped server, for when no instance is at hand.

### C. Verify Microsoft Graph sending — *1 day once credentials exist*

Not a blocker for starting a pilot any more: approved email can be downloaded
and sent by hand, and replies loaded as `.eml`. Graph turns that into
automation, it is no longer the gate.

Never run against a real tenant. Needs an Entra app registration with
`Mail.Send`, admin consent, and an ApplicationAccessPolicy scoping it to the one
mailbox. Steps and a results table in `FREIGHT_W2_LIVE_TEST.md`.

The customer is setting up a dedicated test mailbox. Send the first RFQ to an
internal address; the live adapter refuses the demo `.test` addresses by design.

### D. Turn on Teams notifications — *minutes, once the URL arrives*

Get a channel Incoming Webhook URL, then:

```bash
TEAMS_WEBHOOK_URL='https://...' npm run n8n:provision
```

The three notification nodes become Adaptive Card posts. Without the URL they
stay placeholders, which is how the committed exports ship.

### E. Deploy it — *half a day, once a host exists*

Still never deployed, but the artefacts are here: `Dockerfile`,
`docker-compose.yml`, an unauthenticated `/api/freight/health` that actually
queries the database, `scripts/backup.mjs` (a `VACUUM INTO` snapshot plus the
attachments, safe while the application runs), `scripts/restore.mjs` (`--check`
a backup, or restore one keeping what it replaces), `OPERATIONS_DEMO=off`, and
**Settings → Go-live readiness**, which checks the deployment from inside.

Needs a **writable filesystem** — not read-only serverless. Behind TLS, either
terminate with a proxy that sets `x-forwarded-proto` or set
`FREIGHT_FORCE_SECURE_COOKIES=true`. Copy backups off the server.
`docs/FREIGHT_GO_LIVE.md` section F is the checklist.

**Verified on 27 September:** the image builds, the container serves the
workspace, `/api/freight/health` answers `{"ok":true}`, the demonstration data
survives `docker restart` on its volume, Docker reports the container `healthy`,
and `docker exec mpc-test node scripts/backup.mjs` writes a snapshot to the
volume. What has *not* been proved is the rest of a deployment: TLS, a real
host, and a restore.

### F. Real accounts

Pick the mode. `entra` is the better fit for a Microsoft 365 customer and brings
password reset and MFA for free; `password` avoids waiting on tenant work. Both
are built. You still need the real people, their roles and their companies.

### G. Optional

- **Provider list import** — only needed at go-live, or to match sample replies
  to a provider automatically rather than attaching them by hand.
- **AI prose fallback** — written, off by default, costs money.

## 6. Decisions — answered 27 September

| Question | Answer |
| --- | --- |
| Where do comparison outcomes go in ERPNext? | **Raw quotations first**, comparison later once extraction is validated against actuals |
| Sample quotations | Being prepared, as `.eml` |
| Access | Must be configurable, not hardcoded — it is |
| n8n | No instance their side; we run one for development. Notifications via **Microsoft Teams** |
| Mailbox | A dedicated test account, and it must stay configurable — it is |
| Provider list | Not needed yet; the providers behind the samples would help matching |

Still open: are freight providers already Suppliers in ERPNext; how RFQs should
start in production; when collection closes (built as an off-by-default setting,
waiting on their answer); the ranking weights; the FX source; and the real list
of people and roles.

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
