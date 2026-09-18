import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSeedState } from '@/domain/seed';
import { N8N_WORKFLOWS, lastRun, triggerDetail, triggerLabel } from '@/domain/automations';
import { N8N_ENDPOINTS, N8N_OUTBOUND_EVENTS, DemoN8nAdapter } from '@/lib/n8n/adapter';
import { ActionError, applyAction, ensureValidated } from '@/server/actions';
import type { DemoState } from '@/domain/types';

function fresh(): DemoState {
  const s = buildSeedState('test');
  ensureValidated(s);
  return s;
}

function expectRefusal(fn: () => unknown, match: RegExp, status?: number) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    expect((e as ActionError).message).toMatch(match);
    if (status) expect((e as ActionError).status).toBe(status);
    return;
  }
  throw new Error('Expected the action to be refused, but it succeeded.');
}

/* ------------------------------- Definitions ------------------------------- */

describe('n8n workflow definitions', () => {
  it('seeds every workflow into the demo state', () => {
    const state = fresh();
    expect(state.automations).toHaveLength(N8N_WORKFLOWS.length);
    expect(state.automations.length).toBeGreaterThanOrEqual(7);
  });

  it('gives every workflow an owner, a guardrail and a downloadable export', () => {
    for (const a of N8N_WORKFLOWS) {
      expect(a.ownerId).toMatch(/^U-/);
      expect(a.guardrail.length).toBeGreaterThan(20);
      expect(a.writesBack.length).toBeGreaterThan(10);
      expect(a.workflowFile).toMatch(/\.json$/);
      expect(a.steps.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('labels every step with a real n8n node type', () => {
    for (const a of N8N_WORKFLOWS) {
      for (const s of a.steps) {
        expect(s.node).toMatch(/^n8n-nodes-base\./);
      }
    }
  });

  it('marks every seeded run as simulated', () => {
    for (const a of N8N_WORKFLOWS) {
      for (const r of a.runs) expect(r.simulated).toBe(true);
    }
  });

  it('describes each trigger in both human and machine terms', () => {
    for (const a of N8N_WORKFLOWS) {
      expect(triggerLabel(a).length).toBeGreaterThan(5);
      expect(triggerDetail(a).length).toBeGreaterThan(3);
    }
  });

  it('returns the most recent run regardless of array order', () => {
    const a = N8N_WORKFLOWS.find((x) => x.runs.length > 1)!;
    const newest = [...a.runs].sort((x, y) => y.at.localeCompare(x.at))[0];
    expect(lastRun(a).id).toBe(newest.id);
  });
});

/* --------------------------------- Adapter --------------------------------- */

describe('n8n adapter boundary', () => {
  it('never reports itself as connected', async () => {
    const adapter = new DemoN8nAdapter(fresh());
    const status = adapter.status();
    expect(status.connected).toBe(false);
    expect(status.label).toBe('n8n demo adapter');
    expect(status.label.toLowerCase()).not.toContain('connected to');
    expect((await adapter.probe()).connected).toBe(false);
  });

  it('refuses to trigger a workflow, rather than pretending to', async () => {
    const adapter = new DemoN8nAdapter(fresh());
    await expect(adapter.trigger('aging-stock-sweep')).rejects.toThrow(/no n8n instance is connected/i);
  });

  it('keeps every inbound endpoint honest about its status', () => {
    for (const e of N8N_ENDPOINTS) {
      expect(['designed', 'implemented']).toContain(e.status);
      expect(e.appBehaviour.length).toBeGreaterThan(20);
    }
    // Nothing is implemented yet, and the doc says so.
    expect(N8N_ENDPOINTS.every((e) => e.status === 'designed')).toBe(true);
  });

  it('names a consumer for every outbound event', () => {
    const ids = new Set(N8N_WORKFLOWS.map((w) => w.id));
    for (const e of N8N_OUTBOUND_EVENTS) {
      const named = e.consumedBy.split(' ')[0];
      expect(ids.has(named)).toBe(true);
    }
  });
});

/* ------------------------------ Simulated runs ----------------------------- */

describe('simulating a run', () => {
  let state: DemoState;
  beforeEach(() => {
    state = fresh();
  });

  it('records a run that reads the live demo state', () => {
    const before = state.automations.find((a) => a.id === 'supplier-document-intake')!.runs.length;
    applyAction(state, { type: 'automation.simulateRun', automationId: 'supplier-document-intake' });
    const a = state.automations.find((x) => x.id === 'supplier-document-intake')!;

    expect(a.runs).toHaveLength(before + 1);
    expect(a.runs[0].simulated).toBe(true);
    // Seed has 4 blocking + 1 advisory outstanding.
    expect(a.runs[0].itemsOut).toBe(5);
    expect(a.runs[0].note).toMatch(/4 blocking and 1 advisory/);
  });

  it('reflects work that has already been done', () => {
    // Resolve the document case, then the intake workflow should find nothing.
    applyAction(state, { type: 'case.create', documentId: 'DOC-PI-0418-R1' });
    const caseId = state.cases[0].id;
    applyAction(state, { type: 'case.simulateCorrected', caseId });
    applyAction(state, { type: 'case.revalidate', caseId });

    applyAction(state, { type: 'automation.simulateRun', automationId: 'supplier-document-intake' });
    const run = state.automations.find((x) => x.id === 'supplier-document-intake')!.runs[0];
    expect(run.outcome).toBe('Success');
    expect(run.note).toMatch(/1 blocking and 1 advisory|0 blocking/);
  });

  it('reports no work when there is none', () => {
    applyAction(state, { type: 'automation.simulateRun', automationId: 'approval-chaser' });
    const run = state.automations.find((x) => x.id === 'approval-chaser')!.runs[0];
    expect(run.outcome).toBe('No work to do');
    expect(run.itemsOut).toBe(0);
  });

  it('picks up an order once it is actually held on credit', () => {
    applyAction(state, {
      type: 'opportunity.createOrder',
      opportunityId: 'OPP-2026-014',
      customerId: 'C-NILEFLT',
      qty: 420,
      discountPct: 8,
    });
    applyAction(state, { type: 'automation.simulateRun', automationId: 'credit-hold-notifier' });
    const run = state.automations.find((x) => x.id === 'credit-hold-notifier')!.runs[0];
    // The seeded Minya order plus the one just created.
    expect(run.itemsIn).toBe(2);
    expect(run.note).toMatch(/held on credit/);
  });

  it('writes an activity entry attributed to the adapter, not to a person', () => {
    applyAction(state, { type: 'automation.simulateRun', automationId: 'daily-briefing' });
    const entry = state.activity[0];
    expect(entry.actor).toBe('n8n demo adapter');
    expect(entry.detail).toMatch(/No n8n instance was contacted/);
  });

  it('refuses to simulate a draft workflow', () => {
    expectRefusal(
      () => applyAction(state, { type: 'automation.simulateRun', automationId: 'erpnext-master-sync' }),
      /still a draft/,
      409,
    );
  });

  it('refuses to simulate a paused workflow, and resumes cleanly', () => {
    applyAction(state, { type: 'automation.setStatus', automationId: 'daily-briefing', status: 'Paused' });
    expectRefusal(
      () => applyAction(state, { type: 'automation.simulateRun', automationId: 'daily-briefing' }),
      /is paused/,
      409,
    );
    applyAction(state, { type: 'automation.setStatus', automationId: 'daily-briefing', status: 'Active' });
    applyAction(state, { type: 'automation.simulateRun', automationId: 'daily-briefing' });
    expect(state.automations.find((x) => x.id === 'daily-briefing')!.runs[0].simulated).toBe(true);
  });

  it('refuses a redundant status change and cannot activate a draft', () => {
    expectRefusal(
      () => applyAction(state, { type: 'automation.setStatus', automationId: 'daily-briefing', status: 'Active' }),
      /already active/,
      409,
    );
    expectRefusal(
      () => applyAction(state, { type: 'automation.setStatus', automationId: 'erpnext-master-sync', status: 'Active' }),
      /is a draft/,
      409,
    );
  });

  it('caps the run history so it cannot grow without bound', () => {
    for (let i = 0; i < 12; i++) {
      applyAction(state, { type: 'automation.simulateRun', automationId: 'approval-chaser' });
    }
    expect(state.automations.find((x) => x.id === 'approval-chaser')!.runs.length).toBeLessThanOrEqual(8);
  });

  it('rejects an unknown workflow', () => {
    expectRefusal(
      () => applyAction(state, { type: 'automation.simulateRun', automationId: 'does-not-exist' }),
      /not found/,
      404,
    );
  });
});

/* ---------------------------- The exported files --------------------------- */

describe('exported n8n workflow files', () => {
  const dir = path.resolve(process.cwd(), 'public/n8n');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  it('ships one export per defined workflow', () => {
    expect(files).toHaveLength(N8N_WORKFLOWS.length);
    for (const a of N8N_WORKFLOWS) {
      expect(files).toContain(a.workflowFile);
    }
  });

  it('is valid, importable n8n JSON', () => {
    for (const f of files) {
      const wf = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      expect(typeof wf.name).toBe('string');
      expect(Array.isArray(wf.nodes)).toBe(true);
      expect(wf.nodes.length).toBeGreaterThanOrEqual(4);
      expect(typeof wf.connections).toBe('object');

      // Every node has the fields n8n's importer requires.
      for (const n of wf.nodes) {
        expect(n.id).toBeTruthy();
        expect(n.name).toBeTruthy();
        expect(n.type).toMatch(/^n8n-nodes-base\./);
        expect(Array.isArray(n.position)).toBe(true);
      }

      // Connections must reference nodes that exist.
      const names = new Set(wf.nodes.map((n: { name: string }) => n.name));
      for (const targets of Object.values(wf.connections) as { main: { node: string }[][] }[]) {
        for (const t of targets.main.flat()) expect(names.has(t.node)).toBe(true);
      }
    }
  });

  it('starts every workflow on a trigger node', () => {
    for (const f of files) {
      const wf = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      expect(wf.nodes[0].type.toLowerCase()).toMatch(/trigger|webhook|emailreadimap/);
    }
  });

  it('imports inactive, so nothing runs the moment it lands', () => {
    for (const f of files) {
      const wf = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      expect(wf.active).toBe(false);
    }
  });

  it('embeds no credentials or hardcoded hosts', () => {
    for (const f of files) {
      const raw = readFileSync(path.join(dir, f), 'utf8');
      expect(raw).not.toMatch(/"credentials"\s*:/);
      expect(raw).not.toMatch(/api[_-]?key|password|secret|bearer /i);
      // Hosts must come from n8n variables, never be baked in.
      expect(raw).not.toMatch(/https?:\/\/(?!\s)[a-z0-9.-]*\.(com|net|io|dev)/i);
    }
  });
});
