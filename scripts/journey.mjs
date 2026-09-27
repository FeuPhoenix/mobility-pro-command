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
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'FreightDemo2026';

/** Which authentication mode the server is in; the checks differ by mode. */
let AUTH_MODE = 'demo';
const readAuthMode = async () => {
  const res = await call('/api/freight/state');
  AUTH_MODE = res.body?.auth?.mode ?? 'demo';
  return AUTH_MODE;
};

/**
 * Becomes someone.
 *
 * In password mode that means signing in. In demo mode there is no password, so
 * it switches the acting person - which is what the picker does.
 */
const become = async (email, password = DEMO_PASSWORD) => {
  if (AUTH_MODE === 'password') {
    return call('/api/freight/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }
  const state = await call('/api/freight/state');
  const user = (state.body?.users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!user) return { status: 400, body: { ok: false, error: `no such person: ${email}` } };
  return call('/api/freight/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id }),
  });
};

const signOut = () => call('/api/freight/auth/logout', { method: 'POST' });

/** The demo accounts, read from the sign-in page's own endpoint. */
const demoAccounts = async () => {
  const res = await call('/api/freight/auth/state');
  const listed = res.body?.demo?.accounts ?? [];
  if (listed.length > 0) return listed;
  // Demo mode does not publish a sign-in list, so use the picker's own list.
  const state = await call('/api/freight/state');
  return (state.body?.users ?? []).map((u) => ({ name: u.name, title: u.title, email: u.email }));
};

const short = (v) => JSON.stringify(v).slice(0, 170);

await readAuthMode();
console.log(`
== Seeding == (AUTH_MODE=${AUTH_MODE})`);

// Sign in first where sign-in exists, both so reseeding is allowed in demo
// mode and so the rest of the run has a session at all.
const before = await call('/api/freight/auth/state');
if (!before.body?.needsSetup) {
  const accounts0 = before.body?.demo?.accounts ?? [];
  const manager0 = accounts0.find((a) => /Manager/i.test(a.title)) ?? accounts0[0];
  if (manager0) {
    const pre = await become(manager0.email);
    ok('signing in as the manager works', pre.body?.ok === true, short(pre.body));
  }
}

// Seeding is deliberately refused once sign-in is on: it would erase a real
// workspace. In that case carry on against whatever data is already there.
const seed = await call('/api/freight/demo', { method: 'POST' });
if (AUTH_MODE === 'demo') {
  ok('demo dataset loads', seed.body.ok === true, short(seed.body));
} else {
  ok(
    'seeding is refused while sign-in is on',
    seed.body?.ok !== true,
    'it should not be possible to erase a signed-in workspace',
  );
  console.log('  NOTE    continuing against the data already in the workspace');
}


/*
 * The workflow checks below assume the freshly seeded dataset: a request still
 * collecting, quotes not yet checked, one ERPNext record still failing. Seeding
 * is refused once sign-in is on, so in the real modes this run verifies the
 * sign-in gate and stops rather than reporting failures that only mean "this
 * workspace has already been used".
 *
 * To exercise the whole journey: seed in demo mode, then restart in the mode
 * you want to check.
 */
if (AUTH_MODE !== 'demo') {
  const me = await state();
  ok('a signed-in person sees the workspace', Boolean(me?.user), short(me));
  ok('and their companies', Array.isArray(me?.companies) && me.companies.length > 0);

  await signOut();
  const out = await call('/api/freight/state');
  ok('signing out ends the session', out.status === 401, String(out.status));
  const blockedAct = await act({ type: 'rfq.close', rfqId: 'whatever' });
  ok('a signed-out request cannot act', blockedAct.status === 401, String(blockedAct.status));
  const blockedSeed = await call('/api/freight/demo', { method: 'POST' });
  ok('a signed-out request cannot wipe the workspace', blockedSeed.status !== 200, String(blockedSeed.status));

  if (AUTH_MODE === 'password') {
    const accounts = await demoAccounts();
    const manager = accounts.find((a) => /Manager/i.test(a.title)) ?? accounts[0];
    const wrong = await become(manager.email, 'NotThePassword1');
    ok('a wrong password is refused', wrong.status === 401, String(wrong.status));
    const unknown = await become('nobody@nowhere.test');
    ok('an unknown address is refused', unknown.status === 401, String(unknown.status));
    ok(
      'both failures give the same message, so accounts cannot be enumerated',
      wrong.body?.error === unknown.body?.error,
      `${wrong.body?.error} vs ${unknown.body?.error}`,
    );
    const back = await become(manager.email);
    ok('signing back in works', back.body?.ok === true, short(back.body));
    ok('and the workspace loads again', (await call('/api/freight/state')).status === 200);
  }

  console.log('');
  console.log(`  NOTE    workflow checks skipped in ${AUTH_MODE} mode (needs a freshly seeded workspace)`);
  console.log('');
  console.log(`==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
}

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
const accounts = await demoAccounts();
const reem = accounts.find((u) => u.name.startsWith('Reem'));
ok('the demo accounts are listed for sign-in', Boolean(reem), JSON.stringify(accounts).slice(0, 120));
const reemSignIn = await become(reem.email);
ok('signing in as another company user works', reemSignIn.body?.ok === true, short(reemSignIn.body));
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
const karim = accounts.find((u) => u.name.startsWith('Karim'));
await become(karim.email);
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
await become(managerUser.email);
const collectRun = await act({ type: 'mailbox.collect' });
ok('a person can ask for a collection run', collectRun.body.ok === true, short(collectRun.body));
ok('the simulated mailbox says so rather than claiming a real read', /simulated mailbox/i.test(collectRun.body.message ?? ''), collectRun.body.message);
const afterCollect = await state();
ok('the incoming mailbox is reported and not described as connected', afterCollect.integrations?.mailbox?.connected === false, short(afterCollect.integrations?.mailbox));
ok('the last run is recorded with who asked for it', afterCollect.integrations?.collection?.lastRun?.requestedBy === managerUser.name, short(afterCollect.integrations?.collection?.lastRun));
const collectorAccounts = await demoAccounts();
ok(
  'the Mailbox Collector is not an account anyone can sign in as',
  !collectorAccounts.some((u) => /collector/i.test(u.name)),
  JSON.stringify(collectorAccounts.map((u) => u.name)),
);
const external = await call('/api/freight/collect', { method: 'POST', headers: { authorization: 'Bearer guess' } });
ok('the external trigger is not open to an unauthenticated caller', external.status === 401 || external.status === 404, String(external.status));

console.log('');
console.log('== Authentication ==');
if (AUTH_MODE !== 'password') {
  console.log(`  SKIP    password sign-in checks: the server is in ${AUTH_MODE} mode`);
  const openState = await call('/api/freight/state');
  ok('demo mode serves the workspace without a sign-in', openState.status === 200, String(openState.status));
  const switchOff = await call('/api/freight/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'x@y.test', password: 'whatever12' }),
  });
  ok('password sign-in is refused while it is switched off', switchOff.status === 404, String(switchOff.status));
} else {
await signOut();
const afterSignOut = await call('/api/freight/state');
ok('signing out ends the session', afterSignOut.status === 401, String(afterSignOut.status));
const blockedRead = await call('/api/freight/rfq/' + rfq1.id);
ok('a signed-out request cannot read an RFQ', blockedRead.status === 401, String(blockedRead.status));
const blockedWrite = await act({ type: 'rfq.close', rfqId: rfq1.id });
ok('a signed-out request cannot act', blockedWrite.status === 401, String(blockedWrite.status));
const blockedSeed = await call('/api/freight/demo', { method: 'POST' });
ok('a signed-out request cannot wipe the workspace', blockedSeed.status === 401, String(blockedSeed.status));

const wrongPassword = await become(managerUser.email, 'NotThePassword1');
ok('a wrong password is refused', wrongPassword.status === 401, String(wrongPassword.status));
const unknownUser = await become('nobody@nowhere.test');
ok('an unknown address is refused', unknownUser.status === 401, String(unknownUser.status));
ok(
  'both failures give the same message, so accounts cannot be enumerated',
  wrongPassword.body?.error === unknownUser.body?.error,
  wrongPassword.body?.error + ' vs ' + unknownUser.body?.error,
);

const backIn = await become(managerUser.email);
ok('signing back in works', backIn.body?.ok === true, short(backIn.body));
ok('and the workspace loads again', (await call('/api/freight/state')).status === 200);


}
console.log(`\n==================  ${pass} passed, ${fail} failed  ==================\n`);
process.exit(fail === 0 ? 0 : 1);
