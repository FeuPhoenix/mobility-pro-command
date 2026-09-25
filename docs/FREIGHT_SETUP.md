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
npm test             # 118 business-logic tests (Vitest), 36 of them freight
npm run test:e2e     # 9 browser journeys (Playwright, uses your installed Chrome)
node scripts/journey.mjs   # 54 end-to-end checks over HTTP against a running server
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

> **Deployment note.** The freight module needs a writable filesystem. It runs
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
5. Open **Settings → Connections**. It will say *Microsoft 365 mailbox connected*
   only after a successful probe. Until then it says "not yet checked", and
   that is deliberate.

**Not verified live.** The Graph code path is complete but has not been run
against a real tenant from this environment — no app registration was available.
Treat the first live send as a test: send one RFQ to an internal address first.

### Inbound collection

Collecting replies automatically needs a poll or a webhook against the same
mailbox. The matching, extraction and review code is complete and is exercised
by every reply in the demonstration dataset; what is **not** built is the
scheduled fetch. See *Remaining work* in `docs/FREIGHT_HANDOVER.md`.

In the meantime a reply can be brought in by hand from the request screen, and
the whole downstream workflow behaves identically.

### ERPNext

| Variable | Default | Effect |
| --- | --- | --- |
| `ERPNEXT_ADAPTER` | `simulated` | `live` attempts a real write |
| `ERPNEXT_BASE_URL` | — | e.g. `https://erp.mobilitypro.com` |
| `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` | — | API keys for a user with permission on the destination DocType |
| `ERPNEXT_DOCTYPE` | — | The agreed destination. **Deliberately has no default.** |

The live adapter **refuses to write** until `ERPNEXT_DOCTYPE` names a DocType it
has confirmed exists on the target instance. ERPNext has no native freight
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

## Access control — an honest statement

There is **no authentication** in this phase, and the brief does not ask for
one. The person acting is chosen from a picker in the top bar, which is a
demonstration control, not a security boundary.

What *is* built, and what matters for adding authentication later:

- every company-scoped read and write goes through a `Ctx` carrying the acting
  user, and calls `assertCompanyAccess` before touching anything;
- approval is restricted to the manager role, server-side;
- attachments are only served when the acting user can already reach the record
  that references them, so a guessed key leaks nothing;
- every meaningful action is written to an audit trail the UI cannot rewrite.

Adding real authentication means replacing exactly one function —
`resolveCtx` in `src/freight/session.ts`. Every authorisation check already in
place keeps working unchanged.

---

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
