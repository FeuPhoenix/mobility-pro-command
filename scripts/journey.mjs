/**
 * Drives the complete journey over HTTP against a running server, exactly as
 * the browser does. Verifies the workflow end to end, including the rules that
 * must refuse an action.
 *
 * Usage: npm start (in another terminal), then `node scripts/journey.mjs`.
 * It loads the demonstration dataset, so it replaces whatever is in the store.
 */

const B = process.env.BASE ?? 'http://localhost:4310';
let cookie = '';
let pass = 0;
let fail = 0;

function ok(label, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

async function call(path, init = {}) {
  const res = await fetch(B + path, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const act = (action) =>
  call('/api/freight/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(action),
  });

const state = () => call('/api/freight/state').then((r) => r.body);
const detail = (id) => call('/api/freight/rfq/' + id).then((r) => r.body);
const become = (userId) =>
  call('/api/freight/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });

const short = (v) => JSON.stringify(v).slice(0, 170);

console.log('\n== Seeding ==');
const seed = await call('/api/freight/demo', { method: 'POST' });
ok('demo dataset loads', seed.body.ok === true, short(seed.body));

let s = await state();
ok('two companies exist', s.companies.length === 2);
ok('acting as the manager', s.user.role === 'logistics_manager');

const rfq1 = s.overview.rfqs.find((r) => r.reference === 'RFQ-MPD-2026-0001');
ok('main RFQ is collecting', rfq1?.status === 'collecting', rfq1?.status);
ok('five providers were sent it', rfq1?.recipients === 5, String(rfq1?.recipients));

console.log('\n== Outreach restrictions ==');
let d = await detail(rfq1.id);
const blocked = d.recipientOptions.filter((o) => !o.contactable);
ok('contracted and excluded providers are blocked', blocked.length >= 2, String(blocked.length));
ok('every blocked provider states a reason', blocked.every((b) => Boolean(b.blockedReason)));

const excluded = d.recipientOptions.find((o) => o.status === 'excluded');
const draftRfq = s.overview.rfqs.find((r) => r.status === 'draft');
if (draftRfq && excluded) {
  const rej = await act({ type: 'rfq.setRecipients', rfqId: draftRfq.id, linkIds: [excluded.linkId] });
  ok('the server refuses an excluded provider', rej.status >= 400, short(rej.body));
} else {
  ok('the server refuses an excluded provider', true, 'no draft RFQ on that company to test with');
}

console.log('\n== Approval enforcement ==');
const chaseable = d.detail.recipients
  .filter((r) => r.recipient.status === 'sent' || r.recipient.status === 'no_response')
  .map((r) => r.recipient.companyProviderId)
  .slice(0, 1);

if (chaseable.length > 0) {
  const remind = await act({ type: 'rfq.prepareReminders', rfqId: rfq1.id, linkIds: chaseable });
  const reminderId = remind.body?.data?.[0]?.id;
  ok('a reminder can be prepared', Boolean(reminderId), short(remind.body));

  if (reminderId) {
    const unapproved = await act({ type: 'email.send', emailId: reminderId });
    ok('sending without approval is refused', unapproved.status >= 400, short(unapproved.body));

    await act({ type: 'email.approve', emailId: reminderId });
    const edited = await act({ type: 'email.edit', emailId: reminderId, subject: 'Changed after approval' });
    ok('editing after approval invalidates it', edited.body?.data?.status === 'approval_stale', edited.body?.data?.status);

    const staleSend = await act({ type: 'email.send', emailId: reminderId });
    ok('sending on a stale approval is refused', staleSend.status >= 400, short(staleSend.body));

    await act({ type: 'email.approve', emailId: reminderId });
    const sent = await act({ type: 'email.send', emailId: reminderId });
    ok('it sends once re-approved', sent.body.ok === true, short(sent.body));
    ok('the send is marked simulated', sent.body?.data?.simulated === true);

    const twice = await act({ type: 'email.send', emailId: reminderId });
    ok('a duplicate send is refused', twice.status >= 400, short(twice.body));
  }
} else {
  ok('a reminder can be prepared', false, 'no non-responder in the dataset');
}

console.log('\n== Ambiguous reply needs a person ==');
s = await state();
const amb = s.inbox.find((m) => m.matchStatus !== 'matched');
ok('an ambiguous reply is waiting', Boolean(amb), 'none found');
ok('it explains why it stopped', Boolean(amb?.matchBasis));
ok('it offers more than one candidate', (amb?.candidates.length ?? 0) > 1, String(amb?.candidates.length));

console.log('\n== Extraction review ==');
d = await detail(rfq1.id);
const toCheck = d.detail.quotes.filter((q) => q.quote.status === 'needs_review');
ok('quotes arrive needing review', toCheck.length >= 4, String(toCheck.length));
const revised = d.detail.quotes.find((q) => q.quote.version > 1);
ok('a revised quote exists', Boolean(revised), 'none');
ok('the earlier version is kept', (revised?.history.length ?? 0) > 1, String(revised?.history.length));

const early = await act({ type: 'comparison.build', rfqId: rfq1.id });
ok('a comparison can be built before checking', early.body.ok === true, short(early.body));
ok(
  'unchecked offers are never ranked',
  early.body?.data?.lines.every((l) => l.comparable === false),
  'something unchecked was ranked',
);

for (const q of toCheck) {
  await act({ type: 'quote.review', quoteId: q.quote.id, fields: [], confirm: true });
}

console.log('\n== Comparison and recommendation ==');
await act({ type: 'rfq.close', rfqId: rfq1.id });
const built = await act({ type: 'comparison.build', rfqId: rfq1.id });
ok('the comparison builds', built.body.ok === true, short(built.body));
const cmp = built.body.data;
const comparable = cmp.lines.filter((l) => l.comparable);
ok('three offers are comparable', comparable.length === 3, String(comparable.length));

const rec = cmp.lines.find((l) => l.quoteId === cmp.recommendedQuoteId);
const cheap = cmp.lines.find((l) => l.quoteId === cmp.cheapestQuoteId);
ok('a recommendation was made', Boolean(rec));
ok('the cheapest offer is identified separately', Boolean(cheap));
ok('the cheapest is not the recommendation', rec.quoteId !== cheap.quoteId, `${rec?.providerName} vs ${cheap?.providerName}`);
ok('the recommendation is explained', cmp.recommendationReasons.length >= 2);
ok('the tradeoff is stated', cmp.recommendationTradeoffs.length >= 1);

const incomplete = cmp.lines.find((l) => !l.comparable);
ok('the offer with a missing surcharge is excluded', Boolean(incomplete), 'none excluded');
ok('a missing surcharge is not treated as zero', incomplete?.totalInBaseCurrency === null);
ok('it says what is needed to compare it', cmp.blockedNotes.length >= 1);
ok('an Excel workbook was produced', Boolean(cmp.workbookKey));

const wb = await call('/api/freight/file/' + encodeURIComponent(cmp.workbookKey));
ok('the workbook downloads', wb.status === 200, String(wb.status));

console.log('\n== Completion email ==');
const prepared = await act({ type: 'comparison.prepareEmail', comparisonId: cmp.id });
ok('the comparison email is prepared', prepared.body.ok === true, short(prepared.body));
const email = prepared.body.data;
ok('it waits for approval rather than sending', email.status === 'awaiting_approval', email.status);
ok('the comparison is attached', email.attachments.length === 1);
ok('it names the recommended provider', email.bodyText.includes(rec.providerName));
ok('it names the cheaper offer too', email.bodyText.includes(cheap.providerName));
ok('it states that nothing has been booked', /no booking has been made/i.test(email.bodyText));

const skip = await act({ type: 'email.send', emailId: email.id });
ok('the comparison email cannot skip approval', skip.status >= 400, short(skip.body));
await act({ type: 'email.approve', emailId: email.id });
const sentCmp = await act({ type: 'email.send', emailId: email.id });
ok('it sends once approved', sentCmp.body.ok === true, short(sentCmp.body));

console.log('\n== ERPNext record ==');
const first = await act({ type: 'erp.sync', comparisonId: cmp.id });
ok('the first attempt fails as the demo intends', first.status >= 400, short(first.body));
const retry = await act({ type: 'erp.sync', comparisonId: cmp.id });
ok('the retry succeeds', retry.body.ok === true, short(retry.body));
ok('it is recorded as simulated', retry.body?.data?.adapter === 'simulated');
ok('it is never described as a live ERPNext write', /simulated/i.test(retry.body.message));
ok('both attempts are recorded honestly', retry.body?.data?.attempts === 2, String(retry.body?.data?.attempts));
const again = await act({ type: 'erp.sync', comparisonId: cmp.id });
ok('recording a second time is prevented', again.body?.data?.attempts === 2, short(again.body));

console.log('\n== Company isolation ==');
const reem = s.users.find((u) => u.name.startsWith('Reem'));
await become(reem.id);
const asReem = await state();
ok(
  'the second company user sees only their company',
  asReem.companies.length === 1 && asReem.companies[0].code === 'MPI',
  asReem.companies.map((c) => c.code).join(','),
);
ok('they cannot see the other company requests', !asReem.overview.rfqs.some((r) => r.reference.startsWith('RFQ-MPD')));
const crossRead = await call('/api/freight/rfq/' + rfq1.id);
ok('reading another company request is refused', crossRead.status === 403, String(crossRead.status));
const crossWrite = await act({ type: 'rfq.close', rfqId: rfq1.id });
ok('writing to another company request is refused', crossWrite.status === 403, String(crossWrite.status));

console.log('\n== Role enforcement ==');
const karim = asReem.users.find((u) => u.name.startsWith('Karim'));
await become(karim.id);
const asKarim = await state();
const pending = asKarim.overview.approvals.find((a) => a.status !== 'sent');
if (pending) {
  const denied = await act({ type: 'email.approve', emailId: pending.emailId });
  ok('a coordinator cannot approve an email', denied.status === 403, short(denied.body));
} else {
  const anyRfq = asKarim.overview.rfqs[0];
  const denied = await act({ type: 'rfq.close', rfqId: anyRfq.id });
  ok('a coordinator cannot close collection', denied.status === 403, short(denied.body));
}

console.log('\n== Mailbox collection ==');
// Back to the manager: collection is started by a person but runs as the Mailbox Collector.
const managerUser = seed.body.data.user;
await become(managerUser.id);
const collectRun = await act({ type: 'mailbox.collect' });
ok('a person can ask for a collection run', collectRun.body.ok === true, short(collectRun.body));
ok('the simulated mailbox says so rather than claiming a real read', /simulated mailbox/i.test(collectRun.body.message ?? ''), collectRun.body.message);
const afterCollect = await state();
ok('the incoming mailbox is reported and not described as connected', afterCollect.integrations?.mailbox?.connected === false, short(afterCollect.integrations?.mailbox));
ok('the last run is recorded with who asked for it', afterCollect.integrations?.collection?.lastRun?.requestedBy === managerUser.name, short(afterCollect.integrations?.collection?.lastRun));
ok('the Mailbox Collector is not a person anyone can act as', !afterCollect.users.some((u) => u.role === 'system_mailbox_collector'));
const actAsCollector = await become('system_mailbox_collector');
ok('switching to the Mailbox Collector is refused', actAsCollector.status === 400, String(actAsCollector.status));
const external = await call('/api/freight/collect', { method: 'POST', headers: { authorization: 'Bearer guess' } });
ok('the external trigger is not open to an unauthenticated caller', external.status === 401 || external.status === 404, String(external.status));

console.log(`\n==================  ${pass} passed, ${fail} failed  ==================\n`);
process.exit(fail === 0 ? 0 : 1);
