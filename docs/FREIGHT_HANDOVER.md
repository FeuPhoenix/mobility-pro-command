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
| Company isolation | Enforced server-side on every read and write |
| Demonstration dataset | Built by running the real workflow, not by inserting finished rows |

### Simulated — clearly labelled as such in the UI

| Part | What actually happens |
| --- | --- |
| Outgoing email | Prepared, approved and recorded exactly as in production, but nothing is transmitted. Marked "Simulated" on every sent email |
| Inbound mail | The demonstration dataset feeds replies through the real collection pipeline. No mailbox is polled |
| ERPNext | Recorded locally, stored as `adapter: 'simulated'`, rendered as *"Simulated, not in ERPNext"*. It can never be read back as a live write |
| One ERPNext failure | The demo deliberately fails the first attempt so the retry path is a real failure and a real recovery |

### Written but not verified against a live service

Each of these is complete code behind an adapter boundary. None could be
exercised from this environment, and none is claimed as working.

| Integration | What is missing to verify it |
| --- | --- |
| Microsoft Graph `sendMail` | An Entra app registration with `Mail.Send` and admin consent |
| ERPNext write | A reachable instance **and** an agreed destination DocType |
| Anthropic prose fallback | An API key; deliberately not used, since paid usage was not authorised |

### Not built in this phase

- Scheduled inbound mail collection (poll or webhook). The matching, extraction
  and review code is complete and exercised; only the trigger is missing.
- Authentication. See the honest statement in `FREIGHT_SETUP.md`.
- Everything explicitly out of scope: shipment tracking, vessel positions,
  arrival prediction, provider discovery, WhatsApp/WeChat, negotiation,
  booking, a data warehouse.

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
| `npm test` | **118 passed** (82 pre-existing, 36 new freight) |
| `npm run test:e2e` | **9 passed** (browser, real Chrome) |
| `node scripts/journey.mjs` | **54 passed** over HTTP against a running server |
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
  actions.ts          the single mutation boundary, validated with zod
  view.ts             read models for the screens
  files.ts            attachment storage and validation
  domain/             the rules: comparison, email approval, extraction, matching
  parsers/            deterministic text, Excel and PDF readers
  adapters/           mail, ERPNext, AI - each with a simulated default
  service/            orchestration: providers, rfq, mail, inbox, compare, erp
  excel/              comparison workbook and import templates
  demo/               the demonstration dataset, built by running the workflow
  ui/                 client state and shared components
src/app/freight/      the screens
src/app/api/freight/  the routes
tests/freight.test.ts business-rule tests
tests/e2e/freight.spec.ts browser journeys
scripts/journey.mjs   end-to-end HTTP check
```

The operations demo that already existed in this repository is untouched. Its
82 tests still pass, its routes still build, and the freight module keeps its
own store, its own navigation and its own routes.
