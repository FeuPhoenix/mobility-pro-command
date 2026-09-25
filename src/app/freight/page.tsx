'use client';

/**
 * The overview.
 *
 * It is organised around the five questions the Logistics Operations Manager
 * actually opens the application to answer, in the order they matter:
 * what needs approving, what is waiting on providers, what needs checking,
 * what is ready to send, and what did not reach ERPNext.
 */

import React from 'react';
import Link from 'next/link';
import { Card, CardHead, Empty, Pill } from '@/components/ui';
import { useFreight } from '@/freight/ui/FreightProvider';
import { EmailStatusPill, RfqStatusPill, SyncStatusPill, formatWhen, relativeHours, truncate } from '@/freight/ui/bits';

export default function OverviewPage() {
  const { state } = useFreight();
  const overview = state?.overview;
  const [focus, setFocus] = React.useState<string | null>(null);

  if (!overview) return null;
  const c = overview.counts;

  const tiles = [
    { key: 'approvals', n: c.awaitingApproval, label: 'need your approval', urgent: c.awaitingApproval > 0 },
    { key: 'waiting', n: c.awaitingResponses, label: 'waiting for responses', urgent: false },
    { key: 'quotes', n: c.quotesToCheck, label: 'quotes to check', urgent: false },
    { key: 'replies', n: c.repliesToMatch, label: 'replies to match', urgent: c.repliesToMatch > 0 },
    { key: 'comparisons', n: c.comparisonsReady, label: 'comparisons ready', urgent: false },
    { key: 'erp', n: c.erpNeedsAttention, label: 'records to finish', urgent: c.erpNeedsAttention > 0 },
  ];

  return (
    <div className="page">
      <div className="fr-head">
        <div>
          <h1>Today</h1>
          <div className="sub">
            {state.user?.name}, here is what needs a decision. Nothing leaves this application without
            your approval.
          </div>
        </div>
        <div className="fr-head-actions">
          <Link className="btn" href="/freight/rfqs">
            All requests
          </Link>
          <Link className="btn primary" href="/freight/rfqs/new">
            New shipping requirement
          </Link>
        </div>
      </div>

      <div className="fr-tiles">
        {tiles.map((t) => (
          <button
            key={t.key}
            className="fr-tile"
            data-urgent={t.urgent}
            data-zero={t.n === 0}
            aria-pressed={focus === t.key}
            onClick={() => setFocus(focus === t.key ? null : t.key)}
          >
            <div className="n">{t.n}</div>
            <div className="l">{t.label}</div>
          </button>
        ))}
      </div>

      <div className="fr-grid two">
        <div className="stack">
          {show(focus, 'approvals') ? <ApprovalQueue /> : null}
          {show(focus, 'quotes') ? <QuotesToCheck /> : null}
          {show(focus, 'comparisons') ? <ComparisonsReady /> : null}
        </div>
        <div className="stack">
          {show(focus, 'replies') ? <RepliesToMatch /> : null}
          {show(focus, 'waiting') ? <AwaitingResponses /> : null}
          {show(focus, 'erp') ? <ErpQueue /> : null}
        </div>
      </div>
    </div>
  );
}

/** With no tile selected every section shows; selecting one filters to it. */
function show(focus: string | null, key: string): boolean {
  return focus === null || focus === key;
}

