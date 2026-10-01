# Freight RFQ — what is left, and who does it

All the code for W1–W6 is on `main`. What remains needs a person: a decision
from the customer, an administrator in Microsoft 365 or ERPNext, or a server.
None of it is a code change unless a decision changes the scope.

Work through it top to bottom. Each step says who, what, and how you know it
worked. Secrets go into `.env.local` on the server by hand, never into the
application or the repository.

---

## A. Decisions from the customer

Ask these first; several steps below wait on them. Each has a working default.

| # | Question | Default today | Unblocks |
| --- | --- | --- | --- |
| 1 | ~~Where do comparison outcomes go in ERPNext?~~ **Answered 27 Sep: the raw quotations first**, analysis on their side. `Freight Quotation` is the destination; the comparison one stays available. | Raw quotations | **C** |
| 2 | Are freight providers already Suppliers in ERPNext? | Providers are names | C (`--supplier-link`) |
| 3 | Do they want RFQs started by email? | Off | **E** |
| 4 | The real list of people, their roles and companies | Demo people | **D** |
| 5 | Who may approve outgoing email? | Logistics Operations Manager role only | D |
| 6 | Ranking weights (cost 60 / transit 25 / free days 15) | As shown | Settings |
| 7 | Currency policy: pull a daily rate feed, and from where? | Rates entered by hand, with source and date | Later work |
| 8 | Who selects providers, and when is collection complete? | Manager, explicitly | Settings → Optional automation (lane pre-selection, close at deadline), both off |
| 9 | Company names exactly as they appear in ERPNext | This application's names | C (`ERPNEXT_COMPANY_MAP`) |

## B. Microsoft 365 email (W1 + W2)

> **A pilot does not have to wait for this.** An approved email can be
> downloaded as a `.eml` file, sent from the person's own Outlook and recorded
> as sent by hand; replies come back in through **Load .eml files**. The whole
> workflow runs, with two manual steps, and nothing pretends the application
> sent anything. Do this section to remove those two steps.

**Who:** a Microsoft 365 administrator, then whoever runs the server.
**How:** `docs/FREIGHT_W2_LIVE_TEST.md`, step by step.

1. Create a **test** freight mailbox (a shared mailbox is fine).
2. App registration with application permissions `Mail.Send` and
   `Mail.ReadWrite`, admin consent, a client secret. **Note the secret's
   expiry date**; email stops the day it expires.
3. Restrict the app to that one mailbox and confirm *Granted* / *Denied* with
   `Test-ApplicationAccessPolicy`.
4. Set `MAIL_ADAPTER=graph`, `MAILBOX_ADAPTER=graph` and the four `GRAPH_*`
   values. Restart.
5. Settings → Connections → *Check connection* on both email rows.
6. Send one RFQ to a mailbox you control, reply without the reference, press
   **Collect now**.

**Done when:** every row of the results table in that checklist passes. Then
switch on the schedule (`MAILBOX_POLL_SECONDS=120`) and repeat step 6 with a
real, dedicated freight mailbox.

## C. ERPNext (W3) — after decision 1

**Who:** the ERPNext administrator, then whoever runs the server.
**How:** "Going live" in `docs/FREIGHT_ERPNEXT.md`.

1. On a **test** ERPNext site first: run
   `node scripts/erpnext-create-doctype.mjs --dry-run`, review it, then run it
   without `--dry-run` using an administrator's key in
   `ERPNEXT_ADMIN_API_KEY` / `ERPNEXT_ADMIN_API_SECRET` (add `--supplier-link`
   if the answer to decision 2 is yes). Remove the admin key afterwards.
2. Create an API user with only the *Freight RFQ Integration* role plus
   `create` on File. Generate its key and secret.
3. Set `ERPNEXT_ADAPTER=live`, `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`,
   `ERPNEXT_API_SECRET`, `ERPNEXT_DOCTYPE="Freight Comparison"`, and
   `ERPNEXT_COMPANY_MAP` if names differ (decision 9). Restart.
4. Settings → Connections → ERPNext → *Check connection*: **ERPNext
   connected**, no setup requirements.
5. Record one comparison; retry it.

**Done when:** one record in ERPNext, workbook attached once, *Recommended, not
selected* shown; the retry updated it rather than creating a second. Then
repeat on the production site.

## D. Sign-in and people (W4) — after decision 4

**Who:** a Microsoft 365 administrator, then a manager.
**How:** "Access control" in `docs/FREIGHT_SETUP.md`.

1. A **second** app registration (not the mail one): platform *Web*, redirect
   URI `https://<your address>/api/freight/auth/callback`, delegated
   `openid profile email`, a client secret (note its expiry too).
2. Set `AUTH_MODE=entra`, `AUTH_ENTRA_TENANT_ID`, `AUTH_ENTRA_CLIENT_ID`,
   `AUTH_ENTRA_CLIENT_SECRET`, `AUTH_BASE_URL`, a random
   `AUTH_SESSION_SECRET` (32+ characters), and
   `AUTH_BOOTSTRAP_ADMIN_EMAIL` = the first manager's work email. Restart.
