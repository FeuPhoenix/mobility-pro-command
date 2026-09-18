/**
 * n8n integration boundary.
 *
 * Mirrors `src/lib/erpnext/adapter.ts`: application logic never talks to n8n
 * directly, it talks to this interface. The demo ships one implementation —
 * `DemoN8nAdapter` — which reads the local workflow definitions and performs no
 * network I/O whatsoever.
 *
 * IMPORTANT
 *  - The UI must never say "Connected to n8n" unless `probe()` has actually
 *    succeeded against a configured instance. The default label is
 *    "n8n demo adapter".
 *  - Every run shown in the demo is invented and flagged `simulated`. Nothing
 *    has executed.
 *  - The exported workflow JSON under `/n8n/` is real and importable, but it is
 *    a starting point for the client's own instance, not something this demo
 *    drives.
 */

import { N8N_WORKFLOWS, lastRun } from '@/domain/automations';
import type { Automation, DemoState } from '@/domain/types';

export type N8nMode = 'demo' | 'readonly' | 'disabled';

export interface N8nStatus {
  /** Shown verbatim in the UI. Never say "connected" without a successful probe. */
  label: string;
  mode: N8nMode;
  connected: boolean;
  detail: string;
  /** n8n version, only ever populated by a real successful probe. */
  version?: string;
  lastProbedAt?: string;
}

/**
 * The HTTP surface this application exposes to n8n.
 *
 * These are the only ways a workflow can reach in. Each one is deliberately
 * narrow: n8n supplies observations, the application applies the rules and
 * returns the verdict. No endpoint lets a workflow set a state directly.
 */
export interface N8nEndpoint {
  method: 'GET' | 'POST';
  path: string;
  purpose: string;
  /** What the application does with the call — the rules stay on this side. */
  appBehaviour: string;
  status: 'designed' | 'implemented';
}

export const N8N_ENDPOINTS: N8nEndpoint[] = [
  {
    method: 'POST',
    path: '/api/automation/document-received',
    purpose: 'A supplier document plus its extracted fields.',
    appBehaviour:
      'Validates against the referenced purchase order under the import SOP and returns the blocking and advisory mismatches. Does not open a case.',
    status: 'designed',
  },
  {
    method: 'POST',
    path: '/api/automation/stock-snapshot',
    purpose: 'Current stock, lot ages and trailing shipped volume from ERPNext.',
    appBehaviour:
      'Applies INV-AGE-180 and the warehouse imbalance rule, returns any newly raised opportunities.',
    status: 'designed',
  },
  {
    method: 'POST',
    path: '/api/automation/master-sync',
    purpose: 'Reference data and receivables deltas, with an idempotency key per record.',
    appBehaviour: 'Upserts customers, items, warehouses, price lists and open invoices.',
    status: 'designed',
  },
  {
    method: 'GET',
    path: '/api/automation/approvals',
    purpose: 'Pending approval requests, for reminders and escalation.',
    appBehaviour: 'Returns requests with their age and approver. Read-only — no workflow can decide one.',
    status: 'designed',
  },
  {
    method: 'GET',
    path: '/api/automation/briefing',
    purpose: 'The ranked exception queue and the day’s measures.',
    appBehaviour: 'Returns exactly what the Overview screen shows, already ranked and owned.',
    status: 'designed',
  },
  {
    method: 'POST',
    path: '/api/automation/case-event',
    purpose: 'An outcome to record against a discrepancy case — delivered, chased, revision received.',
    appBehaviour: 'Appends to the case activity trail. Cannot change the case status.',
    status: 'designed',
  },
];

/** Outbound events the application would publish to n8n webhooks. */
export interface N8nOutboundEvent {
  event: string;
  firedWhen: string;
  consumedBy: string;
}

export const N8N_OUTBOUND_EVENTS: N8nOutboundEvent[] = [
  {
    event: 'clarification.approved',
    firedWhen: 'A person records a supplier clarification draft as sent.',
    consumedBy: 'supplier-clarification-dispatch',
  },
  {
    event: 'order.held',
    firedWhen: 'A credit check withholds automatic release of an order.',
    consumedBy: 'credit-hold-notifier',
  },
  {
    event: 'approval.requested',
    firedWhen: 'An approval request is raised against an order.',
    consumedBy: 'approval-chaser',
  },
  {
    event: 'approval.decided',
    firedWhen: 'An approver approves or rejects a request.',
    consumedBy: 'credit-hold-notifier (to close the loop with sales)',
  },
];

export interface N8nAdapter {
  status(): N8nStatus;
  probe(): Promise<N8nStatus>;
  listWorkflows(): Promise<Automation[]>;
  /** Would trigger a workflow by id. Not available on the demo adapter. */
  trigger(workflowId: string): Promise<never>;
}

/** The only adapter wired into the demo. No network, no credentials. */
export class DemoN8nAdapter implements N8nAdapter {
  constructor(private readonly state: DemoState) {}

  status(): N8nStatus {
    return {
      label: 'n8n demo adapter',
      mode: 'demo',
      connected: false,
      detail:
        'Reading local workflow definitions. No n8n instance is configured and no network request is made. Every run shown is simulated — nothing has executed.',
    };
  }

  async probe(): Promise<N8nStatus> {
    // Deliberately does not attempt a connection: there is nothing configured.
    return this.status();
  }

  async listWorkflows(): Promise<Automation[]> {
    return this.state.automations.length ? this.state.automations : N8N_WORKFLOWS;
  }

  async trigger(workflowId: string): Promise<never> {
    throw new Error(
      `Cannot trigger "${workflowId}": no n8n instance is connected. The Automations screen simulates a run locally instead.`,
    );
  }
}

export function resolveN8nAdapter(state: DemoState): N8nAdapter {
  return new DemoN8nAdapter(state);
}

/**
 * Even when N8N_BASE_URL is set, the demo stays on the demo adapter and says so:
 * connectivity has not been verified and no live adapter exists yet.
 */
export function n8nStatusForDisplay(state: DemoState): N8nStatus {
  const base = resolveN8nAdapter(state).status();
  if (!process.env.N8N_BASE_URL) return base;
  return {
    ...base,
    detail:
      'N8N_BASE_URL is set, but no live adapter is implemented and connectivity has not been verified. The demo continues to read local workflow definitions.',
  };
}

export { lastRun };
