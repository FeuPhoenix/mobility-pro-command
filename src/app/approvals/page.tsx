'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, Empty, Field, Notice, PageLoading, Pill } from '@/components/ui';
import { byId } from '@/domain/selectors';
import { formatDateTime } from '@/domain/money';
import type { ApprovalRequest, ApprovalStatus } from '@/domain/types';

const TONE: Record<ApprovalStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  Pending: 'warn',
  Approved: 'good',
  Rejected: 'bad',
  'Stale - inputs changed': 'bad',
  Withdrawn: 'neutral',
};

export default function ApprovalsPage() {
  const { state, dispatch, busy } = useDemo();
  const params = useSearchParams();
  const focus = params.get('focus');
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (!state) return <PageLoading />;

  const pending = state.approvals.filter((a) => a.status === 'Pending');
  const decided = state.approvals.filter((a) => a.status !== 'Pending');
  const me = byId(state.users, state.meta.currentUserId)!;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Approvals</h1>
        <p className="sub">
          Decisions that policy reserves to a named role, each with the evidence the approver needs,
          the impact of saying yes, and a permanent record of who decided what.
        </p>
      </div>

      <div className="stack">
        {pending.length === 0 && decided.length === 0 ? (
          <Card>
            <Empty title="Nothing is waiting for a decision">
              Approval requests appear here when an order falls outside credit policy or a discount
              exceeds the requester&apos;s authority. Work through the inventory journey to raise one.
            </Empty>
          </Card>
        ) : null}

        {pending.map((a) => (
          <ApprovalCard
            key={a.id}
            approval={a}
            state={state}
            focus={focus === a.id}
            note={notes[a.id] ?? ''}
            setNote={(v) => setNotes((n) => ({ ...n, [a.id]: v }))}
            busy={busy}
            currentRole={me.role}
            currentName={me.name}
            onDecide={(decision) =>
              void dispatch({ type: 'approval.decide', approvalId: a.id, decision, note: notes[a.id] ?? '' })
            }
          />
        ))}

        {decided.length ? (
          <Card className="flush">
            <CardHead title="Decision history" hint="Every decision is retained with its author, timestamp and note." />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>Subject</th>
                    <th>Outcome</th>
                    <th>Decided by</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {decided.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="mono primary-cell">{a.id}</div>
                        <div className="tiny muted">{a.title}</div>
                      </td>
                      <td>
                        <Link href={`/operations/orders/${a.subjectRef.id}`} className="mono">
                          {a.subjectRef.id}
                        </Link>
                      </td>
                      <td>
                        <Pill tone={TONE[a.status]}>{a.status}</Pill>
                      </td>
                      <td className="tiny">
                        {a.decidedBy ? byId(state.users, a.decidedBy)?.name : '—'}
                        <div className="muted">{a.decidedAt ? formatDateTime(a.decidedAt) : ''}</div>
                      </td>
                      <td className="tiny muted" style={{ maxWidth: '36ch' }}>
                        {a.decisionNote ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function ApprovalCard({
  approval,
  state,
  focus,
  note,
  setNote,
  busy,
  currentRole,
  currentName,
  onDecide,
}: {
  approval: ApprovalRequest;
  state: NonNullable<ReturnType<typeof useDemo>['state']>;
  focus: boolean;
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  currentRole: string;
  currentName: string;
  onDecide: (decision: 'Approved' | 'Rejected') => void;
}) {
  const requester = byId(state.users, approval.requestedBy);
  const roleLabel = approval.approverRole === 'finance' ? 'Finance Director' : 'Commercial Director';
  const authorised = currentRole === approval.approverRole;

  return (
    <Card
      style={focus ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px rgba(13,111,92,0.12)' } : undefined}
    >
      <CardHead
        eyebrow={`Routed to the ${roleLabel} · ${approval.policyRefs.join(', ')}`}
        title={approval.title}
        hint={`Requested by ${requester?.name} (${requester?.title}) on ${formatDateTime(approval.requestedAt)}`}
        right={<Pill tone={TONE[approval.status]}>{approval.status}</Pill>}
      />
      <div className="card-body stack">
        <p className="small">{approval.proposal}</p>

        <div className="grid g2">
          <div>
            <div className="eyebrow" style={{ marginBottom: 7 }}>Evidence</div>
            <dl className="kv">
              {approval.evidence.map((e, i) => (
                <React.Fragment key={i}>
                  <dt>{e.label}</dt>
                  <dd
                    style={
                      e.tone === 'bad'
                        ? { color: 'var(--red)', fontWeight: 600 }
                        : e.tone === 'good'
                          ? { color: 'var(--accent-ink)' }
                          : e.tone === 'warn'
                            ? { color: 'var(--amber)' }
                            : undefined
                    }
                  >
                    {e.value}
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 7 }}>If approved</div>
            <dl className="kv">
              {approval.impact.map((e, i) => (
                <React.Fragment key={i}>
                  <dt>{e.label}</dt>
                  <dd>{e.value}</dd>
                </React.Fragment>
              ))}
            </dl>
            <div className="tiny muted" style={{ marginTop: 9, lineHeight: 1.5 }}>
              Approving releases the order and reserves stock. It does not recognise revenue, collect
              cash, or settle the overdue balance.
            </div>
          </div>
        </div>

        <Notice tone="info" title="This approval lapses automatically">
          If order quantity, unit price, the customer credit limit or the overdue balance change
          after this request, it becomes stale and must be resubmitted (CR-5.4).
        </Notice>

        {!authorised ? (
          <Notice tone="warn" title={`You are acting as ${currentName}`}>
            This request is routed to the {roleLabel}. Change the role in the top bar to record a
            decision — the server refuses it otherwise.
          </Notice>
        ) : null}

        <Field label="Decision note (optional)">
          <textarea
            className="input"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Recorded permanently against this decision."
          />
        </Field>

        <div className="row">
          <button className="btn primary" disabled={busy || !authorised} onClick={() => onDecide('Approved')}>
            Approve
          </button>
          <button className="btn danger" disabled={busy || !authorised} onClick={() => onDecide('Rejected')}>
            Reject
          </button>
          <Link className="btn ghost" href={`/operations/orders/${approval.subjectRef.id}`}>
            Open {approval.subjectRef.id}
          </Link>
        </div>
      </div>
    </Card>
  );
}