3. That manager signs in, adds the companies (Providers) and the people with
   their roles and companies (Settings → People).
4. **Remove `AUTH_BOOTSTRAP_ADMIN_EMAIL`** and restart.
5. Each person signs in once.

**Done when:** each person sees only their companies; a coordinator cannot
approve; someone not on the list is refused; switching a person off locks them
out on their next click.

**Do not run demo mode (`AUTH_MODE=demo`) with real data on a server others can
reach**: anyone could act as anyone. *Load demo data* would also erase
everything; it is switched off in sign-in mode for that reason.

## E. RFQs by email (W5) — only if decision 3 is yes

**Who:** whoever runs the server; B must be done first.

1. Set `RFQ_EMAIL_INTAKE=on`. Restart.
2. A person on the People list emails the freight mailbox with *New RFQ* in
   the subject, using the format in `docs/FREIGHT_SETUP.md` or the Excel
   template.
3. **Collect now.**

**Done when:** a draft RFQ appears in their name with nothing sent; a
deliberately incomplete email shows under *RFQ requests by email* on Replies
with its problems listed.

## F. Deployment (W6) — the artefacts exist, the host does not

**Who:** you, then whoever runs the server.

A container definition and its storage are in the repository now:

| File | What it is |
| --- | --- |
| `Dockerfile` | Node 24 build, runs unprivileged, storage on a volume at `/data` |
| `docker-compose.yml` | One service, a named volume, a health check |
| `/api/freight/health` | Unauthenticated liveness: opens the database and queries it |
| `scripts/backup.mjs` | `VACUUM INTO` snapshot of the database **and a copy of the attachments**, safe while running, prunes to `--keep` (`npm run backup`) |
| `scripts/restore.mjs` | `--check` verifies a backup in a throwaway copy; `--yes` restores, keeping what it replaces (`npm run restore`) |
| `OPERATIONS_DEMO=off` | Switches the fictional operations demo off inside the app: its routes 404, `/` opens the freight workspace |
| Settings → **Go-live readiness** | The application checks its own deployment: sign-in, demo data, people, email, ERPNext, backups, the operations demo |

1. Choose a host with a **writable, backed-up disk**. The customer has **no
   Azure subscription** (confirmed 1 October), so the candidates are a server
   they already own, a small VM, Azure App
   Service on Linux with a persistent volume, Railway, Fly.io, Render with a
   disk. Not read-only serverless — the tracked `vercel.json` covers the
   operations demo, and the freight module will not run there.
2. `docker compose up -d --build`, with real values in `.env.local` on the
   server and nowhere else.
3. Put TLS in front of it. Either terminate with a proxy that sets
   `x-forwarded-proto`, or set `FREIGHT_FORCE_SECURE_COOKIES=true`. Cookie
   security follows the request, deliberately — see the note in section 7 of
   `docs/HANDOFF.md`.
4. Schedule `npm run backup -- --out=<folder> --keep=14` nightly (it now
   includes the attachments), and copy the backups **off the server**.
5. Restore-test one: `npm run restore -- --from=<folder>/freight-<stamp>.db --check`.
6. Set `OPERATIONS_DEMO=off` unless the operations demo should be reachable.
7. As a manager, open **Settings → Go-live readiness** and clear every
   *Not ready* item.

The image, the volume, the health check and the in-container backup were all
exercised locally on 27 September; backup with attachments, check and restore,
and `OPERATIONS_DEMO=off` on 28 September. TLS and a real host were not.

**Done when:** `/api/freight/health` answers `{"ok":true}` through the proxy,
sign-in works over HTTPS, the container survives `docker compose restart` with
its data, a backup passes `restore --check`, and **Go-live readiness** says
*Ready*. Record each in `docs/FREIGHT_ACCEPTANCE.md` part 2.

## G. Housekeeping on this machine

- **Dependencies, reviewed 28 September: `npm audit` reports 0.** From 6
  findings (1 critical, 2 high, 3 moderate): Playwright 1.63, Vitest 5 (with
  `@vitest/coverage-v8` 5), and `uuid` forced to 11.1.1 under exceljs through
  `overrides` rather than downgrading exceljs. Re-run `npm audit` before each
  release.
- The handover version is on `main`, tagged `v1.1-handover` (`v1.0-handover` is the earlier cut, before sending by hand).
- Handover paperwork: `docs/FREIGHT_ACCEPTANCE.md` (guarantees, live-check
  results, sign-off), `docs/FREIGHT_OWNERSHIP.md` (owners, secrets and their
  expiry, backups), `docs/FREIGHT_USER_GUIDE.md` (for the logistics team).
- W7 (AI fallback) stays off until someone explicitly authorises the cost.

---

## H. The pilot instance, 29 September 2026

Running on the build machine, in Docker, and **not yet reachable from other
machines**. Deliberately: Windows Firewall has no inbound rule for 4310, and
until the first account exists anyone who can reach it could create it.

