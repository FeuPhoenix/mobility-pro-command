# The week: who does what

**Target: a working background pipeline in under a week.** Written 1 October
2026 for the people taking this on while Amr is unavailable.

Read `HANDOFF.md` first, then `PLAN_BACKGROUND_PIPELINE.md` for the design
behind workstreams A, B and C. This file is only the division of work.

---

## What "done" means this week

A file from Hanan lands, requests go out after a manager approves them **by
replying to an email**, providers who stay silent are chased after two days,
replies come back and are compared. Running somewhere that does not depend on
one laptop being open.

Provider discovery (workstream B) is **not** in this week beyond groundwork.
It needs a search API that nobody has chosen or paid for.

## Before anyone starts

- [ ] **Make the repository private.** Settings, Danger Zone, Change
      visibility. Their rates and provider list must not land in a public
      history.
- [ ] Read the five guarantees in `PLAN_BACKGROUND_PIPELINE.md` section 3.
      Everything below is subordinate to them.
- [ ] `npm ci && npm test` must be green before you change anything. 454 tests,
      9 skipped.

---

## Person 1 — approval by email

**This is the critical path. Nothing else about "no screen" works without it.**

Design and security model: `PLAN_BACKGROUND_PIPELINE.md` section 4. Read it in
full before writing code; the security model is most of the work.

| Day | Work |
| --- | --- |
| 1 | `domain/approvalReply.ts`: the token, reading intent from a reply. Pure functions, tests first. |
| 2 | `service/approvalByEmail.ts`: send the request, handle the reply. Hook into `ingestMessage()` **before** quotation matching. |
| 3 | The four refusals, each with a test: wrong sender, bad token, replayed token, content changed since the request. |

**Done when** `tests/approval-by-email.test.ts` covers an approval, a rejection
and all four refusals, and a reply from an unknown address is visible to a
person rather than silently dropped.

**Keep in mind:** the customer runs this with essentially one role, the manager.
Do not build an approval chain. One named person approves; that is the whole
model.

## Person 2 — the file pipeline, then hosting

| Day | Work |
| --- | --- |
| 1 | Turn on `RFQ_EMAIL_INTAKE`, point it at the mailbox, walk a real file from Hanan's format through `parseRequestSheet` end to end. Fix what the real file breaks. |
| 2 | The n8n workflow that joins it up: file in, requests created, providers selected, emails prepared, approval requested. |
| 3–4 | **Hosting.** See below. |

### Hosting, which is this week's other must

Today the pilot runs in Docker on one laptop. That is fine while it is Amr's
laptop and it is open; it is not fine as the answer to "where does this live".

The application is already a container with its storage on a volume
(`Dockerfile`, `docker-compose.yml`), so moving it is configuration, not a
rewrite. Price and write up **three options**, with the numbers:

**The customer has no Azure subscription**, confirmed 1 October. Microsoft 365
is not Azure: their mailboxes and Entra identities live there, but there is no
place to run a container. So the three to price are:

1. **A server they already own**, on their premises or wherever their ERPNext
   runs. Best for them: their commercial data never leaves their estate, and
   they own it at handover. Ask their ERPNext administrator what that box is -
   if ERPNext is self-hosted, the answer may already exist.
2. **A small VM we run** (Hetzner, DigitalOcean, Linode). Hours to stand up, a
   few dollars a month, and it puts their rates and provider list on our
   infrastructure - a conversation to have deliberately, not by default.
3. **A managed container host with a disk** (Fly, Render). Quickest, but check
   the persistent volume carefully: this application needs a real filesystem
   and **will not run on read-only serverless**.

If they later open an Azure subscription, option 1 moves there unchanged. It is
a container with its storage on a volume; nothing about this decision is
permanent.

**Do not buy anything without Amr's authorisation.** Bring the three numbers.

**Done when** the pipeline runs somewhere that survives a laptop closing, with
`scripts/backup.mjs` scheduled and one restore tested with
`scripts/restore.mjs --check`.

## Person 3 — extraction, and groundwork for discovery

| Day | Work |
| --- | --- |
| 1–3 | **Extraction against the 44 real samples.** Base freight is at 48%. The method and the scorecard are in `HANDOFF.md` section 5A. |
| 4–5 | The discovery **adapter shape** only: interface, simulated default, candidates table, the accept/discard path. No live search, no network. |

**The rule that matters for extraction:** check every figure against its source
line before trusting a percentage. Three of twenty-one rates were wrong the
first time the numbers looked good - a container count, a reference number, and
our own target rate quoted back in a thread. A wrong rate reaches the
comparison; a missing one is shown to a person.

**The rule that matters for discovery:** no code path emails a candidate. Write
the test that proves it before you write anything else.

## Amr, while away

- Choose the search API and the budget. Nothing in workstream B can start
  without it.
- Decide hosting once Person 2 brings the three options.
- Answer the four questions at the end of `PLAN_BACKGROUND_PIPELINE.md`.

---

## Order, if the week slips

Cut from the bottom:

1. Approval by email **(cannot be cut, nothing works without it)**
2. The file pipeline
3. Hosting off the laptop
4. Extraction accuracy
5. Discovery groundwork **(cut first)**

## What not to do, however tight the week gets

- Do not let automation send anything. It prepares; a person sends.
- Do not relax the plausibility checks on extraction to make a percentage look
  better. A wrong rate is worse than a missing one.
- Do not email a discovered provider. A person accepts them into the list first.
- Do not put real rates, real provider addresses or `.eml` samples in the
  repository, private or not. `.gitignore` already refuses them by shape.
- Do not test with a real provider's address. Point every rehearsal at a mailbox
  we control; `scripts/rehearsal.mjs` does this.

## Where to look when something breaks

| Symptom | Start at |
| --- | --- |
| A quotation will not parse | `HANDOFF.md` section 5A, then `scripts/extraction-report.mts` |
| Something works locally, not deployed | The container does not follow `main`. `docker compose up -d --build` |
| Tests behave differently to the app | `.env.local` is read by both. `HANDOFF.md` section 7 |
| ERPNext refuses a write | `docs/FREIGHT_ERPNEXT.md`, and `tests/erpnext-instance.test.ts` against a test site |
| A workflow does nothing | It is exported inactive on purpose. Check the error branch in Teams |
