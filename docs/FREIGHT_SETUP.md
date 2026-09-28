# Freight RFQ module — setup and configuration

The module runs with **no configuration at all**. Out of the box it uses a local
database, a simulated mail transport and a simulated ERPNext recorder, and it
says so on every screen where that matters.

Everything below is only needed to switch a simulated part over to a live one.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:4310/freight
```

Production mode:

```bash
npm run build
npm start            # http://localhost:4310/freight
```

Checks:

```bash
npm test             # 355 unit tests (Vitest), 6 skipped without a live ERPNext
npm run test:e2e     # 24 browser tests + 4 skipped (Playwright, uses your installed Chrome)
node scripts/journey.mjs   # 65 end-to-end checks over HTTP against a running server
```

`npm run test:e2e` needs a production build first and starts its own server on
port 4311. `scripts/journey.mjs` needs a server already running, and **it loads
the demonstration dataset**, so do not point it at anything you care about.

### Where the data lives

| Path | What it holds |
| --- | --- |
| `data/freight.db` | SQLite database (companies, providers, RFQs, quotes, emails, comparisons, ERPNext sync rows, audit trail) |
| `data/attachments/` | Uploaded quotations and generated comparison workbooks |

Both are git-ignored. Override the location with `FREIGHT_DATA_DIR`. Delete the
directory to start clean, or use **Load demo data** in the application.

> **Deployment:** `Dockerfile`, `docker-compose.yml`, `/api/freight/health`,
> `npm run backup` (database and attachments), `npm run restore -- --check`,
> `OPERATIONS_DEMO=off`, and Settings → Go-live readiness. The checklist is
> section F of `docs/FREIGHT_GO_LIVE.md`.
> The freight module needs a writable filesystem. It runs
> locally and on any normal Node host. It will **not** work on a read-only
> serverless filesystem — the operations demo elsewhere in this repository is
> deliberately stateless for that reason, but this module cannot be, because an
> approval that does not survive a reload is not an approval.

---

## Environment variables

Copy `.env.example` to `.env.local`. Every variable is optional; each one that
is missing keeps the corresponding part simulated and the UI reports it as a
setup requirement rather than failing.

### Outgoing email — Microsoft Graph

| Variable | Default | Effect |
| --- | --- | --- |
| `MAIL_ADAPTER` | `simulated` | `graph` sends real email through Microsoft 365 |
| `GRAPH_TENANT_ID` | — | Directory (tenant) ID of the app registration |
| `GRAPH_CLIENT_ID` | — | Application (client) ID |
| `GRAPH_CLIENT_SECRET` | — | Client secret |
| `GRAPH_MAILBOX` | — | The mailbox RFQs are sent from, e.g. `freight@mobilitypro.com` |

**To activate it:**

1. Register an application in Microsoft Entra ID.
2. Add the **application** permissions `Mail.Send` and `Mail.ReadWrite`, then
   grant admin consent. Delegated permissions are not enough for an unattended
   service.
3. Scope the app to the single mailbox with an
   [application access policy](https://learn.microsoft.com/graph/auth-limit-mailbox-access),
   so a mistake cannot send from every mailbox in the tenant:
   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> `
     -PolicyScopeGroupId freight-senders@yourdomain.com `
     -AccessRight RestrictAccess -Description "Mobility Pro Command freight RFQ"
   ```
4. Set the four variables and `MAIL_ADAPTER=graph`, then restart.
5. Open **Settings → Connections** and press *Check connection* on *Outgoing
   email*. It will say *Microsoft 365 mailbox connected* only after that check
   succeeds. Until then it says "not yet checked", and that is deliberate. The
   check reads the mailbox's Sent Items with `Mail.ReadWrite`; permission to
   *send* is only proven by the first real send.

**How it sends.** Each email is created as a draft in the mailbox and then
sent, rather than with a single `sendMail` call. That yields the email's real
Message-ID, which is stored, so a provider's reply is matched to the exact RFQ
email by its In-Reply-To even when they delete the reference from the subject.
Before calling Graph at all, a live send refuses reserved addresses (`.test`,
`.invalid`, `example.com`, as used by the demonstration data) and attachments
over 3 MB, each with a plain reason. If the connection drops mid-send, the
error says to check Sent Items before retrying, so a provider is never emailed
twice.

**Not verified live.** The Graph code path is complete and tested against a
faked Graph, but has not been run against a real tenant from this environment
— no app registration was available. The first live run is a checklist:
`docs/FREIGHT_W2_LIVE_TEST.md`.

