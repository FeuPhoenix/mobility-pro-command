# n8n integration outline

**Status: designed, not connected.** The application ships one adapter —
`DemoN8nAdapter` — which reads local workflow definitions and makes no network request.
The UI displays **"n8n demo adapter"** and must never display "Connected to n8n" unless a
probe against a configured instance has actually succeeded.

The seven workflow exports under `public/n8n/` are real and importable. They are a
starting point for the client's own instance, not something this demo drives.

---

## 1. The division of labour

This is the decision that matters, and it should be settled before anyone builds.

| | Owned by **Mobility Pro Command** | Owned by **n8n** |
| --- | --- | --- |
| Deciding a document disagrees with a purchase order | ✅ | |
| Fetching that document from a mailbox | | ✅ |
| Deciding a lot has aged past the threshold | ✅ | |
| Reading stock and sales out of ERPNext | | ✅ |
| Deciding an order cannot be released under CR-4.2 | ✅ | |
| Telling finance about it on Slack | | ✅ |
| Deciding an approval has gone stale | ✅ | |
| Reminding the approver it is waiting | | ✅ |
| Composing the supplier clarification | ✅ (a person edits it) | |
| Delivering it and chasing a reply | | ✅ |

**Rules live in the application** because they are deterministic, versioned with the code,
and covered by tests. Change a threshold and a test tells you what moved.

**I/O lives in n8n** because it changes often, it is where credentials belong, and the
client's own team can edit it without waiting on a deployment.

The failure mode to avoid is putting business rules inside n8n nodes. Thresholds scattered
across a dozen workflows are untestable, invisible to the people who own the policy, and
impossible to reconcile when two workflows disagree.

---

## 2. The seam

### n8n calls into the application

Every endpoint is deliberately narrow: a workflow supplies **observations**, the
application applies the rules and returns a **verdict**. None of them lets a workflow set
a state directly.

| Method | Path | n8n sends | The app does |
| --- | --- | --- | --- |
| POST | `/api/automation/document-received` | A supplier document plus extracted fields | Validates against the referenced PO under the import SOP, returns blocking and advisory mismatches. **Does not open a case.** |
| POST | `/api/automation/stock-snapshot` | Stock, lot ages, trailing shipped volume | Applies `INV-AGE-180` and the imbalance rule, returns newly raised opportunities |
| POST | `/api/automation/master-sync` | Reference-data and receivables deltas with an idempotency key | Upserts customers, items, warehouses, price lists, open invoices |
| GET | `/api/automation/approvals` | — | Returns pending requests with age and approver. **Read-only** |
| GET | `/api/automation/briefing` | — | Returns the ranked exception queue and the day's measures |
| POST | `/api/automation/case-event` | An outcome to record on a case | Appends to the activity trail. **Cannot change case status** |

**All six are `designed`, not `implemented`.** They are specified here and reflected in the
exported workflows so the shape can be reviewed, but the demo does not expose them.

### The application fires out to n8n

| Event | Fired when | Consumed by |
| --- | --- | --- |
| `clarification.approved` | A person records a clarification draft as sent | `supplier-clarification-dispatch` |
| `order.held` | A credit check withholds automatic release | `credit-hold-notifier` |
| `approval.requested` | An approval request is raised | `approval-chaser` |
| `approval.decided` | An approver approves or rejects | `credit-hold-notifier` |

---

## 3. The workflows

All seven are importable from `public/n8n/` and visible in the app under **Automations**.

| Workflow | Trigger | What it does | Guardrail |
| --- | --- | --- | --- |
| `supplier-document-intake` | New email with attachment | Reads the supplier document, extracts fields, posts them for checking, notifies procurement if blocking | Never opens a case; never contacts the supplier |
| `supplier-clarification-dispatch` | Webhook `clarification.approved` | Sends the approved draft, logs it, chases after 72h | Only ever sends text a person approved; cannot compose or alter it |
| `aging-stock-sweep` | Daily 06:00 Africa/Cairo | Pulls stock and trailing sales from ERPNext, asks the app to re-evaluate ageing | Never prices, discounts, transfers or reserves |
| `credit-hold-notifier` | Webhook `order.held` | Assembles the receivables evidence and routes it by reason | Cannot approve, release, or change a credit limit |
| `approval-chaser` | Every 4 hours | Reminds approvers, escalates after 24h | Cannot decide, withdraw or expire an approval |
| `erpnext-master-sync` | Hourly | Pulls reference data and receivables deltas | Read-only against ERPNext |
| `daily-briefing` | Daily 07:00 Africa/Cairo | Posts the briefing to the channel and to each owner | Delivers what the app produced; does not re-rank or editorialise |

