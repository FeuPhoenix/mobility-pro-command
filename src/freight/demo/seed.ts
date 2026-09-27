/**
 * Builds the demonstration dataset.
 *
 * IMPORTANT: this runs the real workflow.
 *
 * It does not insert finished RFQs, sent emails and extracted quotes as fixed
 * rows. It creates the RFQ through `createRfq`, selects recipients through
 * `setRecipients` (so the outreach restrictions really apply), approves and
 * sends through the same approval gate every user goes through, and feeds the
 * replies through `ingestMessage` so the matcher and the parsers genuinely run.
 *
 * That means the demo proves the behaviour rather than illustrating it: if a
 * rule breaks, seeding breaks.
 */

import ExcelJS from 'exceljs';
import { truncateAll, setSetting } from '../db';
import {
  audit,
  getRfq,
  insertUser,
  listEmails,
  listQuotes,
  listRecipients,
  updateRecipient,
  newId,
  now,
  updateRfq,
  type Ctx,
} from '../repo';
import { createCompany, upsertProvider } from '../service/providers';
import { closeRfq, createRfq, prepareRfqEmails, setRecipients } from '../service/rfq';
import { approveEmail, sendEmail } from '../service/mail';
import { ingestMessage, reviewQuote } from '../service/inbox';
import { createComparison, prepareComparisonEmail } from '../service/compare';
import { queueSync, runSync } from '../service/erp';
import { listCompanyProviders, listRfqs } from '../repo';
import {
  COMPANIES,
  EXCEL_QUOTE_ROWS,
  PROVIDERS,
  REPLY_ANCHOR_AMBIGUOUS,
  REPLY_DECLINE,
  REPLY_DELTA,
  REPLY_LEVANT,
  REPLY_NILE_STAR,
  REPLY_SUEZ_V1,
  REPLY_SUEZ_V2,
  USERS,
} from './fixtures';
import type { Id, User } from '../types';

/** Dates are relative to today so the demo never looks stale. */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function instant(offsetDays: number, hour = 9): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