### Inbound collection

Replies are collected from the same mailbox RFQs are sent from, by a system
identity called the **Mailbox Collector**. It files replies and can do nothing
else: it cannot edit, approve or send, and nobody can act as it.

| Variable | Default | Effect |
| --- | --- | --- |
| `MAILBOX_ADAPTER` | `simulated` | `graph` reads the Inbox of `GRAPH_MAILBOX` with a Graph delta query. Uses the same four `GRAPH_*` variables as sending |
| `MAILBOX_POLL_SECONDS` | unset (off) | Collect on a timer inside the server, e.g. `120`. Minimum 30 |
| `MAILBOX_COLLECT_TOKEN` | unset (off) | Lets an external scheduler run collection with `POST /api/freight/collect` and `Authorization: Bearer <token>`. Without it the endpoint is switched off |
| `MAILBOX_INITIAL_LOOKBACK_HOURS` | `72` | On the very first run, only mail received this recently is collected, so switching collection on does not pour the mailbox's history into the review queue |

**To activate it:**

1. Complete the Graph steps above. `Mail.ReadWrite` is what collection needs;
   collection only reads and never marks, moves or deletes a message.
2. Set `MAILBOX_ADAPTER=graph` and either `MAILBOX_POLL_SECONDS` (one
   long-running server) or `MAILBOX_COLLECT_TOKEN` plus a scheduler (several
   instances, or a host with its own cron). Restart.
3. In **Settings → Connections**, press *Check connection* on *Incoming
   email*. Then press **Collect now** and read the result under *Reply
   collection*.

What to expect from a run: a reply that quotes its RFQ reference from a known
sender is matched and its quotation extracted, waiting to be checked. Anything
ambiguous, or from an address the workspace does not know, lands in
**Replies** for a person to attach. Running collection again never files a
message twice. A message that repeatedly fails to file is set aside after three
attempts, with an entry in the activity log; it is still in the mailbox and can
be brought in by hand.

The in-process timer suits one long-running Node server. With several
instances, use one external scheduler instead; a database lease stops two runs
overlapping either way. A Graph webhook subscription would cut the delay, but
it needs a public HTTPS endpoint and renewal every few days, so it waits until
hosting is decided. It would call the same collection service.

**Not verified live.** Tested against a faked Graph, not a real tenant. Use a
dedicated freight mailbox: every message that arrives in its Inbox is
collected, and anything unrecognised goes to the review queue.

A reply can still be brought in by hand from the request screen, and the whole
downstream workflow behaves identically.

### Optional automation (off by default)

**Settings → Optional automation**, managers only. Both answer questions the
customer has not settled, so both start off.

- **Pre-select providers that serve the lane.** A new request (from the form,
  the spreadsheet import or email intake) starts with every contactable provider
  whose lanes include its route already ticked. Restricted providers are never
  included, no email is prepared, and the manager reviews the list.
- **Close collection when the response deadline passes**
  (`collection.autoCloseOnDeadline`). Checked after each collection run, so it
  needs reply collection scheduled (or someone pressing *Collect now*). It acts
  as the system identity *Response deadline (automatic)*, which can do nothing
  else. Late replies are still filed and a manager can reopen the request.

### Importing a shipping requirement from Excel

*Requests → New*: **Prefer a spreadsheet?** downloads the template; **Import a
filled-in template** reads it back into the form. The import never creates
anything by itself: the person checks the form and creates the RFQ, so a
spreadsheet is validated exactly like typed input. A file with several
requirements offers them one at a time.

### Starting an RFQ by email (off by default)

`RFQ_EMAIL_INTAKE=on` lets colleagues raise a request by email. It needs reply
collection (above) running, because it reads the same mailbox.

A person on the **People** list emails the freight mailbox with *New RFQ*,
*RFQ request* or *Shipping requirement* in the subject (not a reply, and
without an existing RFQ reference), and either attaches the Excel template from
*Requests → New* or writes labelled lines:

```
Company: MPD                       (only if they cover several companies)
Title: Tyre import, North China to Alexandria
Origin port: CNSHA
Destination port: EGALY
Incoterm: FOB
Containers: 6 x 40HC, Passenger car tyres, 21500 kg
Containers: 2 x 20GP, Truck tyres
Ship from: 2026-11-10
Ship to: 2026-11-24
Reply by: 2026-10-06               (15:00 UTC that day, unless a time is given)
Currency: USD
Cargo notes: ...                   (optional)
Instructions: ...                  (optional)
```

What happens:

