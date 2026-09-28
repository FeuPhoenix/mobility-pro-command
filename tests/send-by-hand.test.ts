/**
 * Sending an approved email from a person's own mailbox.
 *
 * This is how a pilot runs before Microsoft Graph exists: download the
 * approved message, send it in Outlook, then record it. Handing someone the
 * file is handing them the send, so the download passes the same approval gate
 * as a real send - and what is recorded afterwards must never read as though
 * this application sent it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb } from '@/freight/db';
import {
  getRfq,
  insertUser,
  listAudit,
  listCompanyProviders,
  listEmails,
  listRecipients,
  newId,
  type Ctx,
} from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import { createRfq, prepareRfqEmails, setRecipients } from '@/freight/service/rfq';
import { approveEmail, editEmail, emailAsEml, markSentByHand } from '@/freight/service/mail';
import type { User } from '@/freight/types';

let manager: Ctx;
let companyId: string;

beforeEach(() => {
  useDb(openMemoryDb());
  const boot: Ctx = {
    user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@test.test', role: 'logistics_manager', companyIds: [] },
  };
  companyId = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['L1'] }).id;

  const u: User = {
    id: newId('usr'), name: 'Hala Mansour', title: 'Logistics Operations Manager',
    email: 'hala@test.test', role: 'logistics_manager', companyIds: [companyId],
  };
  insertUser(u);
  manager = { user: u };

  upsertProvider(manager, companyId, {
    name: 'Alpha Lines', kind: 'Carrier', country: 'Egypt', website: null,
    generalEmail: 'ops@alpha.test', notes: null, status: 'active', restrictionReason: null,
    accountRef: null, lanes: [], contacts: [{ name: 'Ann', email: 'ann@alpha.test', role: null, isPrimary: true }],
  });
});

function prepared() {
  const rfq = createRfq(manager, {
    companyId,
    title: 'Send by hand',
    originPort: 'CNSHA',
    destinationPort: 'EGALY',
    incoterm: 'FOB',
    containers: [{ type: '40HC', quantity: 3, grossWeightKg: null, commodity: 'Tyres' }],
    cargoNotes: null,
    targetShipFrom: '2099-01-10',
    targetShipTo: '2099-01-24',
    responseDeadline: '2099-01-05T17:00:00.000Z',
    instructions: null,
    requestedCurrency: 'USD',
  });
  const link = listCompanyProviders(manager, companyId).find((p) => p.provider.name === 'Alpha Lines')!;
  setRecipients(manager, rfq.id, [link.link.id]);
  return { rfq, email: prepareRfqEmails(manager, rfq.id)[0] };
}

describe('the file may only be had for an approved email', () => {
  it('refuses one nobody has approved', () => {
    const { email } = prepared();
    expect(() => emailAsEml(manager, email.id)).toThrow(/only be downloaded once it has been approved/i);
  });

  it('gives the file once it is approved', () => {
    const { email } = prepared();
    approveEmail(manager, email.id);

    const file = emailAsEml(manager, email.id);
    expect(file.filename).toMatch(/\.eml$/);
    expect(file.content).toContain('ann@alpha.test');
    expect(file.content).toContain('X-Unsent: 1');
  });

  it('refuses again once the content changed after approval', () => {
    const { email } = prepared();
    approveEmail(manager, email.id);
    editEmail(manager, email.id, { subject: 'Something else entirely' });

    // The approval no longer describes this message, so the file must not be
    // handed over - it would be sending something nobody approved.
    expect(() => emailAsEml(manager, email.id)).toThrow(/approved/i);
  });

  it('records the download without claiming anything was sent', () => {
    const { email } = prepared();
    approveEmail(manager, email.id);
    emailAsEml(manager, email.id);

    const entry = listAudit(manager, { subject: `email:${email.id}` }).find(
      (e) => e.action === 'email.downloaded',
    );
    expect(entry?.summary).toMatch(/Nothing has been sent yet/i);
    expect(listEmails(manager, { rfqId: email.rfqId })[0].status).not.toBe('sent');
  });
});

describe('recording that a person sent it', () => {
  it('will not record an unapproved email as sent', () => {
    const { email } = prepared();
    expect(() => markSentByHand(manager, email.id)).toThrow(/has not been approved/i);
  });

  it('marks it sent, and says a person did it', () => {
    const { email } = prepared();
    approveEmail(manager, email.id);

    const outcome = markSentByHand(manager, email.id);
    expect(outcome.ok).toBe(true);
    expect(outcome.email.status).toBe('sent');
    expect(outcome.email.sentByHand).toBe(true);
    expect(outcome.email.sentByHandBy).toBe(manager.user.id);
    expect(outcome.email.sentAt).toBeTruthy();
  });

  it('does not pass itself off as a send by this application', () => {
    const { email } = prepared();
    approveEmail(manager, email.id);
    const outcome = markSentByHand(manager, email.id);

    // Not simulated - it really was sent. But not by us, and there is no
    // transport id to pretend otherwise with.
    expect(outcome.email.simulated).toBe(false);
    expect(outcome.email.transportMessageId).toBeNull();

    const entry = listAudit(manager, { subject: `email:${email.id}` }).find(
      (e) => e.action === 'email.sent_by_hand',
    );
    expect(entry?.summary).toContain('Hala Mansour');
    expect(entry?.summary).toMatch(/This application did not send it/i);
  });

  it('refuses to record it twice', () => {
    const { email } = prepared();
    approveEmail(manager, email.id);
    markSentByHand(manager, email.id);

    expect(() => markSentByHand(manager, email.id)).toThrow(/already been sent/i);
  });

  it('moves the request along, as a real send does', () => {
    const { rfq, email } = prepared();
    approveEmail(manager, email.id);
    markSentByHand(manager, email.id);

    // The provider is waiting on a reply now, and the request is collecting -
    // otherwise nothing downstream, chasing included, would work.
    expect(getRfq(manager, rfq.id).status).toBe('collecting');
    expect(listRecipients(rfq.id)[0].status).toBe('sent');
    expect(listRecipients(rfq.id)[0].sentAt).toBeTruthy();
  });
});
