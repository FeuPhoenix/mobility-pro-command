# Plan: the background pipeline

**For whoever picks this up.** Written 1 October 2026, after the customer
review, by the person who built what exists today and is now unavailable.

The customer described what they want more precisely in that review, and it is
not quite what we demonstrated. This plan says what changes, what does not, and
in what order to do it.

Read `HANDOFF.md` first if you have not. This file assumes it.

---

## 1. What the customer actually asked for

In their words, assembled from the review:

- A **background process**, with little or no screen
- It receives **a file of RFQs** from Hanan. That file is the only way a request
  starts
- It reads each line, and for each one **finds further providers on the open
  web**
- It sends the RFQ to them, **after a human approves**, and approval happens
  **by replying to an email**, not on a screen
- It **chases after two days** with no response
- When replies come back it **compares them**, as already demonstrated

## 2. What this changes, and what it does not

Most of it exists. The honest delta is one new capability and a shift of
emphasis.

| What they want | Where we are |
| --- | --- |
| Background process, minimal screen | **Built.** Five n8n workflows and seven token-protected endpoints under `/api/freight/automation/`. The screens are a control surface, not the engine |
| Starts from a file | **Built.** `POST /api/freight/import`, the Excel template at `/api/freight/template/rfq`, and `parseRequestSheet` in `parsers/rfqRequest.ts` |
| Reads each order line | **Built**, same parser |
| Sends only after approval | **Built**, and enforced server-side |
| Chase after two days | **Built**, `domain/chasing.ts`, interval configurable in Settings |
| Comparison | **Built** |
| **Approval by email reply** | **New.** Workstream A |
| **Finding providers on the open web** | **New.** Workstream B. It was explicitly out of scope in the original brief, so nothing exists |

**Do not throw away the screens.** They are how a person reviews a quotation the
parser was unsure about, and how anything is corrected. "Little or no UI" means
the happy path should not need one; it does not mean there is nowhere to look
when something goes wrong.

---

## 3. The guardrails

These do not change, whatever the shape of the pipeline. They are enforced in
the service layer and covered by tests that will fail if you break them.

1. **Nothing sends without an approval**, and the approval is bound to a hash of
   the exact content. Any edit revokes it.
2. **A provider found by a machine is never emailed by a machine.** A person
   accepts it into the list first. This is the whole safety of workstream B.
3. **One email per provider.** No provider sees another's identity or figures.
4. **A missing figure is never a zero**, and is shown to a person.
5. **Automation prepares, people send.** `system_automation` is refused by both
   the approval guard and the send guard.

---

## 4. Workstream A — approval by email

**Goal.** A manager approves an outgoing RFQ by replying to an email, with no
screen involved. Everything else about approval stays as it is.

**Effort.** Two to three days including tests.

### How it should work

1. When an RFQ email is prepared and `APPROVAL_BY_EMAIL=on`, send an approval
   request to the manager. It contains the recipients, subject and full body
   exactly as they will go out, and a **token**.
2. The manager replies `approve` (or `reject`).
3. The collector reads the reply, finds the token, and approves the email as
   that person. Sending then follows the existing path.

### Where the code goes

- `src/freight/domain/approvalReply.ts` — the token, and reading intent out of a
  reply. Pure, no I/O, easy to test.
- `src/freight/service/approvalByEmail.ts` — sending the request, handling the
  reply.
- Hook into `ingestMessage()` in `service/inbox.ts`, **before** quotation
  matching: an approval reply is not a quotation and must not be parsed as one.

### The security model, which is the hard part

An email sender is trivially forged. Treat the reply as evidence, not proof, and
require all four:

1. **The token matches.** Derive it as an HMAC of the email id and its content
   hash, keyed by a server secret (reuse `AUTH_SESSION_SECRET`, or add one).
   Never a sequential id, never guessable.
2. **The sender is a known manager** with access to that company, matched on the
   address, and not disabled.
3. **The content hash still matches.** If anything changed after the request was
   sent, refuse and say so. This falls out of `approvalIsCurrent()`.
4. **The token is single use.** Record that it was spent; a replayed reply does
   nothing.

Refusals are recorded in the audit with the reason. An approval that arrives
from an unknown address is not silently dropped: it appears as something a
person should look at.

**Write this limitation down for the customer in plain words.** Approval by
email is weaker than approval behind a sign-in, because anyone who can forge a
From header and guess a token could approve. The token makes guessing
impractical; forging the sender alone is not enough. If they want strong
approval, it belongs behind sign-in.

### Done when