```bash
docker compose up -d --build      # already running
curl http://127.0.0.1:4310/api/freight/health
```

| Setting | Value | Why |
| --- | --- | --- |
| `AUTH_MODE` | `password` | It will be reachable on a network, where the demo picker (act as anyone) is not access control |
| `FREIGHT_MODE_SWITCH` | `on` | Demo for showing the client, production for the pilot, separate databases |
| Workspace | `production` | Empty, waiting for the first account |
| Storage | Docker volume `mpc-data` | Survives a rebuild; `docker compose down` **without** `-v` |

### The deployed container does not follow `main`

It runs the image it was built from. After pulling, rebuild, or you are testing
whatever the code looked like when the container was last made:

```bash
git pull && docker compose up -d --build
```

This cost a rehearsal: the Activity tab was checked on an image built before
the fix that puts email events there, so it showed nothing and looked like a
defect that had already been fixed.

### How it is reachable

**<https://side-laptop.taild01073.ts.net:8443>** - over Tailscale, so only from
that tailnet, with TLS, and **without opening a firewall port**. Windows
Firewall still has no inbound rule for 4310, which is deliberate.

```bash
tailscale serve --bg --https 8443 http://127.0.0.1:4310
tailscale serve --https=8443 off     # to withdraw it
```

Port 8443 on purpose: this machine already funnels `/` on 443 to another
service, and serving on `/` would have replaced it - and published the freight
workspace to the public internet through that funnel. Check
`tailscale serve status` before changing any of it.

Sign-in over that address sets a `Secure` cookie, which confirms the
application is reading `x-forwarded-proto` from the proxy rather than guessing
from `NODE_ENV`.

### The first account

Created: a throwaway Logistics Operations Manager. First-run setup is closed,
so nobody else can claim the instance. **Change that password before this is
reachable by anyone but you** - it was chosen in a chat transcript.

### Backups

A Windows scheduled task, **Mobility Pro Freight nightly backup**, runs
`scripts
ightly-backup.cmd` at 02:00 daily. That runs the backup *inside* the
container, so it captures the volume the application actually uses, and logs to
`data\backup.log`. Tested by running the task by hand.

Restore-test one at any time - it touches nothing live:

```bash
docker compose exec app node scripts/restore.mjs --from=/data/freight/backups/<file>.db --check
```

### Checked on the deployed instance

| Check | Result |
| --- | --- |
| Health endpoint | `{"ok":true,"storage":"writable"}` |
| Wrong password | Refused |
| Seeding demo data over production | Refused: it would erase the workspace |
| Switching production to demo while signed out | 401 |
| Every screen on an **empty** production workspace | Renders, with "Add a company" as the next step, no page errors |
| Backup, then restore `--check` | Integrity ok |
| Provider and RFQ import templates | Download as real `.xlsx` |

### What it is not

Not a production deployment. The machine has to stay on, there is no TLS unless
Tailscale provides it, and nothing is monitored. It is enough to run a pilot and
to show the client, and `docs/FREIGHT_GO_LIVE.md` section F still describes what
a real deployment needs.

---

## I. The dress rehearsal

The customer will not share their providers' addresses for testing, and we
would not use them if they did: sending a test RFQ to a real carrier is their
reputation, not ours. The rehearsal uses **one mailbox we control** for every
provider. The workflow is unchanged - one email per provider, separate records,
separate quotations - and nothing can reach a third party.

```bash
BASE=http://127.0.0.1:4310 EMAIL=<manager> PASSWORD=<theirs> TEST_ADDRESS=rfq.test@mobilityp.com node scripts/rehearsal.mjs
```

It creates a company, three providers, one shipping requirement, and prepares
the emails. It stops before approval, because approving and sending are a
person's decision.

### The part a person does

1. Read an email. **Approve** it.
2. **Download to send yourself**, open it in Outlook, send it to the test
   mailbox.
3. **I have sent this myself.**
4. Reply from that mailbox with a quotation. Save the reply as `.eml` and load
   it under **Replies → Load .eml files**.
5. Check the figures, build the comparison, record the quotations in ERPNext.

Use a real carrier's wording for the reply - copy one of the samples and change
the numbers. A rehearsal against prose we wrote ourselves proves less than one
against the formats the parsers actually meet.

**Done when** a quotation reaches ERPNext having never been typed into the
application by hand, and the Activity names who approved and who sent.

### Where the first rehearsal got to, 29 September

Steps 1 to 3 **done, on the pilot instance**: an email was approved,
downloaded, opened in Outlook as a draft, sent by hand, and recorded. The
record reads `sentByHand`, not simulated, and the Activity names the person:

```
email.sent_by_hand   ... recorded sending the RFQ email ... from their own
                     mailbox. This application did not send it.
```

That also settles test 2.7 of the handover plan, which needed a real Outlook
and could not be automated.

Steps 4 and 5 are still to do: reply with a quotation, save it as `.eml`, load
it under **Replies**, then compare and record. That half is the one that
exercises the parsers against what a real mail client produces.