async function excelQuote(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Quotation');
  for (const [label, value] of EXCEL_QUOTE_ROWS) sheet.addRow([label, value]);
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 40;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface SeedResult {
  users: User[];
  summary: string[];
}

export async function seedDemo(): Promise<SeedResult> {
  truncateAll();
  setSetting('demo.mode', true);
  // The demonstration asks for one recoverable ERPNext failure.
  setSetting('demo.erpFailFirst', true);
  setSetting('reminders.afterDays', 3);
  setSetting('reminders.maxRounds', 2);

  const summary: string[] = [];

  /* ------------------------------ People ----------------------------------- */

  // A bootstrap context with no company yet; createCompany grants access.
  const bootstrap: Ctx = {
    user: {
      id: 'usr_bootstrap',
      name: 'Hala Mansour',
      title: 'Logistics Operations Manager',
      email: 'hala.mansour@mobilitypro.test',
      role: 'logistics_manager',
      companyIds: [],
    },
  };

  const companyIds: Record<string, Id> = {};
  for (const c of COMPANIES) {
    const created = createCompany(bootstrap, {
      code: c.code,
      name: c.name,
      country: c.country,
      addressLines: [...c.addressLines],
    });
    companyIds[c.code] = created.id;
  }

  const users: User[] = USERS.map((u) => ({
    id: newId('usr'),
    name: u.name,
    title: u.title,
    email: u.email,
    role: u.role,
    companyIds: u.companies.map((code) => companyIds[code]),
  }));
  for (const u of users) insertUser(u);

  const manager: Ctx = { user: users[0] };
  const industrial: Ctx = { user: users[2] };
  summary.push(`${users.length} people and ${COMPANIES.length} companies.`);

  /* ----------------------------- Providers --------------------------------- */

  let providerLinks = 0;
  for (const p of PROVIDERS) {
    for (const link of p.links) {
      const ctx = link.company === 'MPI' ? industrial : manager;
      upsertProvider(ctx, companyIds[link.company], {
        name: p.name,
        kind: p.kind,
        country: p.country,
        website: null,
        generalEmail: p.generalEmail,
        notes: p.notes,
        status: link.status,
        restrictionReason: link.restrictionReason ?? null,
        accountRef: link.accountRef ?? null,
        lanes: link.lanes.map(([originPort, destinationPort]) => ({ originPort, destinationPort })),
        contacts: link.contacts.map((c) => ({
          name: c.name,
          email: c.email,
          role: c.role,
          isPrimary: c.isPrimary,
        })),
      });
      providerLinks += 1;
    }
  }
  summary.push(`${PROVIDERS.length} providers across ${providerLinks} company relationships.`);

  const mpdProviders = listCompanyProviders(manager, companyIds.MPD);
  const linkIdByName = new Map(mpdProviders.map((p) => [p.provider.name, p.link.id]));
  const link = (name: string): Id => {
    const id = linkIdByName.get(name);
    if (!id) throw new Error(`Demo fixture error: provider "${name}" was not created.`);
    return id;
  };

  /* --------------------- RFQ 1: the main journey --------------------------- */

  const rfq1 = createRfq(manager, {
    companyId: companyIds.MPD,
    title: 'Tyre import, North China to Alexandria',
    originPort: 'CNSHA',
    destinationPort: 'EGALY',
    incoterm: 'FOB',
    containers: [
      { type: '40HC', quantity: 6, grossWeightKg: 21_500, commodity: 'Passenger car tyres' },
    ],
    cargoNotes: 'Stackable, palletised, no hazardous classification.',
    targetShipFrom: day(14),
    targetShipTo: day(28),
    responseDeadline: instant(4, 17),
    instructions:
      'Please quote all-in and state every surcharge separately, including what each one is charged on.',
    requestedCurrency: 'USD',
  });

  setRecipients(manager, rfq1.id, [
    link('Nile Star Logistics'),
    link('Levant Maritime Services'),
    link('Delta Freight Partners'),
    link('Suez Gateway Shipping'),
    link('Anchor Line Agencies'),
  ]);
  await approveAndSend(manager, rfq1.id);
  summary.push(`${rfq1.reference}: sent to 5 providers, all replies collected and waiting to be checked.`);

  /* ------- RFQ 2: still collecting, and the reason Anchor is ambiguous ------ */

  const rfq2 = createRfq(manager, {
    companyId: companyIds.MPD,
    title: 'Spare parts restock, Shanghai to Alexandria',
    originPort: 'CNSHA',
    destinationPort: 'EGALY',
    incoterm: 'FOB',
    containers: [{ type: '40HC', quantity: 2, grossWeightKg: 12_800, commodity: 'Automotive spare parts' }],
    cargoNotes: null,
    targetShipFrom: day(30),
    targetShipTo: day(44),
    responseDeadline: instant(7, 17),
    instructions: null,
    requestedCurrency: 'USD',
  });
  setRecipients(manager, rfq2.id, [link('Anchor Line Agencies'), link('Nile Star Logistics')]);
  await approveAndSend(manager, rfq2.id);

  // Backdate this one so the chase policy has something real to act on. Without
  // it every request in the demo was sent "just now", nothing is ever due, and
  // the whole chasing path stays invisible.
  for (const r of listRecipients(rfq2.id)) {
    updateRecipient({ ...r, sentAt: instant(-5, 9) });
  }
  summary.push(
    `${rfq2.reference}: sent five days ago, no replies - two providers are due a chase.`,
  );

  /* ---------------------------- The replies -------------------------------- */

  const sheet = await excelQuote();

  await ingestMessage(manager, {
    externalId: 'demo-msg-nilestar-1',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'yasmine.farouk@nilestar.test',
    fromName: 'Yasmine Farouk',
    subject: `RE: Request for quotation ${rfq1.reference} - CNSHA to EGALY`,
    receivedAt: instant(-2, 11),
    bodyText: REPLY_NILE_STAR(rfq1.reference),
    attachments: [],
    simulated: true,
  });

  await ingestMessage(manager, {
    externalId: 'demo-msg-levant-1',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'rami.haddad@levantmaritime.test',
    fromName: 'Rami Haddad',
    subject: `Our offer - ${rfq1.reference}`,
    receivedAt: instant(-2, 14),
    bodyText: REPLY_LEVANT(rfq1.reference),
    attachments: [],
    simulated: true,
  });

  await ingestMessage(manager, {
    externalId: 'demo-msg-delta-1',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'mostafa.zaki@deltafreight.test',
    fromName: 'Mostafa Zaki',
    subject: `Quotation ${rfq1.reference}`,
    receivedAt: instant(-2, 16),
    bodyText: REPLY_DELTA(rfq1.reference),
    attachments: [],
    simulated: true,
  });

  // Suez quote and then a revision: version 1 must survive as superseded.
  await ingestMessage(manager, {
    externalId: 'demo-msg-suez-1',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'amira.saleh@suezgateway.test',
    fromName: 'Amira Saleh',
    subject: `${rfq1.reference} quotation`,
    receivedAt: instant(-3, 10),
    bodyText: REPLY_SUEZ_V1(rfq1.reference),
    attachments: [],
    simulated: true,
  });
  await ingestMessage(manager, {
    externalId: 'demo-msg-suez-2',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'amira.saleh@suezgateway.test',
    fromName: 'Amira Saleh',
    subject: `REVISED - ${rfq1.reference} quotation`,
    receivedAt: instant(-1, 9),
    bodyText: REPLY_SUEZ_V2(rfq1.reference),
    attachments: [],
    simulated: true,
  });

  // No reference quoted, and Anchor is on two open RFQs: ambiguous by design.
  const ambiguous = await ingestMessage(manager, {
    externalId: 'demo-msg-anchor-1',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'quotes@anchorline.test',
    fromName: 'Anchor Line Quotations',
    subject: 'Rate request - Shanghai to Alexandria',
    receivedAt: instant(-1, 13),
    bodyText: REPLY_ANCHOR_AMBIGUOUS(),
    attachments: [],
    simulated: true,
  });
  if (ambiguous.message.matchStatus === 'matched') {
    throw new Error(
      'Demo fixture error: the Anchor Line reply was expected to be ambiguous but it matched automatically.',
    );
  }
  summary.push('One reply from Anchor Line Agencies is waiting for a person to say which RFQ it belongs to.');

  /* ------- RFQ 3: a finished one, with a failed ERPNext record ------------- */

  const rfq3 = createRfq(manager, {
    companyId: companyIds.MPD,
    title: 'Rim shipment, Shanghai to Alexandria',
    originPort: 'CNSHA',
    destinationPort: 'EGALY',
    incoterm: 'FOB',
    containers: [{ type: '40HC', quantity: 3, grossWeightKg: 19_000, commodity: 'Alloy rims' }],
    cargoNotes: null,
    targetShipFrom: day(-10),
    targetShipTo: day(-2),
    responseDeadline: instant(-16, 17),
    instructions: null,
    requestedCurrency: 'USD',
  });
  setRecipients(manager, rfq3.id, [link('Nile Star Logistics'), link('Levant Maritime Services')]);
  await approveAndSend(manager, rfq3.id);

  await ingestMessage(manager, {
    externalId: 'demo-msg-rfq3-nilestar',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'yasmine.farouk@nilestar.test',
    fromName: 'Yasmine Farouk',
    subject: `RE: ${rfq3.reference}`,
    receivedAt: instant(-18, 10),
    bodyText: REPLY_NILE_STAR(rfq3.reference),
    attachments: [],
    simulated: true,
  });
  await ingestMessage(manager, {
    externalId: 'demo-msg-rfq3-levant',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'rami.haddad@levantmaritime.test',
    fromName: 'Rami Haddad',
    subject: `RE: ${rfq3.reference}`,
    receivedAt: instant(-18, 12),
    bodyText: REPLY_LEVANT(rfq3.reference),
    attachments: [],
    simulated: true,
  });

  // Confirm both, close, compare, prepare and approve the email, then attempt
  // the ERPNext write - which fails the first time and is left to be retried.
  for (const q of listQuotes(manager, rfq3.id)) {
    if (q.status === 'needs_review') reviewQuote(manager, q.id, { fields: [], confirm: true });
  }
  closeRfq(manager, rfq3.id);
  const comparison3 = await createComparison(manager, rfq3.id);
  const email3 = prepareComparisonEmail(manager, comparison3.id);
  approveEmail(manager, email3.id);
  await sendEmail(manager, email3.id);

  queueSync(manager, comparison3.id);
  const attempt = await runSync(manager, comparison3.id);
  if (attempt.ok) {
    throw new Error('Demo fixture error: the first ERPNext attempt was expected to fail so the retry can be shown.');
  }
  summary.push(
    `${rfq3.reference}: completed, but recording the outcome failed once and is waiting to be retried.`,
  );

  /* ------------------ A draft on the second company ------------------------ */

  const rfq4 = createRfq(industrial, {
    companyId: companyIds.MPI,
    title: 'Component import, Shanghai to Jebel Ali',
    originPort: 'CNSHA',
    destinationPort: 'AEJEA',
    incoterm: 'FOB',
    containers: [{ type: '20GP', quantity: 4, grossWeightKg: 16_000, commodity: 'Suspension components' }],
    cargoNotes: null,
    targetShipFrom: day(21),
    targetShipTo: day(35),
    responseDeadline: instant(9, 17),
    instructions: null,
    requestedCurrency: 'USD',
  });
  summary.push(`${rfq4.reference}: a draft on ${COMPANIES[1].name}, not yet sent.`);

  // A declined reply on the industrial company, so the chaser has a reason to stop.
  setRecipients(industrial, rfq4.id, [
    listCompanyProviders(industrial, companyIds.MPI).find((p) => p.provider.name === 'Gulf Transit Company')!.link.id,
    listCompanyProviders(industrial, companyIds.MPI).find((p) => p.provider.name === 'Levant Maritime Services')!.link.id,
  ]);
  await approveAndSend(industrial, rfq4.id);
  await ingestMessage(industrial, {
    externalId: 'demo-msg-gulf-decline',
    threadId: null,
    inReplyTo: null,
    fromEmail: 'fatima.almarri@gulftransit.test',
    fromName: 'Fatima Al Marri',
    subject: `RE: ${getRfq(industrial, rfq4.id).reference}`,
    receivedAt: instant(-1, 15),
    bodyText: REPLY_DECLINE(getRfq(industrial, rfq4.id).reference),
    attachments: [],
    simulated: true,
  });

  // Keep the spreadsheet fixture reachable from the UI even though no provider
  // in the seed sends one, so the Excel path can be demonstrated by upload.
  setSetting('demo.sampleExcelBytes', sheet.byteLength);

  audit(manager, {
    companyId: null,
    action: 'demo.seeded',
    subject: 'system',
    summary: 'Loaded the demonstration dataset. All companies, providers and rates in it are fictional.',
  });

  return { users, summary };
}

/** Approves and sends every prepared RFQ email, as the manager would. */
async function approveAndSend(ctx: Ctx, rfqId: Id): Promise<void> {
  prepareRfqEmails(ctx, rfqId);
  for (const email of listEmails(ctx, { rfqId })) {
    if (email.kind !== 'rfq' || email.status === 'sent') continue;
    approveEmail(ctx, email.id);
    const result = await sendEmail(ctx, email.id);
    if (!result.ok) throw new Error(`Demo fixture error: ${result.error}`);
  }
}

/** True when the store already holds the demo dataset. */
export function isSeeded(ctx: Ctx): boolean {
  return listRfqs(ctx).length > 0;
}

export { updateRfq, now };
