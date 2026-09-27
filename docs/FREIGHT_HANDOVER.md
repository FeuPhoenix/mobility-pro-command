# Freight RFQ module — handover

Phase one: reduce the manual work in maintaining freight-provider lists for
several companies, sending shipping requirements and RFQs, collecting
quotations, comparing them, recommending an offer, emailing the outcome and
recording it in ERPNext.

The team keeps final provider selection, negotiation and booking. Nothing in
this module selects, negotiates or books.

---

## 1. What is implemented, what is simulated, what is blocked

### Working locally, end to end

| Capability | Notes |
| --- | --- |
| Multiple companies, each with its own provider list | Added through the UI, no code change |
| Shared provider details vs. company-specific relationship | One provider row, one relationship row per company |
| Outreach restrictions | `contracted`, `excluded` and `prospect` providers cannot be sent an RFQ. Enforced in the service, not just hidden in the UI, and the reason is shown wherever it bites |
| Spreadsheet import with validation and duplicate detection | Two-phase: the file is checked in full and reported by row number, and nothing is written until you accept |
| Downloadable Excel templates | Provider list and shipping requirement |
| Shipping requirement capture | Form, with company, route, Incoterm, container lines, dates, deadline, currency, instructions |
| RFQ references | `RFQ-MPD-2026-0007`, carried through every email, file and record |
| Explicit recipient selection | With search, lane matching and a visible recipient review |
| One email per provider | No provider can see another's identity, contacts or quote |
| Approval on every outgoing email | RFQs, reminders and the comparison email, all through the same gate |
| Approval bound to content | Hash over recipients, subject, body and attachments. Any edit revokes it |
| Duplicate-send prevention | Status check plus a unique idempotency key |
| Follow-up reminders | Prepared for non-responders, still require approval |
| Reply matching | Thread id, then RFQ reference, then sender. Ambiguity goes to a human review queue with the candidates and the reason |
| Quote extraction | Email text, Excel and text-based PDF |
| Provenance on every value | Exact cell or line, the raw text, and a confidence level |
| Revised quotations | Become a new version; the earlier one is kept and marked superseded |
| Extraction review | Side-by-side with the source; corrections persist and flow into the comparison |
| Unreadable inputs | Reported with the reason, never silently treated as empty |
| Side-by-side comparison | Pinned field column, differing rows marked, missing values shown as missing |
| Cheapest vs. recommended | Computed separately and always both shown |
| Transparent ranking | Three visible weights, adjustable, rebuild on demand |
| Refusal to compare unlike things | Missing charge, currency mismatch without a recorded rate, different container basis, unreviewed figures |
| Excel comparison output | Comparison, Recommendation and Sources sheets |
| Completion email to the manager | Summary, recommendation, caveats, workbook attached |
| ERPNext recording | Idempotent, retryable, with visible pending / success / failed / setup-required states |
| Audit trail | Every action, approval, send, correction and sync attempt |
| Scheduled automation seam | Seven token-protected endpoints and five n8n workflows, **verified end to end against a real n8n 2.40.7 instance**. Chasing policy now actually drives reminders. See `docs/FREIGHT_N8N.md` |
| Company isolation | Enforced server-side on every read and write |
| Demonstration dataset | Built by running the real workflow, not by inserting finished rows |

### Simulated — clearly labelled as such in the UI

| Part | What actually happens |
| --- | --- |
| Outgoing email | Prepared, approved and recorded exactly as in production, but nothing is transmitted. Marked "Simulated" on every sent email |
| Inbound mail | Collection is built and can run on a schedule, but by default it reads an empty simulated mailbox. The demonstration dataset feeds replies through the same `ingestMessage()` pipeline |
| ERPNext | Recorded locally, stored as `adapter: 'simulated'`, rendered as *"Simulated, not in ERPNext"*. It can never be read back as a live write |
| One ERPNext failure | The demo deliberately fails the first attempt so the retry path is a real failure and a real recovery |

### Written but not verified against a live service

Each of these is complete code behind an adapter boundary. None could be
exercised from this environment, and none is claimed as working.

| Integration | What is missing to verify it |
| --- | --- |
| Microsoft Graph sending (draft, then send) | An Entra app registration with `Mail.Send` and `Mail.ReadWrite`, admin consent, scoped to one mailbox. Tested against a faked Graph. Run `docs/FREIGHT_W2_LIVE_TEST.md` |
| Microsoft Graph mailbox collection (delta query) | The same app registration. Tested against a faked Graph only; covered by the same checklist |
| ERPNext write | A reachable instance **and** an agreed destination DocType |
| Anthropic prose fallback | An API key; deliberately not used, since paid usage was not authorised |

### Not built in this phase

- Authentication. See the honest statement in `FREIGHT_SETUP.md`.
- Everything explicitly out of scope: shipment tracking, vessel positions,
  arrival prediction, provider discovery, WhatsApp/WeChat, negotiation,
  booking, a data warehouse.

### Reply collection (added 2026-09-27, W1)

