# Freight RFQ — what is left, and who does it

All the code for W1–W5, and the deployment kit for W6, is on `dev`. What remains needs a person: a decision
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
| 1 | Where do comparison outcomes go in ERPNext: the proposed *Freight Comparison* DocType, or something else? | Nothing is written | **C** |
| 2 | Are freight providers already Suppliers in ERPNext? | Providers are names | C (`--supplier-link`) |
| 3 | Do they want RFQs started by email? | Off | **E** |
| 4 | The real list of people, their roles and companies | Demo people | **D** |
| 5 | Who may approve outgoing email? | Logistics Operations Manager role only | D |
| 6 | Ranking weights (cost 60 / transit 25 / free days 15) | As shown | Settings |
| 7 | Currency policy: pull a daily rate feed, and from where? | Rates entered by hand, with source and date | Later work |
| 8 | Who selects providers, and when is collection complete? | Manager, explicitly | Settings → Optional automation (lane pre-selection, close at deadline), both off |
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

## F. Deployment (W6)

**Who:** you choose the host; whoever runs servers follows
`docs/FREIGHT_DEPLOYMENT.md`.

The kit is built: `Dockerfile`, `deploy/docker-compose.yml` (with a daily
backup), systemd units for a plain Linux server, `GET /api/health`, and
`npm run backup`. What it needs from you:

1. **Choose a host** with Node 22.5+, a long-running process, a writable,
   persistent, backed-up disk, and HTTPS on a fixed address. Not read-only
   serverless (Vercel functions): the freight store needs a disk.
2. **Build the Docker image once** before relying on it; Docker was not
   available where this was written, so the Dockerfile has not been run.
3. Set the configuration (`.env.local`) there, with `AUTH_MODE=entra` for real
   data, and use the public address for `AUTH_BASE_URL` and the sign-in
   redirect URI (D).
4. Schedule the backup daily **and copy it off the server**; test one restore.
5. Decide whether the operations demo at `/` should be reachable on the
   production address (blocking it at the proxy is described in the guide).

**Done when:** `/api/health` returns 200 on the public address, a sign-in works,
and a backup has been restored once on a spare machine.

## G. Housekeeping on this machine

- Dependencies: `npm audit` reports 0 vulnerabilities (Playwright 1.55.1,
  Vitest 5, uuid 11 forced under exceljs). Re-run it before each release.
- Open a pull request from `dev` to `main` when you want this reviewed.
- W7 (AI fallback) stays off until someone explicitly authorises the cost.
