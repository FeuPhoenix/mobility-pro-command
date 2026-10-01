# What we are waiting on from the customer

One page, so whoever picks this up does not have to reconstruct it from chat.
Last updated 28 September 2026.

Nothing here blocks a pilot. An approved RFQ can be sent from a person's own
Outlook and replies loaded back in (`docs/FREIGHT_USER_GUIDE.md`, section 4), so
the workflow runs today. These four turn manual steps into automation.

---

> **Updated 29 September.** The samples arrived, and the provider list is off
> the table: the customer said they cannot test using their providers'
> contacts. We do not need it. The rehearsal
> (`docs/FREIGHT_GO_LIVE.md` section I) points every provider at a mailbox we
> control, so the whole workflow runs without anyone else's address.
>
> What is genuinely still theirs: the app registration, their ERPNext, and the
> Teams webhook. None of it blocks a pilot.

## 1. Sample quotations as `.eml` — **received**

**Who:** Hanan. **Status:** 44 real quotations arrived 29 September.

They live outside this repository and must stay there. Measured with
`scripts/extraction-report.mts`; the numbers and what they mean are in
`HANDOFF.md` section 5A. Add a parser test for each new format *before*
changing a regex.

## 2. Microsoft 365: the app registration

**Who:** their Entra administrator. **Status:** mailbox done, registration open.

The test mailbox exists: `rfq.test@mobilityp.com`. What is still needed is an
app registration, because the integration does not sign in as that user:

| Value | Secret? | How it should arrive |
| --- | --- | --- |
| Application (client) ID | No | Any normal message |
| Directory (tenant) ID | No | Any normal message |
| Client secret | **Yes** | Their password manager, or typed straight onto the server |

Plus, on their side:

- Application permissions `Mail.Send` and `Mail.ReadWrite`, **admin consent
  granted**. This is done once in Entra; it is not triggered by us trying to
  connect.
- An **ApplicationAccessPolicy** limiting the app to that one mailbox. Without
  it the app can reach every mailbox in the tenant.
- The secret's **expiry date**, noted somewhere. Email stops the day it lapses.

The mailbox account password is not used and should not be collected. One was
sent over WhatsApp on 28 September and should be reset.

Then follow `docs/FREIGHT_W2_LIVE_TEST.md` and fill in its results table.

## 3. ERPNext

**Who:** their ERPNext team.

Send them `docs/erpnext/` as it stands: importable JSON for both DocTypes and a
field table. Our side is done and verified against a real ERPNext 15.121.4.

One thing their analysts must know before building reports: **Frappe stores an
empty number as 0.** A charge the provider named but never priced is flagged
with `amount_missing`, and unstated figures are listed in `unstated_numbers`.
Reports that read the raw amounts will treat "not quoted" as "free", and the
cheapest-looking offer will be the one missing a price.

Once their instance exists, point `tests/erpnext-instance.test.ts` at it
(a **test** site — it writes records) for a nine-check confirmation.

## 4. Microsoft Teams webhook

**Who:** whoever owns the channel. **Effort:** minutes.

A channel Incoming Webhook URL, then:

```bash
TEAMS_WEBHOOK_URL='https://...' npm run n8n:provision
```

Without it the three notification nodes stay placeholders, which is how the
committed workflows ship.

---

## Still open, lower priority

- Are freight providers already Suppliers in ERPNext? (Decides `--supplier-link`.)
- The real people with their roles and companies. (The provider list is no
  longer expected for testing; it will be needed at go-live, to send to real
  providers rather than to ourselves.)
- Ranking weights, the FX source, and when response collection closes.
- Where it will live permanently. **They have no Azure subscription**
  (confirmed 1 October), so this is a server of theirs, a VM we run, or a
  managed host. Their ERPNext administrator probably knows what they already
  have. A pilot instance runs on the build machine
  now (`docs/FREIGHT_GO_LIVE.md` section H); section F is what a real
  deployment needs.
