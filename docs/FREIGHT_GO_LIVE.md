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
| 8 | Who selects providers, and when is collection complete? | Manager, explicitly | Nothing |
| 9 | Company names exactly as they appear in ERPNext | This application's names | C (`ERPNEXT_COMPANY_MAP`) |

## B. Microsoft 365 email (W1 + W2)

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
| `scripts/backup.mjs` | `VACUUM INTO` snapshot, safe while running, prunes to `--keep` |

1. Choose a host with a **writable, backed-up disk**: a small VM, Azure App
   Service on Linux with a persistent volume, Railway, Fly.io, Render with a
   disk. Not read-only serverless — the tracked `vercel.json` covers the
   operations demo, and the freight module will not run there.
2. `docker compose up -d --build`, with real values in `.env.local` on the
   server and nowhere else.
3. Put TLS in front of it. Either terminate with a proxy that sets
   `x-forwarded-proto`, or set `FREIGHT_FORCE_SECURE_COOKIES=true`. Cookie
   security follows the request, deliberately — see the note in section 7 of
   `docs/HANDOFF.md`.
4. Schedule `node scripts/backup.mjs` nightly, and back up the whole `/data`
   volume as well: the script covers the database, not the attachments beside
   it.
5. Restore-test it once, before there is anything worth losing.

The image, the volume, the health check and the in-container backup were all
exercised locally on 27 September. TLS, a real host and a restore were not.

**Done when:** `/api/freight/health` answers `{"ok":true}` through the proxy,
sign-in works over HTTPS, the container survives `docker compose restart` with
its data, and a backup has been restored into a throwaway copy and opened.

The operations demo at `/` is a separate, stateless demonstration. Decide
whether it should be reachable on the production address at all.

## G. Housekeeping on this machine

- **Dependencies, reviewed 27 September.** Was 6 findings (1 critical, 2 high,
  3 moderate); now **5 moderate**, after upgrading vitest to 3.2.7 and
  Playwright to 1.63. What is left, and why it is left:
  - **vitest / @vitest/mocker** (4 of the 5) — fixed only in vitest 5, a major
    upgrade. Test tooling: it is not in the production image, which installs
    with `--omit=dev`. Worth doing on its own, not under time pressure.
  - **exceljs → uuid** — `npm audit fix` wants to *downgrade* exceljs to 3.4.0,
    a breaking change, to fix it. The advisory needs a `buf` argument passed to
    uuid v3/v5/v6; exceljs calls `uuidv4()` with no arguments, so it is not
    reachable. Leave it.

  Do not run `npm audit fix --force` blindly - here it makes things worse.
- `git stash list` shows an old `package-lock.json` change (npm metadata only);
  `git stash drop` when you are sure.
- The local branch `feat/freight-mailbox` duplicates work already on `dev`;
  delete it when convenient.
- Open a pull request from `dev` to `main` when you want this reviewed.
- W7 (AI fallback) stays off until someone explicitly authorises the cost.