### Importing them

1. In n8n: **Workflows → Import from File**.
2. Set these instance variables (Settings → Variables):
   - `MPC_BASE_URL` — where this application runs
   - `ERPNEXT_BASE_URL` — the ERPNext site
   - `EXTRACTION_URL` — the document-extraction service, once chosen
   - `COMMERCIAL_DIRECTOR_EMAIL`
3. Attach credentials to the IMAP, Slack, SMTP and HTTP nodes. **No credential is embedded
   in the exports.**
4. Every workflow imports with `active: false`. Review before enabling.

---

## 4. Sequencing

**Phase 0 — decide the division of labour.** Confirm section 1 with the client's team.
If they want rules inside n8n instead, that is a different architecture and worth saying so
before anything is built.

**Phase 1 — read-only observation.** `erpnext-master-sync` and `aging-stock-sweep` in dry
run, writing nowhere. Compare what the rules produce against what the team already knows.
Expect this to take longer than building the workflows.

**Phase 2 — notification only.** `credit-hold-notifier`, `approval-chaser`,
`daily-briefing`. These only ever carry information to a person. Lowest risk, and the
fastest way to prove value.

**Phase 3 — outbound messages.** `supplier-clarification-dispatch`. First time the system
talks to an outside party, so it needs a named sending mailbox, a retention decision and an
agreed approval step.

**Phase 4 — document intake.** `supplier-document-intake` depends on an extraction service
that has been tested against the client's *actual* supplier document formats. Accuracy
claims should not be made before that.

---

## 5. Failure modes to design for

| Failure | Handling |
| --- | --- |
| Duplicate execution | Every write carries an application-generated idempotency key; a repeat returns the original result |
| n8n unreachable | The app degrades to manual: exceptions still appear, nothing is auto-delivered. Never queue silently |
| The app unreachable | Workflows fail loudly to an error workflow; no partial write, no blind retry on a POST |
| Stale reads | Every synced figure carries its freshness. A figure with unknown freshness is not shown |
| A workflow edited by the client | Expected and fine — but a workflow that starts applying its own thresholds has broken the contract in section 1 |
| Credential expiry | Surfaced as a failed run on the Automations screen, not swallowed |

---

## 6. Open discovery questions

**The n8n instance**
1. Self-hosted or n8n Cloud? Which version?
2. Who owns and maintains it — the client's team, or us?
3. Is there a non-production instance to develop against?
4. How are credentials managed today, and who can see them?

**Messaging**
5. Slack, Teams, or email only? Which channels, and who is in them?
6. Which mailbox should supplier clarifications be sent from, and who monitors replies?
7. What retention and audit requirements apply to automated outbound messages?

**Document intake**
8. How do supplier documents arrive today — a shared mailbox, a portal, WhatsApp?
9. How many suppliers, and how consistent are their document formats?
10. Is there an existing extraction tool, or is that a decision still to make?

**Process**
11. Which of these seven workflows would the client actually turn on first?
12. Who is allowed to edit a live workflow, and is there a review step?
13. What currently happens when a supplier does not reply — is 72 hours the right window?
14. Is there an existing automation estate this has to coexist with?

---

## 7. What this demo does not claim

- It has never connected to an n8n instance.
- No workflow here has executed. Every run on the Automations screen is invented and
  flagged `simulated`.
- The six inbound endpoints are specified, not implemented.
- "Simulate a run" evaluates what a workflow *would* find in the current demo data. It
  contacts nothing and sends nothing.