Replies are collected from the shared mailbox by the **Mailbox Collector**, a
system identity (`src/freight/system.ts`). It is not a user row, so nobody can
act as it; it can see every company, because one mailbox serves them all, and
it cannot edit, approve or send. Its entries in the activity log carry its own
name, never a manager's.

- **Adapter:** `src/freight/adapters/mailbox.ts`, the same shape as
  `adapters/mail.ts`: `SimulatedMailbox` (default) and `GraphMailbox`, chosen
  by `MAILBOX_ADAPTER`. Graph uses a delta query on the Inbox, so each run
  fetches only what is new. It only reads; nothing in the mailbox is changed.
- **One path in:** `src/freight/service/collect.ts` hands every message to the
  existing `ingestMessage()`. There is no second ingestion path.
- **No duplicates:** the saved mailbox position moves forward only after a
  whole page is filed, and `ingestMessage` skips any message id it has seen.
  Losing the position entirely just re-reads; nothing is filed twice.
- **Never overlapping:** a run takes a database lease first.
- **Never silently lost:** a message that fails to file is retried on the next
  two runs, then set aside with an audit entry naming its sender and subject.
- **Triggers:** `MAILBOX_POLL_SECONDS` starts an in-process timer; an external
  scheduler can `POST /api/freight/collect` with `MAILBOX_COLLECT_TOKEN`; a
  person can press **Collect now** (Replies, or Settings → Connections).
- **Connection checks:** Settings → Connections now has *Check connection* for
  outgoing and incoming email. The result is stored against the configuration
  it was made for, so changing the tenant, app or mailbox clears it. Before
  this, nothing ever ran the Graph probe, so "connected" could never appear.

### Live email readiness (added 2026-09-27, W2 code side)

W2 itself is a live test that needs a tenant. Everything that could be done
without one is done, and the live run is a checklist:
`docs/FREIGHT_W2_LIVE_TEST.md`.

- **Real Message-IDs.** Graph `sendMail` returns no id, so a reply could never
  be tied to the RFQ email by thread. Sending now creates a draft and sends it,
  and the draft's Message-ID is stored as the transport id.
- **Thread matching actually uses it.** The matcher looked up only the reply's
  conversation id, which Graph always supplies, so `In-Reply-To` was never
  consulted. It now tries both. A reply with the reference deleted from the
  subject is matched by thread; a test proves it end to end.