function ApprovalQueue() {
  const { state, run, busy } = useFreight();
  const items = state?.overview?.approvals ?? [];
  const canApprove = state?.user?.role === 'logistics_manager';

  return (
    <Card>
      <CardHead
        title="What needs my approval"
        hint={
          canApprove
            ? 'Open an email to read the full recipients, subject and body before approving.'
            : 'Only the Logistics Operations Manager can approve an email for sending.'
        }
      />
      {items.length === 0 ? (
        <div className="card-body">
          <Empty title="Nothing is waiting for approval">
            Prepared emails appear here the moment they are ready.
          </Empty>
        </div>
      ) : (
        <div>
          {items.map((a) => (
            <div key={a.emailId} className="fr-row">
              <div className="main">
                <div className="t">
                  {a.kindLabel} to {a.recipientLabel}
                </div>
                <div className="m">
                  <span className="fr-ref">{a.rfqReference}</span> · {truncate(a.subject, 78)}
                  {a.attachments > 0 ? ` · ${a.attachments} attachment${a.attachments === 1 ? '' : 's'}` : ''}
                </div>
                {a.stale ? (
                  <div className="m" style={{ color: '#a3352f' }}>
                    This was changed after it was approved, so it needs approving again.
                  </div>
                ) : null}
              </div>
              <div className="side">
                <EmailStatusPill status={a.status} />
                <Link className="btn sm" href={`/freight/rfqs/${a.rfqId}?email=${a.emailId}`}>
                  Review
                </Link>
                {canApprove && (a.status === 'awaiting_approval' || a.status === 'approval_stale') ? (
                  <button
                    className="btn sm primary"
                    disabled={busy}
                    onClick={() => void run({ type: 'email.approve', emailId: a.emailId })}
                  >
                    Approve
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AwaitingResponses() {
  const { state } = useFreight();
  const items = state?.overview?.waiting ?? [];
  return (
    <Card>
      <CardHead title="Waiting for responses" hint="Chase a provider from inside the request." />
      {items.length === 0 ? (
        <div className="card-body">
          <Empty title="No requests are out for quotation">
            Requests appear here once the RFQ email has been sent.
          </Empty>
        </div>
      ) : (
        <div>
          {items.map((r) => (
            <Link key={r.id} className="fr-row" href={`/freight/rfqs/${r.id}`}>
              <div className="main">
                <div className="t">{r.title}</div>
                <div className="m">
                  <span className="fr-ref">{r.reference}</span> · {r.route} · {r.responded} of {r.recipients}{' '}
                  replied
                </div>
                <div className="m" style={{ color: r.hoursToDeadline < 0 ? '#a3352f' : undefined }}>
                  Deadline {relativeHours(r.hoursToDeadline)}
                </div>
              </div>
              <div className="side">
                <RfqStatusPill status={r.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function QuotesToCheck() {
  const { state } = useFreight();
  const items = state?.overview?.quotesToCheck ?? [];
  return (
    <Card>
      <CardHead
        title="Quotes to check"
        hint="Extracted figures are never compared until a person has confirmed them against the source."
      />
      {items.length === 0 ? (
        <div className="card-body">
          <Empty title="Every quotation has been checked">
            New quotations appear here as soon as they are read.
          </Empty>
        </div>
      ) : (
        <div>
          {items.map((q) => (
            <Link key={q.quoteId} className="fr-row" href={`/freight/rfqs/${q.rfqId}?quote=${q.quoteId}`}>
              <div className="main">
                <div className="t">{q.providerName}</div>
                <div className="m">
                  <span className="fr-ref">{q.rfqReference}</span>
                  {q.issues.length > 0 ? ` · ${q.issues.slice(0, 2).join('; ')}` : ' · ready to confirm'}
                  {q.issues.length > 2 ? ` and ${q.issues.length - 2} more` : ''}
                </div>
              </div>
              <div className="side">
                <Pill tone={q.issues.length > 0 ? 'warn' : 'neutral'}>
                  {q.issues.length > 0 ? `${q.issues.length} to look at` : 'Check'}
                </Pill>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function RepliesToMatch() {
  const { state } = useFreight();
  const items = state?.overview?.repliesToMatch ?? [];
  return (
    <Card>
      <CardHead
        title="Replies to match"
        hint="These could not be attached to a request automatically, so nothing was assumed."
      />
      {items.length === 0 ? (
        <div className="card-body">
          <Empty title="Every reply has been matched">
            Replies that quote their reference are attached automatically.
          </Empty>
        </div>
      ) : (
        <div>
          {items.map((m) => (
            <Link key={m.messageId} className="fr-row" href={`/freight/inbox?message=${m.messageId}`}>
              <div className="main">
                <div className="t">{m.fromEmail}</div>
                <div className="m">{truncate(m.subject, 70)}</div>
                <div className="m">{m.basis}</div>
              </div>
              <div className="side">
                <Pill tone="warn">Needs a person</Pill>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function ComparisonsReady() {
  const { state } = useFreight();
  const items = state?.overview?.comparisonsReady ?? [];
  return (
    <Card>
      <CardHead title="Comparisons ready" hint="The recommendation supports your decision; it does not make it." />
      {items.length === 0 ? (
        <div className="card-body">
          <Empty title="No comparison is waiting">
            Close a request once responses are in, and the comparison can be built.
          </Empty>
        </div>
      ) : (
        <div>
          {items.map((c) => (
            <Link key={c.comparisonId} className="fr-row" href={`/freight/rfqs/${c.rfqId}?tab=comparison`}>
              <div className="main">
                <div className="t">
                  {c.recommended ? `Recommended: ${c.recommended}` : 'No offer could be recommended'}
                </div>
                <div className="m">
                  <span className="fr-ref">{c.rfqReference}</span> ·{' '}
                  {c.emailPrepared ? 'the email to the manager is prepared' : 'the email has not been prepared yet'}
                </div>
              </div>
              <div className="side">
                <Pill tone={c.emailPrepared ? 'warn' : 'info'}>{c.emailPrepared ? 'Approve email' : 'Open'}</Pill>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}

function ErpQueue() {
  const { state, run, busy } = useFreight();
  const items = state?.overview?.erp ?? [];
  return (
    <Card>
      <CardHead
        title="ERPNext records"
        hint="A retry is safe: each record carries a key so it cannot be written twice."
      />
      {items.length === 0 ? (
        <div className="card-body">
          <Empty title="No records are outstanding">
            A record is created when a comparison is complete.
          </Empty>
        </div>
      ) : (
        <div>
          {items.map((e) => (
            <div key={e.syncId} className="fr-row">
              <div className="main">
                <div className="t">
                  <span className="fr-ref">{e.rfqReference}</span>
                </div>
                <div className="m">
                  {e.error
                    ? truncate(e.error, 120)
                    : e.status === 'success'
                      ? e.simulated
                        ? 'Recorded in this application only. Nothing was written to ERPNext.'
                        : 'Written to ERPNext.'
                      : 'Not recorded yet.'}
                </div>
                {e.attempts > 0 ? (
                  <div className="m">
                    {e.attempts} attempt{e.attempts === 1 ? '' : 's'} so far
                  </div>
                ) : null}
              </div>
              <div className="side">
                <SyncStatusPill status={e.status} simulated={e.simulated} />
                {e.status !== 'success' ? (
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void run({ type: 'erp.sync', comparisonId: e.comparisonId })}
                  >
                    {e.attempts > 0 ? 'Retry' : 'Record'}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export { formatWhen };
