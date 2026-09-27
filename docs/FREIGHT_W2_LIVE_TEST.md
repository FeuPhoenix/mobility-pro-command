# W2 — First live test of Microsoft Graph email

A checklist for the first time the freight module sends and collects real
email. Work through it in order, on a test mailbox, and record each result in
the table at the end. Nothing here needs code changes; everything needed is in
`dev`.

**Who does what.** Steps 1–2 need a Microsoft 365 administrator. Steps 3 onward
need whoever runs the server. Secrets go into `.env.local` on the server by
hand; they are never pasted into the application or committed.

---

## 0. What you need

- **A test sending mailbox** in your tenant, e.g. `freight-test@yourdomain.com`.
  A shared mailbox is fine and needs no licence.
- **A second mailbox you can read, outside that one**, to play the provider.
  A personal Outlook.com or Gmail address works well: it proves delivery to an
  external domain.
- Node 22.5 or later on the server, and a checkout of `dev`.

Do **not** use a mailbox that real providers write to. Collection reads every
message in the Inbox, and anything it does not recognise goes to the review
queue.

## 1. App registration (Entra ID, administrator)

1. **Entra admin centre → App registrations → New registration.** Name it e.g.
   *Mobility Pro Freight RFQ*. Single tenant. No redirect URI.
2. **API permissions → Add → Microsoft Graph → Application permissions:**
   `Mail.Send` and `Mail.ReadWrite`. Nothing else is needed. In particular
   `User.Read.All` is **not** needed.
3. **Grant admin consent.** Both rows must show a green tick.
4. **Certificates & secrets → New client secret.** Copy the value now; it is
   shown once. Note its expiry date; sending stops the day it expires.
5. From **Overview**, note the *Directory (tenant) ID* and *Application
   (client) ID*.

## 2. Limit the app to the one mailbox (Exchange Online, administrator)

Application permissions reach every mailbox in the tenant until they are
scoped. Scope them before the secret is used anywhere.

```powershell
Connect-ExchangeOnline

# A mail-enabled security group containing only the freight mailbox
New-DistributionGroup -Name "Freight RFQ app scope" -Type Security `
  -PrimarySmtpAddress freight-rfq-scope@yourdomain.com
Add-DistributionGroupMember -Identity freight-rfq-scope@yourdomain.com `
  -Member freight-test@yourdomain.com

New-ApplicationAccessPolicy -AppId <client-id> `
  -PolicyScopeGroupId freight-rfq-scope@yourdomain.com `
  -AccessRight RestrictAccess -Description "Mobility Pro freight RFQ"

# Must say Granted for the freight mailbox and Denied for anyone else
Test-ApplicationAccessPolicy -Identity freight-test@yourdomain.com -AppId <client-id>
Test-ApplicationAccessPolicy -Identity someone.else@yourdomain.com -AppId <client-id>
```

The policy can take up to an hour to apply. Microsoft now also offers *RBAC
for Applications* in Exchange Online as the newer way to scope an app; either
is fine, as long as the test above shows *Denied* for a mailbox outside scope.

## 3. Configure the server

Create or edit `.env.local` in the project folder:

```
MAIL_ADAPTER=graph
MAILBOX_ADAPTER=graph
GRAPH_TENANT_ID=<tenant-id>
GRAPH_CLIENT_ID=<client-id>
GRAPH_CLIENT_SECRET=<secret-value>
GRAPH_MAILBOX=freight-test@yourdomain.com
```

Restart the server (`npm run build && npm start`, or `npm run dev`).

## 4. Check both connections

**Settings → Connections.** Press **Check connection** on *Outgoing email*
and on *Incoming email*.

| Expected | If not |
| --- | --- |
| Both say **Connected** | `401`/`invalid_client`: wrong ID or secret. `403 ErrorAccessDenied`: consent not granted, or the access policy has not applied yet (wait, then check again). `404`: the mailbox address is wrong |

"Connected" proves the credentials and the mailbox scope. It does not prove
permission to *send*; step 6 does.

## 5. Set up a test request

Use your own records, not the demonstration dataset: its addresses end in
`.test`, which cannot receive mail, and a live send to one is now refused with
a clear message rather than attempted.

1. **Providers:** add a company, then a provider whose primary contact is the
   second mailbox from step 0.
2. **Requests → New:** create an RFQ, select that provider, prepare the email.
3. **Emails:** open it. Edit the subject once *after* approving to confirm the
   approval is revoked. Approve again, as the Logistics Operations Manager.

## 6. Send it

Press **Send**.

| Check | Expected |
| --- | --- |
| The toast | Does **not** say simulated |
| The email in the app | Status *Sent*, not marked simulated |
| The second mailbox | The RFQ arrives, with any attachment intact |
| Sent Items in the freight mailbox | One copy. Drafts: empty |
| Activity log | *Sent the RFQ … to …*, not *Simulated send* |

## 7. Reply and collect

From the second mailbox, **reply** to the RFQ email. Change the subject so it
no longer contains the RFQ reference, and write:

```
Base ocean freight: USD 1450.00 per 40HC
Transit time: 28 days
Free days at destination: 7
Valid until: 2099-12-31
```

Then **Replies → Collect now**.

| Check | Expected |
| --- | --- |
| Result | *Collected 1 new reply: 1 matched* |
| The reply | Attached to the RFQ, with the basis *Replied on the same email conversation as the RFQ that was sent* — matched by thread, not by the reference |
| The quotation | Base freight 1450, waiting to be checked |
| **Collect now** again | *No new replies*; nothing duplicated |

Then send a message to the freight mailbox from an address the workspace does
not know. **Collect now** should put it in **Replies** under *Needs a person*.

## 8. Leave it running (optional)

Set `MAILBOX_POLL_SECONDS=120` in `.env.local`, restart, and reply once more.
Within two minutes it appears without pressing anything, and Settings shows
the last run as *schedule*.

---

## Results

| Step | Date | Result | Notes |
| --- | --- | --- | --- |
| 2 · Access policy test: Granted / Denied | | | |
| 4 · Outgoing connection check | | | |
| 4 · Incoming connection check | | | |
| 6 · RFQ received externally | | | |
| 6 · One copy in Sent Items, no drafts left | | | |
| 7 · Reply matched by thread, not reference | | | |
| 7 · Second collection, no duplicate | | | |
| 7 · Unknown sender in the review queue | | | |
| 8 · Scheduled collection | | | |

When every row passes, W2 is done: update *Written but not verified* in
`FREIGHT_HANDOVER.md` and the *Not verified live* notes in `FREIGHT_SETUP.md`.

## If something goes wrong

- **A send says it is not known whether Graph sent the message.** The
  connection dropped after the send request left. Look in Sent Items before
  pressing Send again, or the provider receives two copies.
- **To stop all live email immediately:** set `MAIL_ADAPTER=simulated` and
  `MAILBOX_ADAPTER=simulated`, restart. For a hard stop, delete the client
  secret in Entra.