- **Safer live sends.** Reserved addresses (the demo's `.test` ones) and
  attachments over 3 MB are refused before Graph is called. A refused send
  deletes its draft. A dropped connection mid-send is reported as "check Sent
  Items before retrying", not as a retryable failure, so nobody is emailed
  twice.

---

## 2. Demonstration walkthrough (about 8 minutes)

Start at **http://localhost:4310/freight**. If the workspace is empty, or to
reset, use **Load demo data** at the bottom of the navigation.

Everything below is fictional. Every address ends in `.test`, which cannot
receive mail.

**1 · Overview — what needs a decision.**
Six counters answer the manager's actual questions. One reply needs matching,
four quotes need checking, one ERPNext record failed. Click a counter to filter.

**2 · Providers — the restrictions are real.**
*Providers → Mobility Pro Distribution.* Nine providers. Horizon Global is
**under contract** and Cape Meridian is **excluded**, each with a reason. Try
selecting one for an RFQ: the checkbox is disabled, and the server refuses it
too if the request is crafted by hand.

**3 · Requests → RFQ-MPD-2026-0001 — the main journey.**
Five providers were asked. The blue *Next* bar always says what the application
is waiting for.

**4 · Quotes — check the figures against the source.**
The provider's original email sits beside the extracted fields. Every value
shows where it came from and how confident the parser was.
- **Delta Freight Partners** listed *Terminal handling (destination)* with no
  amount. It is left blank, not zeroed, and the note explains that leaving it
  blank keeps the offer out of the comparison. This is the point: treating that
  gap as zero would make the incomplete offer look like the cheapest one.
- **Suez Gateway Shipping** shows *Revised, v2*. Version 1 is kept and listed
  under Version history.

Confirm each of the four.

**5 · Comparison — build it.**
Three of four offers are comparable. Delta is listed with what it needs.
- **Nile Star Logistics is the cheapest at USD 11,799.**
- **Suez Gateway Shipping is recommended at USD 12,165** — USD 366 more, but
  11 days faster with 7 more free days.
Both are shown, and the reasoning and the tradeoff are spelled out. Move the
cost weight to 90% and rebuild: the recommendation switches to the cheapest
offer. Nothing is hidden behind a score.

**6 · The completion email.**
*Prepare the comparison email.* It goes to the manager with a summary, the
recommendation, the caveats and the Excel workbook, and says plainly that
nothing has been booked. It is **not** sent — it waits for approval.

Open it in **Emails**. Edit the subject after approving it: the approval is
revoked in front of you and the send control disappears. Approve again, send —
the toast says *simulated*.

**7 · Replies — the ambiguous one.**
Anchor Line Agencies quoted no reference and has two open requests, so nothing
was assumed. The candidates and the reason are shown; pick one and the
quotation is extracted by the same parsers.

**8 · Record — a failure and a recovery.**
On the overview, RFQ-MPD-2026-0003 shows *Recording failed* after a simulated
timeout. Press **Retry**: it succeeds on the second attempt, reports two
attempts honestly, and is labelled *Simulated, not in ERPNext*. Retry again and
nothing happens — it will not be recorded twice.

**9 · Company isolation.**
Switch *Acting as* to **Reem Al Suwaidi**, who only covers Mobility Pro
Industrial. The MPD requests disappear, and a direct request for one returns
403.

---

## 3. Verification

| Check | Result |
| --- | --- |
| `npm test` | **137 passed** (82 operations demo, 36 freight, 19 mailbox collection) |
| `npm run test:e2e` | **21 passed** (12 operations demo, 9 freight; browser, real Chrome) |
| `node scripts/journey.mjs` | **61 passed** over HTTP against a running server |
| `npm run build` | Compiles clean; existing routes unchanged |
| `npx tsc --noEmit` | Clean |

What the tests cover, by the brief's own list: approval enforcement,
duplicate-send prevention, company isolation, reply association and revised
offers, missing values and incompatible pricing, recommendation calculations,
and ERPNext retry and duplicate protection.

Two defects were found by these tests and fixed:

- **A four-digit amount with no thousands separator was misread.** `USD 1200.00`
  parsed as `120`, because the regex's first alternative capped the integer part
  at three digits. The demo fixtures happened to use comma separators, so it was
  invisible until a unit test used a plain number. Fixed and regression-tested.
- **Prepared emails sat invisibly as drafts.** They never reached the manager's
  approval queue until someone opened the request and pressed a second button.
  They are now created awaiting approval.

Two UI defects were found by looking at the screenshots and fixed: the freight
shell was rendering nested inside the operations shell (two navigations), and
the provenance column collapsed to an unreadable sliver at half-page width.

Screenshots from the browser run are in `test-results/screenshots/`.

---

## 4. Decisions still needed from the customer

These were listed as unconfirmed in the brief. Each has a working default, and
each default is the smallest reversible choice.

| Question | What it does today | What changing it costs |
| --- | --- | --- |
| **How do RFQs start?** Excel, email or a form? | A form, plus a downloadable Excel template and import | Email intake is an extension point. The parsing and matching already exist; it needs the same scheduled fetch as reply collection |
| **Who selects providers?** | The manager selects explicitly, with filters and a visible recipient review | Auto-suggestion by lane is already computed and shown ("Serves this lane"); turning it into a default selection is small |
| **When is collection complete?** | The manager closes it explicitly. The deadline is shown and counted down but does not close anything | A deadline-driven close is a setting plus a scheduled job |
| **Where does the outcome go in ERPNext?** | Nowhere yet, by design. See `FREIGHT_ERPNEXT.md` | This is the largest open item. Needs an hour with whoever owns the ERPNext instance |
| **Are providers already Suppliers in ERPNext?** | Provider records are independent | If yes, they should carry the supplier id so the two stay aligned |
| **Ranking criteria** | Cost 60%, transit 25%, free days 15%, adjustable per comparison | Confirm with the manager; the defaults are a starting point, not a recommendation |
| **Currency policy** | Offers in another currency are flagged unless a rate with a source and date is recorded | Confirm whether a daily rate feed should be pulled, and from where |
| **Who may approve?** | Only the Logistics Operations Manager role | Needs the real list of people and roles, and authentication |

---

## 5. Where the code is

```
src/freight/
  types.ts            the domain model, with provenance built in
  db.ts               SQLite schema (node:sqlite, no native build)
  repo.ts             data access; every company-scoped call takes a Ctx
  session.ts          who is acting (the one function authentication replaces)
  system.ts           the Mailbox Collector, the one non-person identity
  schedule.ts         the in-process collection timer (off unless configured)
  actions.ts          the single mutation boundary, validated with zod
  view.ts             read models for the screens
  files.ts            attachment storage and validation
  domain/             the rules: comparison, email approval, extraction, matching
  parsers/            deterministic text, Excel and PDF readers
  adapters/           mail, mailbox, ERPNext, AI - each with a simulated default
  service/            orchestration: providers, rfq, mail, inbox, collect,
                      connections, compare, erp
  excel/              comparison workbook and import templates
  demo/               the demonstration dataset, built by running the workflow
  ui/                 client state and shared components
src/app/freight/      the screens
src/app/api/freight/  the routes (collect/ is the external scheduler trigger)
src/instrumentation.ts starts the collection timer when the server starts
tests/freight.test.ts business-rule tests
tests/mailbox.test.ts mailbox collection, the collector identity, Graph faked
tests/e2e/freight.spec.ts browser journeys
scripts/journey.mjs   end-to-end HTTP check
```

The operations demo that already existed in this repository is untouched. Its
82 tests still pass, its routes still build, and the freight module keeps its
own store, its own navigation and its own routes.
