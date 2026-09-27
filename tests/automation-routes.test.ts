/**
 * Route-level tests for the automation endpoints.
 *
 * These call the handlers the way n8n will, with a real `Request`, so the token
 * check and the response shape are exercised rather than assumed. No server is
 * started: the App Router handlers are plain functions.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb, useDb } from '@/freight/db';
import { createCompany } from '@/freight/service/providers';
import type { Ctx } from '@/freight/repo';

import { GET as summaryGET } from '@/app/api/freight/automation/summary/route';
import { GET as approvalsGET } from '@/app/api/freight/automation/approvals/route';
import { GET as remindersGET, POST as remindersPOST } from '@/app/api/freight/automation/reminders/route';
import { GET as erpGET, POST as erpPOST } from '@/app/api/freight/automation/erpnext/route';

const TOKEN = 'test-automation-token-long-enough';

function req(token?: string, body?: unknown): Request {
  return new Request('http://localhost/api/freight/automation/x', {
    method: body === undefined ? 'GET' : 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Every handler, so the auth rules can be asserted across all of them at once. */
const handlers: { name: string; call: (r: Request) => Promise<Response> }[] = [
  { name: 'GET summary', call: summaryGET },
  { name: 'GET approvals', call: approvalsGET },
  { name: 'GET reminders', call: remindersGET },
  { name: 'POST reminders', call: remindersPOST },
  { name: 'GET erpnext', call: erpGET },
  { name: 'POST erpnext', call: erpPOST },
];

beforeEach(() => {
  useDb(openMemoryDb());
  const boot: Ctx = {
    user: { id: 'boot', name: 'Boot', title: 'b', email: 'b@test.test', role: 'logistics_manager', companyIds: [] },
  };
  createCompany(boot, { code: 'AAA', name: 'Company A', country: 'Egypt', addressLines: ['L1'] });
  process.env.FREIGHT_AUTOMATION_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.FREIGHT_AUTOMATION_TOKEN;
});

describe('automation endpoint authentication', () => {
  it('is switched off, not open, when no token is configured', async () => {
    delete process.env.FREIGHT_AUTOMATION_TOKEN;
    for (const h of handlers) {
      const res = await h.call(req(TOKEN, h.name.startsWith('POST') ? {} : undefined));
      expect(res.status, h.name).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error, h.name).toMatch(/switched off/i);
    }
  });

  it('refuses a missing token', async () => {
    for (const h of handlers) {
      const res = await h.call(req(undefined, h.name.startsWith('POST') ? {} : undefined));
      expect(res.status, h.name).toBe(401);
    }
  });

  it('refuses a wrong token, including one that is merely a prefix', async () => {
    for (const bad of ['nope', TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const res = await summaryGET(req(bad));
      expect(res.status, bad).toBe(401);
    }
  });

  it('accepts the configured token', async () => {
    for (const h of handlers) {
      const res = await h.call(req(TOKEN, h.name.startsWith('POST') ? {} : undefined));
      expect(res.status, h.name).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok, h.name).toBe(true);
    }
  });
});

describe('automation endpoint responses', () => {
  it('summary returns the counts a briefing needs', async () => {
    const res = await summaryGET(req(TOKEN));
    const body = (await res.json()) as { data: Record<string, unknown> };
    for (const key of [
      'awaitingApproval',
      'staleApprovals',
      'providersDueAChase',
      'quotesToCheck',
      'repliesToMatch',
      'comparisonsReady',
      'erpNeedsAttention',
      'deadlinesWithin24h',
    ]) {
      expect(body.data, key).toHaveProperty(key);
    }
  });

  it('reminders reports nothing due on an empty workspace, and prepares nothing', async () => {
    const read = await remindersGET(req(TOKEN));
    expect(((await read.json()) as { data: { providersDue: number } }).data.providersDue).toBe(0);

    const write = await remindersPOST(req(TOKEN, {}));
    const body = (await write.json()) as { message: string; data: { prepared: number } };
    expect(body.data.prepared).toBe(0);
    expect(body.message).toMatch(/no provider was due/i);
  });

  it('erpnext reports nothing outstanding on an empty workspace', async () => {
    const res = await erpGET(req(TOKEN));
    const body = (await res.json()) as { data: { outstanding: number; retryable: number } };
    expect(body.data.outstanding).toBe(0);
    expect(body.data.retryable).toBe(0);
  });

  it('tolerates a malformed POST body rather than failing', async () => {
    const res = await remindersPOST(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(200);
  });
});
