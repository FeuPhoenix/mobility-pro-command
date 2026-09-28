/**
 * The two optional automations from the handover's decisions table. Both are
 * off by default; switched on, neither may send, approve or reach a restricted
 * provider.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, setSetting, useDb } from '@/freight/db';
import { assertCanEdit, getRfq, insertUser, listAudit, listCompanyProviders, listEmails, listRecipients, newId, type Ctx } from '@/freight/repo';
import { createCompany, upsertProvider } from '@/freight/service/providers';
import {
  CLOSE_AT_DEADLINE_KEY,
  PRESELECT_LANE_KEY,
  closeRfqsAtDeadline,
  createRfq,
  prepareRfqEmails,
  setRecipients,
} from '@/freight/service/rfq';
import { approveEmail, sendEmail } from '@/freight/service/mail';
import { applyFreightAction } from '@/freight/actions';
import { collectInbox } from '@/freight/service/collect';
import { SimulatedMailbox } from '@/freight/adapters/mailbox';
import { deadlineCtx } from '@/freight/system';
import type { RelationshipStatus, User } from '@/freight/types';

let company: string;
let manager: Ctx;
let coordinator: Ctx;

function provider(name: string, status: RelationshipStatus, lane: boolean) {
  upsertProvider(manager, company, {
    name, kind: 'Carrier', country: 'Egypt', website: null, generalEmail: null, notes: null, status,
    restrictionReason: status === 'active' ? null : 'Restricted for the test.', accountRef: null,
    lanes: lane ? [{ originPort: 'CNSHA', destinationPort: 'EGALY' }] : [{ originPort: 'CNNGB', destinationPort: 'EGPSD' }],
    contacts: [{ name, email: `${name.split(' ')[0].toLowerCase()}@${name.split(' ')[0].toLowerCase()}.test`, role: null, isPrimary: true }],
  });
}

const RFQ = {
  title: 'Test', originPort: 'CNSHA', destinationPort: 'EGALY', incoterm: 'FOB' as const,
  containers: [{ type: '40HC', quantity: 1, grossWeightKg: null, commodity: 'Tyres' }],
  cargoNotes: null, targetShipFrom: '2099-01-10', targetShipTo: '2099-01-24',
  responseDeadline: '2099-01-05T17:00:00.000Z', instructions: null, requestedCurrency: 'USD',
};

beforeEach(() => {
  useDb(openMemoryDb());
  SimulatedMailbox.reset();
  const boot: Ctx = { user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@x.test', role: 'logistics_manager', companyIds: [] } };
  company = createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['1'] }).id;
  const mk = (name: string, role: User['role']): Ctx => {
    const u: User = { id: newId('usr'), name, title: role, email: `${name.split(' ')[0].toLowerCase()}@mp.test`, role, companyIds: [company] };
    insertUser(u);
    return { user: u };
  };
  manager = mk('Ann Manager', 'logistics_manager');
  coordinator = mk('Carl Coord', 'logistics_coordinator');
  provider('Alpha Lanes', 'active', true);
  provider('Beta Lanes', 'active', true);
  provider('Gamma Elsewhere', 'active', false);
  provider('Delta Contracted', 'contracted', true);
  provider('Echo Excluded', 'excluded', true);
});

const names = (rfqId: string) => {
  const byId = new Map(listCompanyProviders(manager, company).map((p) => [p.link.id, p.provider.name]));
  return listRecipients(rfqId).map((r) => byId.get(r.companyProviderId)).sort();
};

describe('pre-selecting providers that serve the lane', () => {
  it('is off by default', async () => {
    const res = await applyFreightAction(manager, { type: 'rfq.create', companyId: company, ...RFQ });
    expect(names((res.data as { id: string }).id)).toEqual([]);
  });

  it('selects only contactable providers on the lane, and prepares no email', async () => {
    setSetting(PRESELECT_LANE_KEY, true);
    const res = await applyFreightAction(manager, { type: 'rfq.create', companyId: company, ...RFQ });
    const id = (res.data as { id: string }).id;
    expect(names(id)).toEqual(['Alpha Lanes', 'Beta Lanes']);
    expect(res.message).toMatch(/2 providers serving the lane pre-selected/);
    expect(listEmails(manager, { rfqId: id })).toEqual([]);
    expect(getRfq(manager, id).status).toBe('draft');
  });

  it('can only be switched by a manager', async () => {
    await expect(applyFreightAction(coordinator, { type: 'settings.automation', preselectLane: true, closeAtDeadline: false })).rejects.toThrow(
      /Only the Logistics Operations Manager/,
    );
  });
});

describe('closing collection at the deadline', () => {
  async function sentRfq(deadline: string) {
    const rfq = createRfq(manager, { companyId: company, ...RFQ, responseDeadline: deadline });
    setRecipients(manager, rfq.id, [listCompanyProviders(manager, company).find((p) => p.provider.name === 'Alpha Lanes')!.link.id]);
    for (const e of prepareRfqEmails(manager, rfq.id)) {
      approveEmail(manager, e.id);
      await sendEmail(manager, e.id);
    }
    return rfq;
  }

  it('is off by default', async () => {
    const past = await sentRfq('2020-01-01T00:00:00.000Z');
    expect(closeRfqsAtDeadline()).toEqual([]);
    expect(getRfq(manager, past.id).status).not.toBe('closed');
  });

  it('closes only sent requests past their deadline, as an automatic process', async () => {
    setSetting(CLOSE_AT_DEADLINE_KEY, true);
    const past = await sentRfq('2020-01-01T00:00:00.000Z');
    const future = await sentRfq('2099-01-05T17:00:00.000Z');
    const draft = createRfq(manager, { companyId: company, ...RFQ, responseDeadline: '2020-01-01T00:00:00.000Z' });

    expect(closeRfqsAtDeadline()).toEqual([past.reference]);
    expect(getRfq(manager, past.id)).toMatchObject({ status: 'closed', closedBy: 'system_deadline' });
    expect(listRecipients(past.id)[0].status).toBe('no_response');
    expect(getRfq(manager, future.id).status).not.toBe('closed');
    expect(getRfq(manager, draft.id).status).toBe('draft');

    const entry = listAudit(manager).find((e) => e.action === 'rfq.closed');
    expect(entry?.actorName).toBe('Response deadline (automatic)');
    // Idempotent: a second pass finds nothing new.
    expect(closeRfqsAtDeadline()).toEqual([]);
  });

  it('runs after each collection, which reports what it closed', async () => {
    setSetting(CLOSE_AT_DEADLINE_KEY, true);
    const past = await sentRfq('2020-01-01T00:00:00.000Z');
    const run = await collectInbox({ trigger: 'schedule' });
    expect(run.closedAtDeadline).toEqual([past.reference]);
  });

  it('gives the automatic process no other powers', () => {
    expect(() => assertCanEdit(deadlineCtx())).toThrow(/automatic process/);
  });
});
