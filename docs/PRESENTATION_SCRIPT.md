# Mobility Pro Command — five-minute presentation script

**Before you start:** `npm run dev`, open `http://localhost:4310`, and click
**Reset demo** at the bottom of the navigation rail so the scenario is in its original
state. Keep the window at 1440px or wider.

Total running time: about five minutes at a normal speaking pace. Timings are cumulative.

---

## 0:00 — Open on the work, not on a login (30s)

> "This is Mobility Pro Command. It sits alongside ERPNext — ERPNext stays the system of
> record — and it's where the decisions that ERPNext doesn't make for you actually get
> made.
>
> Notice what it opens on. Not a login, not a chart. Four things: what needs attention,
> what's at stake, who owns it, and what the next action is."

Point at the briefing headline, then the exception queue.

> "Every row names the rule that raised it — these aren't AI hunches, they're your
> policies. And look at the right-hand column: purchase value exposed, receivables at
> risk, inventory carrying value, gross profit. Four *different* measures. We never add
> them together, because they're not the same kind of money."

Point at the **Demo data** chip and the **ERPNext demo adapter** note in the rail.

> "Everything you're about to see is a fictional dataset. It says so, permanently, in two
> places. Nothing here is connected to a live system."

---

## 0:30 — Journey A: the document that doesn't match (1m 45s)

Click **Review the document and open a discrepancy case** on the top row.

> "A pro forma invoice arrived from a Thai supplier against purchase order 2026-0418.
> Receiving is being held — and here's exactly why."

Point at the red banner.

> "Four blocking differences. Line 1 is quoted at 18-ply when we ordered 16. The quantity
> is 600 against 640. Line 2's unit price is four dollars fifty over. And the payment
> terms have quietly moved from *against copy bill of lading* to *at sight* — which is a
> finance problem, not a procurement one."

Point at the right-hand panel.

> "On the right is the document as it arrived. The offending lines are flagged in place.
> Click any page reference on the left and it jumps to that line in the document — so you
> can always get from a number back to where it came from."

Click a page reference to demonstrate, then scroll to **Cross-document check**.

> "This is the part people like. The packing list says 640 — it agrees with our order. So
> the goods were probably packed correctly and the *invoice* is wrong. That's a different
> conversation with the supplier than 'you shipped us short'."

Click **Correct** on the ply rating, change it to `16PR`, save.

> "If the extraction read something wrong, correct it — and the comparison, the blocking
> count and the shipment's readiness all recalculate on the server, not in the browser."

Change it back to `18PR`. Click **Create discrepancy case**, then **Generate draft**.

> "The case groups the differences and holds receiving. The clarification is drafted for
> you with every point and the ordered value beside it — and it's fully editable. Nothing
> is sent. There's no email account connected to this demo, and it says so."

Click **Record as sent**, then **Simulate receipt of a corrected document**, then
**Re-run validation and close the case**.

> "Supplier sends a revision. We re-validate. Blocking count drops to zero, receiving
> readiness releases — and notice the one advisory difference survives, because the
> supplier still describes line 3 slightly differently. That's recorded, not hidden.
>
> And read the small print: readiness released does *not* mean the goods arrived, were
> counted, or that payment is approved. Those are separate steps and we don't pretend
> otherwise."

---

## 2:15 — Journey B: aging stock (1m 30s)

Rail → **Inventory** → **Compare scenarios** on the open opportunity.

> "Different problem. 812 pieces of 265/70R16 have been sitting at Obour for 215 days,
> and shipped volume has fallen from 157 a month to 56. That's two and a half million
> pounds of cash sitting still."

Point at **What we actually know**.

> "Facts first. Stock by location, ages, weighted landed cost, real shipped rates."

Point at **Recommended action**, then at the amber band.

> "Then the recommendation — with the evidence under it, and, more importantly, an
> explicit statement of what it *cannot* tell you. It can't tell you a discount will
> produce volume. It can't tell you the destination of a transfer has demand. We'd rather
> say that than dress a guess up as analysis."

