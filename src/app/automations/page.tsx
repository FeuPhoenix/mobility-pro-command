'use client';

import React, { useMemo, useState } from 'react';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, Empty, Notice, PageLoading, Pill } from '@/components/ui';
import { lastRun, triggerDetail, triggerLabel } from '@/domain/automations';
import { N8N_ENDPOINTS, N8N_OUTBOUND_EVENTS } from '@/lib/n8n/adapter';
import { byId } from '@/domain/selectors';
import { formatDateTime } from '@/domain/money';
import type { Automation, AutomationStatus } from '@/domain/types';

const STATUS_TONE: Record<AutomationStatus, 'good' | 'neutral' | 'warn'> = {
  Active: 'good',
  Paused: 'neutral',
  Draft: 'warn',
};

const OUTCOME_TONE = {
  Success: 'good',
  'No work to do': 'neutral',
  Partial: 'warn',
  Failed: 'bad',
} as const;

export default function AutomationsPage() {
  const { state, dispatch, busy } = useDemo();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSeam, setShowSeam] = useState(false);

  const automations = useMemo(() => state?.automations ?? [], [state]);
  const selected: Automation | undefined =
    automations.find((a) => a.id === selectedId) ?? automations[0];

  if (!state) return <PageLoading />;
  if (automations.length === 0) {
    return (
      <div className="page">
        <Card>
          <Empty title="No automations defined" />
        </Card>
      </div>
    );
  }

  const active = automations.filter((a) => a.status === 'Active').length;
  const owner = selected ? byId(state.users, selected.ownerId) : undefined;
  const latest = selected ? lastRun(selected) : undefined;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Automations</h1>
        <p className="sub">
          The n8n workflows that surround this application. This layer decides — it detects the
          exception and owns the rule. n8n does the work around it: polling ERPNext, sending the
          message, chasing the approver, writing the outcome back.
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Notice tone="warn" title="n8n demo adapter — not connected">
          No n8n instance is configured and no network request is made. Every run below is
          simulated so you can see what the surface looks like in use. Each workflow can be
          downloaded as a real, importable n8n export.
        </Notice>
      </div>

      <div className="grid g-detail">
        {/* --------------------------- Workflow list --------------------------- */}
        <div className="stack">
          <Card className="flush">
            <CardHead
              title="Workflows"
              hint="Select one to see its steps, its guardrail and its run history."
              right={
                <span className="tiny muted num">
                  {active} active · {automations.length} defined
                </span>
              }
            />
            <div>
              {automations.map((a) => {
                const run = lastRun(a);
                const isSel = selected?.id === a.id;
                return (
                  <button
                    key={a.id}
                    className="wf-row"
                    data-selected={isSel}
                    onClick={() => setSelectedId(a.id)}
                    aria-current={isSel}
                  >
                    <span className="wf-main">
                      <span className="wf-top">
                        <span className="wf-name">{a.name}</span>
                        <Pill tone={STATUS_TONE[a.status]}>{a.status}</Pill>
                      </span>
                      <span className="wf-purpose">{a.purpose}</span>
                      <span className="wf-meta">
                        <span>{triggerLabel(a)}</span>
                        <span className="sep">·</span>
                        <span>{a.journey}</span>
                        {run ? (
                          <>
                            <span className="sep">·</span>
                            <span>last run {formatDateTime(run.at)}</span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* ------------------------- The integration seam ------------------------- */}
          <Card className="flush">
            <button
              className="disclosure"
              onClick={() => setShowSeam((v) => !v)}
              aria-expanded={showSeam}
              aria-controls="seam-body"
            >
              <span>
                <span className="disclosure-title">The seam between n8n and this app</span>
                <span className="disclosure-sub">
                  {N8N_ENDPOINTS.length} inbound endpoints · {N8N_OUTBOUND_EVENTS.length} outbound events
                </span>
              </span>
              <span className="disclosure-chev" data-open={showSeam} aria-hidden>
                →
              </span>
            </button>

            <div id="seam-body" hidden={!showSeam}>
              <div className="table-wrap" style={{ borderTop: '1px solid var(--line)' }}>
                <table className="t">
                  <thead>
                    <tr>
                      <th>n8n calls in</th>
                      <th>What it sends</th>
                      <th>What this app does with it</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {N8N_ENDPOINTS.map((e) => (
                      <tr key={e.path}>
                        <td>
                          <span className="mono tiny" style={{ color: 'var(--accent-ink)' }}>
                            {e.method}
                          </span>
                          <div className="mono" style={{ fontSize: 12 }}>
                            {e.path}
                          </div>
                        </td>
                        <td className="tiny">{e.purpose}</td>
                        <td className="tiny muted">{e.appBehaviour}</td>
                        <td>
                          <Pill tone={e.status === 'implemented' ? 'good' : 'neutral'}>{e.status}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-wrap" style={{ borderTop: '1px solid var(--line)' }}>
                <table className="t">
                  <thead>
                    <tr>
                      <th>This app fires out</th>
                      <th>When</th>
                      <th>Consumed by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {N8N_OUTBOUND_EVENTS.map((e) => (
                      <tr key={e.event}>
                        <td className="mono" style={{ fontSize: 12 }}>
                          {e.event}
                        </td>
                        <td className="tiny">{e.firedWhen}</td>
                        <td className="tiny muted mono">{e.consumedBy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
                <div className="tiny muted">
                  Every inbound endpoint is deliberately narrow: a workflow supplies observations,
                  this application applies the rules and returns the verdict. None of them lets a
                  workflow set a state directly — no workflow can open a case, approve an order or
                  change a credit limit.
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* ---------------------------- Detail panel ---------------------------- */}
        {selected ? (
          <div className="stack">
            <Card>
              <CardHead
                eyebrow={selected.journey}
                title={selected.name}
                right={<Pill tone={STATUS_TONE[selected.status]}>{selected.status}</Pill>}
              />
              <div className="card-body stack">
                <p className="small">{selected.purpose}</p>

                <dl className="kv">
                  <dt>Trigger</dt>
                  <dd>{triggerLabel(selected)}</dd>
                  <dt>{selected.trigger.kind === 'schedule' ? 'Cron' : selected.trigger.kind === 'webhook' ? 'Path' : 'Mailbox'}</dt>
                  <dd className="mono tiny">{triggerDetail(selected)}</dd>
                  <dt>Owner</dt>
                  <dd>{owner?.name}</dd>
                  <dt>Workflow file</dt>
                  <dd className="mono tiny">{selected.workflowFile}</dd>
                </dl>

                <div className="row">
                  <button
                    className="btn primary sm"
                    disabled={busy || selected.status !== 'Active'}
                    onClick={() =>
                      void dispatch({ type: 'automation.simulateRun', automationId: selected.id })
                    }
                  >
                    Simulate a run
                  </button>
                  {selected.status !== 'Draft' ? (
                    <button
                      className="btn sm"
                      disabled={busy}
                      onClick={() =>
                        void dispatch({
                          type: 'automation.setStatus',
                          automationId: selected.id,
                          status: selected.status === 'Active' ? 'Paused' : 'Active',
                        })
                      }
                    >
                      {selected.status === 'Active' ? 'Pause' : 'Resume'}
                    </button>
                  ) : null}
                  <a className="btn sm" href={`/n8n/${selected.workflowFile}`} download>
                    Download workflow
                  </a>
                </div>

                <div className="tiny muted">
                  &ldquo;Simulate a run&rdquo; evaluates what this workflow would find in the
                  current demo data and records it as a simulated run. No n8n instance is contacted
                  and no message is sent.
                </div>
              </div>
            </Card>

            <Card className="flush">
              <CardHead title="Steps" hint="These are the real n8n node types used in the exported workflow." />
              <div className="wf-steps">
                {selected.steps.map((s, i) => (
                  <div className="wf-step" key={i}>
                    <span className="wf-step-n">{i + 1}</span>
                    <span className="wf-step-main">
                      <b>{s.label}</b>
                      <span className="wf-step-node mono">{s.node}</span>
                      <span className="wf-step-detail">{s.detail}</span>
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHead title="Boundaries" />
              <div className="card-body stack" style={{ gap: 11 }}>
                <div className="band deterministic">
                  <b>Writes back</b>
                  {selected.writesBack}
                </div>
                <div className="band assumption">
                  <b>What it will not do</b>
                  {selected.guardrail}
                </div>
              </div>
            </Card>

            <Card className="flush">
              <CardHead
                title="Run history"
                hint="Simulated. Nothing here has executed."
                right={
                  latest ? (
                    <Pill tone={OUTCOME_TONE[latest.outcome]}>{latest.outcome}</Pill>
                  ) : null
                }
              />
              {selected.runs.length === 0 ? (
                <Empty title="Never run" />
              ) : (
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Outcome</th>
                        <th className="r">In / out</th>
                        <th className="r">Took</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.runs.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <div className="tiny">{formatDateTime(r.at)}</div>
                            <div className="tiny muted" style={{ maxWidth: '34ch' }}>
                              {r.note}
                            </div>
                          </td>
                          <td>
                            <Pill tone={OUTCOME_TONE[r.outcome]}>{r.outcome}</Pill>
                          </td>
                          <td className="r tiny">
                            {r.itemsIn} / {r.itemsOut}
                          </td>
                          <td className="r tiny">{(r.durationMs / 1000).toFixed(1)}s</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
