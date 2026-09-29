/**
 * Sets up a dress rehearsal in a production workspace.
 *
 *   BASE=http://127.0.0.1:4310 EMAIL=you@example.com PASSWORD=... \
 *   TEST_ADDRESS=rfq.test@mobilityp.com node scripts/rehearsal.mjs
 *
 * The customer will not share their providers' addresses for testing, and we
 * would not use them anyway: sending a test RFQ to a real carrier is their
 * reputation, not ours. So the rehearsal uses **one address we control** for
 * every provider. The workflow is identical - one email per provider, separate
 * records, separate quotations - and every message lands in a mailbox we own.
 *
 * It creates a company, three providers, one shipping requirement, and
 * prepares the emails. It stops there, before approval, because approving and
 * sending are a person's decision and this script is not a person.
 *
 * Safe to run twice: it looks before it creates.
 */

const BASE = (process.env.BASE ?? 'http://127.0.0.1:4310').replace(/\/+$/, '');
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const TEST_ADDRESS = process.env.TEST_ADDRESS ?? 'rfq.test@mobilityp.com';

if (!EMAIL || !PASSWORD) {
  console.error('Set EMAIL and PASSWORD to an account that can sign in to this workspace.');
  process.exit(2);
}

let cookie = '';
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (res.status >= 400) throw new Error(`${path} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const act = (action) => api('/api/freight/action', { method: 'POST', body: JSON.stringify(action) });

/* ------------------------------- Sign in --------------------------------- */

await api('/api/freight/auth/login', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })
  .catch((err) => {
    throw new Error(`Could not sign in as ${EMAIL}. ${err.message}`);
  });

const mode = await api('/api/freight/workspace-mode');
console.log(`${BASE}, ${mode.mode} workspace`);
if (mode.mode !== 'production') {
  console.error('This is the demonstration workspace. Switch to production before rehearsing.');
  process.exit(1);
}

/* ------------------------------ The company ------------------------------- */

let state = await api('/api/freight/state');
let company = state.companies.find((c) => c.code === 'MPD');
if (!company) {
  company = (await act({
    type: 'company.create',
    code: 'MPD',
    name: 'Mobility Pro Distribution',
    country: 'Egypt',
    addressLines: ['Rehearsal company - replace with the real details before go-live'],
  })).data;
  console.log(`  created company ${company.name}`);
} else {
  console.log(`  company ${company.name} already there`);
}

/* ------------------------------ The providers ------------------------------ */

// Three so the comparison has something to compare, all reachable only by us.
const PROVIDERS = [
  { name: 'Rehearsal Line A', kind: 'Carrier' },
  { name: 'Rehearsal Line B', kind: 'Carrier' },
  { name: 'Rehearsal Forwarder C', kind: 'Forwarder' },
];

for (const p of PROVIDERS) {
  await act({
    type: 'provider.upsert',
    companyId: company.id,
    name: p.name,
    kind: p.kind,
    country: 'Egypt',
    website: null,
    generalEmail: TEST_ADDRESS,
    notes: 'Rehearsal only. The address is a mailbox we control, never a real provider.',
    status: 'active',
    restrictionReason: null,
    accountRef: null,
    lanes: [],
    contacts: [{ name: `${p.name} desk`, email: TEST_ADDRESS, role: 'Quotations', isPrimary: true }],
  });
  console.log(`  provider ${p.name} -> ${TEST_ADDRESS}`);
}

/* ------------------------------ The request -------------------------------- */

state = await api('/api/freight/state');
const links = (await api(`/api/freight/state`)).providers ?? [];

const inAMonth = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const inSixWeeks = new Date(Date.now() + 42 * 864e5).toISOString().slice(0, 10);
const inAWeek = new Date(Date.now() + 7 * 864e5).toISOString();

const rfq = (await act({
  type: 'rfq.create',
  companyId: company.id,
  title: 'Rehearsal: tyre import, Qingdao to Jeddah',
  originPort: 'CNTAO',
  destinationPort: 'SAJED',
  incoterm: 'FOB',
  containers: [{ type: '40HC', quantity: 10, grossWeightKg: null, commodity: 'Tyres' }],
  cargoNotes: null,
  targetShipFrom: inAMonth,
  targetShipTo: inSixWeeks,
  responseDeadline: inAWeek,
  instructions: 'This is a rehearsal. Every address belongs to us.',
  requestedCurrency: 'USD',
})).data;
console.log(`  created ${rfq.reference}`);

const detail = (await api(`/api/freight/rfq/${rfq.id}`)).detail;
const options = (await api(`/api/freight/rfq/${rfq.id}`)).recipientOptions ?? [];
const chosen = options
  .filter((o) => !o.blockedReason && PROVIDERS.some((p) => o.providerName?.startsWith(p.name.split(' ')[0])))
  .map((o) => o.linkId ?? o.id);

if (chosen.length) {
  await act({ type: 'rfq.setRecipients', rfqId: rfq.id, linkIds: chosen });
  console.log(`  chose ${chosen.length} providers`);
}

const prepared = await act({ type: 'rfq.prepareEmails', rfqId: rfq.id });
console.log(`  ${prepared.message}`);

console.log(`
Ready. ${detail?.rfq?.reference ?? rfq.reference} is waiting on the Emails tab.

What a person does next, and why it is not scripted:
  1. Read one of the emails. Approve it.
  2. "Download to send yourself", open it in Outlook, send it to ${TEST_ADDRESS}.
  3. "I have sent this myself".
  4. Reply from that mailbox with a quotation, save the reply as .eml, and load
     it under Replies -> Load .eml files.
  5. Check the figures, build the comparison, record the quotations.

Every step above is a decision or an act outside this application, which is the
point of rehearsing it.`);