- A readable request becomes a **draft** RFQ in the sender's name, validated
  exactly as the form validates. Providers are not chosen and nothing is sent;
  that stays with a person, under the usual approval rule.
- One that cannot be read in full creates nothing. It appears under *RFQ
  requests by email* on **Replies**, with every problem listed, until someone
  dismisses it.
- A read-only person, or a company the sender does not cover, is refused with
  the reason.
- The same email collected twice is recognised and ignored.

Mail from anyone not on the People list goes through normal reply matching.
Sender addresses can be forged, which is one reason this only ever creates
drafts that a person reviews before anything is sent.

### ERPNext

| Variable | Default | Effect |
| --- | --- | --- |
| `ERPNEXT_ADAPTER` | `simulated` | `live` attempts a real write |
| `ERPNEXT_BASE_URL` | — | e.g. `https://erp.mobilitypro.com` |
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | — | API keys for a user with permission on the destination DocType |
| `ERPNEXT_DOCTYPE` | — | The agreed destination. **Deliberately has no default.** |
| `ERPNEXT_COMPANY_MAP` | — | JSON mapping company codes to exact ERPNext Company names |

The live adapter **refuses to write** until `ERPNEXT_DOCTYPE` names a DocType
that can hold every field it writes, with the idempotency key marked Unique. It
checks this before every write; *Check connection* in Settings lists anything
missing. `scripts/erpnext-create-doctype.mjs` creates the proposed DocType once
the customer agrees to it. ERPNext has no native freight
comparison document, so guessing one would either write to the wrong place or
fail against a schema nobody has seen. See `docs/FREIGHT_ERPNEXT.md` for the
proposed mapping and the questions that need answering first.

**Not verified live.** No ERPNext instance was reachable from this environment.

### AI assistance

| Variable | Default | Effect |
| --- | --- | --- |
| `AI_ADAPTER` | `heuristic` | `anthropic` adds a prose fallback for unstructured quotations |
| `ANTHROPIC_API_KEY` | — | API key |
| `AI_MODEL` | `claude-sonnet-5` | Model id |

With AI off — the default — the module is fully functional and **no quotation
text leaves the machine**. The deterministic parsers handle labelled quotations,
which is nearly all of them, and anything they cannot read is flagged for manual
entry rather than guessed.

With AI on, it is consulted only when the deterministic pass found almost
nothing, it may only fill fields that are still empty, and everything it returns
is marked *low confidence* so it must be checked by a person before it can be
compared. Every call is logged with its model, token usage and latency.

**Not verified live.** No API key was available, and the brief forbids incurring
paid usage without authorisation.

---

## Access control

Two modes, chosen with `AUTH_MODE`.

**`demo` (the default).** The person acting is chosen from a picker in the top
bar. A demonstration control, not a security boundary: anyone who can reach the
server can act as anyone. Never run demo mode with real data on a server others
can reach.

**`entra`: Sign in with Microsoft.** People sign in with their work account
(OpenID Connect with PKCE, one Entra tenant). A person gets in only if their
email is on the **People** screen and their access is not switched off.

| Variable | Effect |
| --- | --- |
| `AUTH_MODE` | `entra` switches sign-in on |
| `AUTH_ENTRA_TENANT_ID` | Directory (tenant) ID |
| `AUTH_ENTRA_CLIENT_ID` / `AUTH_ENTRA_CLIENT_SECRET` | A **separate** app registration from the mail one: web platform, redirect URI `<AUTH_BASE_URL>/api/freight/auth/callback`, delegated `openid profile email` only |
| `AUTH_BASE_URL` | The address people open, e.g. `https://freight.example.com` |
| `AUTH_SESSION_SECRET` | Random, at least 32 characters. Signs session cookies; changing it signs everyone out |
| `AUTH_BOOTSTRAP_ADMIN_EMAIL` | Lets this one address in as a manager with every company, **only while no manager exists**. For the first sign-in on an empty workspace; remove it afterwards |

What sign-in mode guarantees:

- **It fails closed.** Incomplete configuration refuses every request with the
  reason; it never falls back to the demo picker.
- **The ID token is verified in full:** signature against Microsoft's published
  keys, issuer, audience, tenant, expiry and nonce.
- **An account is bound on first sign-in** to its immutable Entra object id.
  Renaming a different account to the same address gets nowhere.
- **Switching off access works immediately:** a session is checked against the
  People list on every request, not just at sign-in.
- **No demo controls:** the "Acting as" picker and *Load demo data* are off and
  refused by the server.