- A reply saying `approve`, from a manager, with a valid token, sends the email
- The same reply replayed does nothing the second time
- A reply from anyone else is refused and recorded
- An email edited after the request was sent cannot be approved by that reply
- `reject` closes it without sending
- Every one of those has a test in `tests/approval-by-email.test.ts`

---

## 5. Workstream B — finding providers on the open web

**Goal.** For a lane, propose freight providers the customer does not already
have, with contact addresses, for a person to accept or discard.

**Effort.** Four to six days for something honest, plus continuing tuning. This
is the least predictable work in the project.

**The customer confirmed: a human accepts before anything is emailed.** Hold
that line. It is what makes the rest of this acceptable.

### Shape it like every other outside system

Follow `adapters/mail.ts` and `adapters/erpnext.ts` exactly:

- `src/freight/adapters/discovery.ts`, with a `DiscoveryAdapter` interface
- A **simulated adapter as the default**, returning fixed candidates, so tests
  and demonstrations never touch the network
- A live adapter behind configuration, reporting its status honestly: never
  "connected" without a successful probe
- Results are **candidates**, in their own table. They are not providers until a
  person accepts one

### The pipeline

1. Search for the lane and the service, through whichever search API is chosen
2. Fetch each result and pull out company name, country, and any contact address
3. Score and dedupe against providers already on the list, by domain and by name
4. Store as candidates with **where each came from**: the URL, the page title,
   the date fetched. A reviewer must be able to check the source
5. A person accepts, which creates the provider, or discards with a reason

### What will go wrong, so plan for it

- **The addresses are mostly `info@`.** In freight the price lives in the
  account relationship, so expect worse rates from cold contacts than from the
  customer's own list. Say so when you report results, and measure it: track
  how many discovered providers reply at all.
- **Search APIs cost money.** Do not sign up for anything without explicit
  authorisation from the customer. Price it first and put the number in writing.
- **Scraping breaks.** Sites change, block, or rate limit. The adapter must fail
  as a reported status, never as a crash, and never silently return nothing.
- **Robots and terms.** Respect `robots.txt` and rate limits. Identify the
  crawler honestly in the user agent.
- **Personal data.** A named person's address from a contact page is personal
  data. Store the business address, record where it came from, and delete on
  request. If in doubt, prefer the role address over the named one.

### Done when

- The simulated adapter returns candidates and nothing touches the network in
  tests
- A candidate carries its source URL and fetch date, visible to the reviewer
- Accepting one creates a provider; discarding records why
- **No code path exists that emails a candidate.** Write a test that proves it
- Duplicate detection catches the same company by domain and by rough name

---

## 6. Workstream C — the file-driven pipeline

**Goal.** Hanan's file lands, and everything that follows happens without
anyone opening a screen until a decision is needed.

**Effort.** One to two days. Most parts exist; this is joining them.

1. Decide how the file arrives: a watched mailbox is the natural answer, and
   `RFQ_EMAIL_INTAKE` already does it. Turn it on, point it at the mailbox
2. One request per line in the file, as the parser already produces
3. For each: select providers from the existing list, plus any accepted
   candidates from workstream B
4. Prepare the emails, request approval by email (workstream A)
5. The existing chaser handles two days of silence
6. Replies, extraction, comparison as today
7. The daily briefing to Teams reports what is stuck

Most of this is an n8n workflow calling endpoints that already exist. If an
endpoint is missing, add it next to the others in
`src/app/api/freight/automation/` and keep it token-protected.

---

## 7. Order of work

Do them in this order. Each is useful on its own, which matters if priorities
change again.

1. **A, approval by email.** Smallest, unlocks the shape they asked for, and
   nothing else depends on it.
2. **C, the file pipeline.** Mostly joining existing parts. After A, because the
   pipeline needs approval to not require a screen.
3. **B, provider discovery.** Largest, least certain, and the only one with a
   cost and a legal question attached. Get the customer's answer on the search
   API and the budget before starting.

Alongside, continue **extraction accuracy** against the 44 real samples. The
scorecard is `scripts/extraction-report.mts` and the method is in `HANDOFF.md`
section 5A. Check every figure against its source line before trusting a
percentage: three of twenty-one rates were wrong the first time the numbers
looked good.

---

## 8. Ask the customer before building B

1. Which search API, and who pays for it?
2. Should a discovered provider be proposed for acceptance one by one, or in a
   weekly batch?
3. Is there a list of carriers they will not work with, so discovery can exclude
   them?
4. Do they want discovered providers kept apart from their own list in reports,
   so they can see whether discovery is worth anything?

And one for A, now answered: **the customer runs this with one person, the
manager.** Do not build an approval chain or a second approver. One named
person approves, which is also what the guarantees assume.
