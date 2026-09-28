# Freight RFQ — guide for the logistics team

How to use the workspace day to day. For setting it up, see
`FREIGHT_SETUP.md`; this guide assumes it is running and you can sign in.

**The one rule to remember:** the system prepares, checks and recommends. It
never sends an email you have not approved, and it never chooses, negotiates
or books a provider. Those stay with you.

---

## Who can do what

| Role | Can |
| --- | --- |
| **Logistics Operations Manager** | Everything, including approving email, closing collection, and managing people and settings |
| **Logistics Coordinator** | Prepare requests, choose providers, check quotations, build comparisons. Cannot approve an email |
| **Viewer** | Read only |

You only ever see the companies you have been given.

## 1. Sign in

Open the address you were given and **Sign in with Microsoft** (or with your
email and password, depending on how it was set up). If you are refused, ask a
manager to add you on **Settings → People**.

## 2. Keep provider lists up to date — Providers

- Each company has its own list. A provider can be **Active**, **Under
  contract**, **Excluded** or **Prospect**. Only *Active* providers can be sent
  a request; the others are blocked, with the reason shown.
- Add providers one by one, or import a spreadsheet (download the template,
  fill it in, upload it). Nothing is written until you have seen the report of
  what will be added and what has a problem.
- Record the lanes each provider serves. The request screen marks providers
  that serve its lane.

## 3. Raise a request — Requests → New

- Fill in the shipment: company, title, route, Incoterm, container lines,
  shipping window, reply-by deadline, currency and any instructions.
- Or **Import a filled-in template**: download it with *Prefer a spreadsheet?*,
  fill it in, import it. It fills the form for you to check; nothing is created
  until you press create.
- (If switched on) colleagues can also email the freight mailbox with *New
  RFQ* in the subject. That creates a draft; anything it could not read is
  listed on **Replies** with the reasons.

## 4. Choose providers and send

- On the request, choose who receives it. Blocked providers cannot be ticked.
  (If *pre-select providers that serve the lane* is on, those are ticked for
  you to review.)
- **Prepare the emails.** Each provider gets their own email; none sees the
  others.
- A **manager approves** each email. If anyone edits an approved email, the
  approval is withdrawn automatically and it needs approving again.
- Then **Send**.

## 5. Replies — Replies

- Replies are collected from the freight mailbox automatically (or press
  **Collect now**). A reply that quotes the RFQ reference, or answers the
  original email, is attached to its request by itself.
- Anything the system is not sure about waits under **Needs a person**, with
  the candidates it considered. Pick the right request; it is never guessed.
- You can also load saved `.eml` files with **Load .eml files**.

## 6. Check the quotations

- Each quotation is shown beside the original email or attachment. Every
  figure shows where it came from and how sure the reader was.
- **A missing charge is left blank, never zero**, and that offer stays out of
  the comparison until someone fills it in — otherwise an incomplete offer
  would look cheapest.
- Correct anything read wrongly (your correction is kept), then **confirm** it.
  Only confirmed quotations are compared or sent to ERPNext.
- A revised quotation from the same provider becomes a new version; the old
  one is kept.

## 7. Compare and recommend

- When collection is closed (a manager closes it, or — if switched on — it
  closes at the deadline), build the **comparison**.
- It shows the **cheapest** offer and the **recommended** one separately, with
  the reasons and the trade-off in words. The weights (cost, transit time, free
  days) are visible and adjustable.
- Offers in another currency need a recorded exchange rate (with its source and
  date) before they can be ranked. Offers on a different container basis are
  not ranked against the request.
- The recommendation is advice. **Choosing, negotiating and booking stay with
  you.**

## 8. Tell the manager and record it

- **Prepare the comparison email**: a summary, the recommendation, the caveats
  and the Excel workbook. It needs approval like any other email.
- **Record** sends the checked quotations to ERPNext, one record per version.
  If it fails it says why and can be retried safely; it never creates a
  duplicate.

## Good to know

- Everything you do is in the activity log, including what the automatic
  processes did, under their own names.
- A **Demo data** badge means the workspace holds fictional data: nothing in it
  is real, and its addresses cannot receive email.
- If something is read wrongly again and again for one provider, tell whoever
  looks after the system and send them an example `.eml`.