- Sessions last 10 hours, in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over
  HTTPS). Signing out ends the session here, not the Microsoft session.

**People** (Settings, managers only): add a person with their work email, role
and companies; edit; switch access off and on. A manager can hand out only the
companies they hold themselves, and cannot change their own role, remove their
own companies or switch off their own access, so a workspace cannot lose its
last manager by accident. The roles are the existing three: Logistics
Operations Manager (approves email), Logistics Coordinator (prepares, cannot
approve), Viewer (read-only).

The authorisation checks themselves are unchanged in both modes: every
company-scoped read and write goes through a `Ctx` and `assertCompanyAccess`;
approval is restricted to the manager role; attachments are only served to
someone who can reach the record; every action is audited, including sign-ins
and changes to people.

**Not verified live.** Tested with a locally generated signing key standing in
for Microsoft, and on a running server up to the redirect to Microsoft. The
first real sign-in needs the app registration.

### `password` mode, in detail

For a deployment that cannot use Entra, or is not willing to wait for the
tenant work. Set `AUTH_MODE=password`.

- **Passwords** are hashed with scrypt from Node's own crypto (N=32768, r=8,
  p=1) with a per-password salt. Minimum ten characters, with a letter and a
  digit.
- **Sessions are rows**, not stateless tokens, so they can be revoked. Only the
  SHA-256 of the token is stored, so a database backup does not hand over live
  sessions. Seven days, or twelve hours idle, whichever comes first.
- **A password change ends every session** for that person, and **disabling an
  account takes effect on the next request**, not at expiry.
- **Failed attempts are throttled**: eight within fifteen minutes locks the
  account for fifteen minutes.
- **Sign-in never reveals whether an address exists.** A wrong password and an
  unknown address give the same message in the same time, because the unknown
  case still performs a full scrypt comparison.
- **First run**: a workspace where nobody can sign in offers to create the first
  account, then that route refuses, so it cannot become a second back door.
- The session cookie is `Secure` when the request arrived over HTTPS, or over a
  proxy that set `x-forwarded-proto`. Deliberately not keyed off `NODE_ENV`:
  `next start` sets production, and a browser will not store a `Secure` cookie
  over plain HTTP, so sign-in would fail silently on an internal HTTP
  deployment. `FREIGHT_FORCE_SECURE_COOKIES=true` pins it on.


A workspace where nobody can sign in offers to create the first account, which
becomes the Logistics Operations Manager for every existing company. Once one
account can sign in, that route refuses — it cannot be used to add a second
back door later.

Loading the demonstration dataset is also allowed on a workspace nobody can
sign in to, because that is the other way to bootstrap. After that it needs a
signed-in manager, since it wipes everything.

### Demonstration accounts

The demo dataset creates three accounts with **real, hashed passwords** —
sign-in is not bypassed for the demo. The sign-in page lists them, with the
shared password, but only while the workspace is flagged as holding demo data.
On a real workspace it lists nothing, so the endpoint cannot enumerate users.

### Cookies and TLS

The session cookie is `httpOnly`, `sameSite=lax`, and `Secure` **when the
request arrived over HTTPS** — or over a proxy that set `x-forwarded-proto`.
It is deliberately not keyed off `NODE_ENV`: `next start` sets production, a
browser will not store a `Secure` cookie over plain HTTP, and sign-in would
then fail silently on any internal HTTP deployment. Set
`FREIGHT_FORCE_SECURE_COOKIES=true` to pin it on behind TLS you know is there.

### What is still not built

- No password reset or invitation email. An administrator sets a password
  directly; there is no SMTP flow for it.
- No multi-factor authentication.
- No self-service account management screen. Accounts come from the seed or
  from first-run setup.

### Automation is separate, and deliberately so

The `/api/freight/automation/*` endpoints and `/api/freight/collect` take a
bearer token rather than a session, because a scheduler has no session. They
run as system identities that can neither approve nor send. See
`docs/FREIGHT_N8N.md`.

## Safety defaults

- Demonstration addresses all end in `.test`, a reserved TLD that cannot receive
  mail, so even a misconfiguration cannot reach a real provider.
- The simulated transport never opens a network connection.
- A simulated ERPNext record is stored as `adapter: 'simulated'` and is rendered
  as *"Simulated, not in ERPNext"* everywhere. It can never be read back as a
  successful live write.
- Approval is bound to a hash of the reviewed content. Any edit to recipients,
  subject, body or attachments invalidates it.
- Sending twice is blocked by both the status check and a unique idempotency key.