Scroll to **Scenario comparison**. Click through **5% → 8% → 10%**.

> "Hold, transfer, or discount. The green block is arithmetic — price, revenue, cost of
> goods, gross profit, margin, remaining stock, collection date. Change the quantity or
> the discount and it recalculates exactly.
>
> The amber block is assumption. How many units actually move."

Change **Uplift assumption** to `20`.

> "Watch: the assumed rate moves. The gross profit does not. That separation is the whole
> point — your finance director can argue with the assumption without anyone arguing
> about the arithmetic."

Scroll to **Who has bought this SKU** on the right.

> "Suggested customers are ranked on what they actually bought, with the evidence shown —
> and flagged if they're overdue."

Set discount back to **8%**, customer **Nile Fleet Services**, click
**Prepare proposed order**.

---

## 3:45 — The block, and the decision (1m)

> "And here's the moment that matters. Stock is available — the check passes. The credit
> limit has room — that check passes too. But an invoice is 52 days past due, and policy
> clause CR-4.2 withholds automatic release.
>
> That is a *real* exception. Not a score. Not a risk rating. A named clause, with the
> arithmetic shown underneath it."

Point at the exposure build-up.

> "Exposure is defined: open receivables, plus approved undelivered orders. Draft orders
> don't count. Everyone can see how the number was built."

Point at the three options.

> "Three ways forward, each with its policy clause: a thirty-percent deposit, a partial
> release inside the remaining headroom, or a finance review with a dated commitment.
> Each one is costed."

Select the deposit option, add a note, click **Request approval**.

> "Notice I can't approve my own request. I'm acting as supply planning; this routes to
> the Finance Director and the button is disabled for me. That's enforced on the server,
> not just hidden in the UI."

Switch **Acting as** to **Samir Ghali — Finance Director**, click **Approve**.

> "Approved. Now watch what actually changed."

Rail → **Inventory**.

> "Available stock at Obour dropped from 812 to 392. The reservation exists."

Rail → **Customers** → **Nile Fleet Services**.

> "Exposure went up by the order value. Receivables did *not* move — because approving an
> order doesn't collect any cash. Nothing in this system recognises revenue for a decision
> that hasn't been delivered or invoiced."

---

## 4:45 — The assistant, and close (45s)

Click **Assistant** in the top bar, then **Why can't this order be released?**

> "The assistant knows what you're looking at. And look at how it answers: observed
> facts, then the calculation with the arithmetic shown, then the assumptions, then a
> recommendation. Four separate bands, so you always know which kind of statement you're
> reading. Every record it mentions is a link.
>
> It's labelled *simulated* — it's deterministic rules over this dataset, and if you ask
> it something it can't answer, it says so rather than inventing a number."

Optionally ask: *"What will the tyre market do next quarter?"* to show the limitation.

> "So: an exception you can trace to its source, a recommendation you can argue with, an
> assumption you can change, a decision that's properly authorised, and consequences that
> land consistently across stock, credit and the audit trail.
>
> That's the shape of it. What we'd want next is a read-only connection to your ERPNext
> so this runs against your real purchase orders and receivables — and a conversation
> about which of your actual policies should drive these rules."

---

## If someone asks…

**"Is this reading our real documents?"**
> No. The sample documents ship with their fields pre-extracted, and the app labels that
> as simulated everywhere it appears. Real extraction is a separate piece of work, and
> we'd want to test it against your actual supplier document formats before promising
> anything about accuracy.

**"Is it connected to our ERPNext?"**
> No, and it will never say it is unless connectivity has actually been verified. There's
> a clean adapter boundary and a documented mapping proposal; the first live step would be
> read-only.

**"Where did these rules come from?"**
> They're fictional, written for this demo, and every one of them is visible in the app
> with an identifier. The real exercise is replacing them with yours.

**"Can I break it?"**
> Please try. Duplicate approvals, over-ordering, discounting below cost, approving with
> the wrong role, changing an order after it's been approved — they're all refused with an
> explanation. **Reset demo** puts everything back.
