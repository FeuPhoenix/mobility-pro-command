'use client';

/**
 * One request, from requirement through to the recorded outcome.
 *
 * The tabs follow the journey in order, and each one ends by pointing at the
 * next thing to do, so the manager is never left guessing what the application
 * is waiting for.
 */

import React from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Card, CardHead, Empty, Notice, Pill } from '@/components/ui';
import { useFreight } from '@/freight/ui/FreightProvider';
import { useRfqDetail } from '@/freight/ui/useRfqDetail';
import { EmailPanel } from '@/freight/ui/EmailPanel';
import { QuoteReview } from '@/freight/ui/QuoteReview';
import { ComparisonMatrix, RecommendationCard } from '@/freight/ui/ComparisonMatrix';
import {
  ConfirmButton,
  EmailStatusPill,
  Facts,
  QuoteStatusPill,
  RfqStatusPill,
  SyncStatusPill,
  formatDay,
  formatWhen,
  relativeHours,
  truncate,
} from '@/freight/ui/bits';
import type { RecipientStatus } from '@/freight/types';
import type { RfqDetail } from '@/freight/view';
import type { RecipientOption } from '@/freight/service/rfq';

type Tab = 'requirement' | 'recipients' | 'emails' | 'quotes' | 'comparison' | 'record' | 'activity';

export default function RfqDetailPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { refresh } = useFreight();
  const [version, setVersion] = React.useState(0);
  const { data, loading, error } = useRfqDetail(params.id, version);

  const bump = React.useCallback(() => {
    setVersion((v) => v + 1);
    void refresh();
  }, [refresh]);

  const focusedEmail = search.get('email');
  const focusedQuote = search.get('quote');
  const requestedTab = search.get('tab') as Tab | null;

  const [tab, setTab] = React.useState<Tab>('requirement');
  React.useEffect(() => {
    if (requestedTab) setTab(requestedTab);
    else if (focusedEmail) setTab('emails');
    else if (focusedQuote) setTab('quotes');
  }, [requestedTab, focusedEmail, focusedQuote]);

  if (loading) {
    return (
      <div className="page">
        <div className="stack" aria-busy="true" aria-label="Loading the request">
          <div className="skel" style={{ height: 96, borderRadius: 14 }} />
          <div className="skel" style={{ height: 320, borderRadius: 14 }} />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page">
        <Notice tone="bad" title="This request could not be opened. ">
          {error ?? 'It may have been removed.'}{' '}
          <Link href="/freight/rfqs">Back to all requests</Link>
        </Notice>
      </div>
    );
  }

  const { detail, recipientOptions } = data;
  const { rfq } = detail;

  const quotesToCheck = detail.quotes.filter(
    (q) => q.quote.status === 'needs_review' || q.quote.status === 'unreadable',
  ).length;
  const emailsNeedingApproval = detail.emails.filter(
    (e) => e.status === 'awaiting_approval' || e.status === 'approval_stale',
  ).length;

  const tabs: { key: Tab; label: string; count?: number; alert?: boolean }[] = [
    { key: 'requirement', label: 'Requirement' },
    { key: 'recipients', label: 'Providers', count: detail.recipients.length },
    { key: 'emails', label: 'Emails', count: emailsNeedingApproval, alert: emailsNeedingApproval > 0 },
    { key: 'quotes', label: 'Quotes', count: quotesToCheck, alert: quotesToCheck > 0 },
    { key: 'comparison', label: 'Comparison' },
    { key: 'record', label: 'Record' },
    { key: 'activity', label: 'Activity' },
  ];

  const go = (next: Tab) => {
    setTab(next);
    router.replace(`/freight/rfqs/${rfq.id}?tab=${next}`, { scroll: false });
  };

  return (
    <div className="page">
      <div className="fr-head">
        <div>
          <div className="fr-ref">{rfq.reference}</div>
          <h1>{rfq.title}</h1>
          <div className="sub">
            {detail.companyName} · {rfq.originPort} to {rfq.destinationPort} · {rfq.incoterm}
          </div>
        </div>
        <div className="fr-head-actions">
          <RfqStatusPill status={rfq.status} />
          <Link className="btn" href="/freight/rfqs">
            All requests
          </Link>
        </div>
      </div>

      <NextStep detail={detail} onGo={go} />

      <div className="fr-tabs" role="tablist" aria-label="Sections of this request">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            data-on={tab === t.key}
            data-alert={t.alert}
            onClick={() => go(t.key)}
          >
            {t.label}
            {t.count ? <span className="count">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'requirement' ? <Requirement detail={detail} /> : null}
      {tab === 'recipients' ? <Recipients detail={detail} options={recipientOptions} onChanged={bump} /> : null}
      {tab === 'emails' ? <Emails detail={detail} focused={focusedEmail} onChanged={bump} /> : null}
      {tab === 'quotes' ? <Quotes detail={detail} focused={focusedQuote} onChanged={bump} /> : null}
      {tab === 'comparison' ? <ComparisonTab detail={detail} onChanged={bump} /> : null}
      {tab === 'record' ? <RecordTab detail={detail} onChanged={bump} /> : null}
      {tab === 'activity' ? <Activity detail={detail} /> : null}
    </div>
  );
}

type Detail = RfqDetail;
type Options = RecipientOption[];

/** One sentence saying what the application is waiting for, and a way to do it. */
function NextStep({ detail, onGo }: { detail: Detail; onGo: (t: Tab) => void }) {
  const { rfq } = detail;
  const unapproved = detail.emails.filter((e) => e.status === 'awaiting_approval' || e.status === 'approval_stale');
  const approvedUnsent = detail.emails.filter((e) => e.status === 'approved');
  const toCheck = detail.quotes.filter((q) => q.quote.status === 'needs_review' || q.quote.status === 'unreadable');

  let message: string;
  let action: { label: string; tab: Tab } | null = null;

  if (rfq.status === 'draft' && detail.recipients.length === 0) {
    message = 'Choose which providers should receive this request.';
    action = { label: 'Choose providers', tab: 'recipients' };
  } else if (detail.emails.length === 0) {
    message = 'Prepare the RFQ emails for the selected providers.';
    action = { label: 'Go to emails', tab: 'emails' };
  } else if (unapproved.length > 0) {
    message = `${unapproved.length} email${unapproved.length === 1 ? '' : 's'} need your approval before anything is sent.`;
    action = { label: 'Review and approve', tab: 'emails' };
  } else if (approvedUnsent.length > 0) {
    message = `${approvedUnsent.length} approved email${approvedUnsent.length === 1 ? ' is' : 's are'} ready to send.`;
    action = { label: 'Send', tab: 'emails' };
  } else if (toCheck.length > 0) {
    message = `${toCheck.length} quotation${toCheck.length === 1 ? '' : 's'} need checking against the source before they can be compared.`;
    action = { label: 'Check quotes', tab: 'quotes' };
  } else if (rfq.status === 'collecting' || rfq.status === 'sent') {
    message = `Waiting for providers. The deadline is ${relativeHours(Math.round((Date.parse(rfq.responseDeadline) - Date.now()) / 3_600_000))}. Close collection when you are ready to compare.`;
    action = { label: 'Providers', tab: 'recipients' };
  } else if (!detail.comparison) {
    message = 'All responses are checked. Build the comparison.';
    action = { label: 'Build comparison', tab: 'comparison' };
  } else if (!detail.emails.some((e) => e.kind === 'comparison')) {
    message = 'The comparison is ready. Prepare the email to the manager.';
    action = { label: 'Open comparison', tab: 'comparison' };
  } else if (!detail.emails.some((e) => e.kind === 'comparison' && e.status === 'sent')) {
    message = 'The comparison email is waiting for approval.';
    action = { label: 'Review and approve', tab: 'emails' };
  } else if (!detail.sync || detail.sync.status !== 'success') {
    message = 'The outcome has not been recorded yet.';
    action = { label: 'Record the outcome', tab: 'record' };
  } else {
    message = 'This request is complete. The team decides which provider to book.';
  }

  return (
    <div className="notice info" style={{ marginBottom: 16 }}>
      <div className="row" style={{ gap: 12, width: '100%', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 220 }}>
          <b>Next: </b>
          {message}
        </span>
        {action ? (
          <button className="btn sm" onClick={() => onGo(action.tab)}>
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Requirement({ detail }: { detail: Detail }) {
  const { rfq } = detail;
  return (
    <div className="fr-grid two">
      <Card>
        <CardHead title="What was asked for" hint="This is what every provider was sent, word for word." />
        <div className="card-body stack">
          <Facts
            items={[
              { k: 'Reference', v: <span className="mono">{rfq.reference}</span> },
              { k: 'Company', v: detail.companyName },
              { k: 'Route', v: `${rfq.originPort} to ${rfq.destinationPort}` },
              { k: 'Incoterm', v: rfq.incoterm },
              { k: 'Ship between', v: `${formatDay(rfq.targetShipFrom)} and ${formatDay(rfq.targetShipTo)}` },
              { k: 'Response deadline', v: formatWhen(rfq.responseDeadline) },
              { k: 'Quote currency', v: rfq.requestedCurrency },
            ]}
          />
          <div>
            <div className="k" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6b7480' }}>
              Equipment
            </div>
            {rfq.containers.map((c, i) => (
              <div key={i} style={{ fontSize: 13.5, marginTop: 4 }}>
                {c.quantity} × {c.type} — {c.commodity}
                {c.grossWeightKg ? `, ${c.grossWeightKg.toLocaleString('en-GB')} kg gross each` : ''}
              </div>
            ))}
          </div>
          {rfq.cargoNotes ? (
            <div>
              <div className="k" style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6b7480' }}>
                Cargo notes
              </div>
              <p className="small" style={{ marginTop: 4 }}>
                {rfq.cargoNotes}
              </p>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHead title="Instructions sent to providers" />
        <div className="card-body">
          <p className="small">{rfq.instructions ?? 'No extra instructions were added.'}</p>
          <p className="fr-foot-note">
            Every RFQ email also asks for each surcharge separately, the transit time, free days,
            validity and payment terms, so the replies can be compared fairly.
          </p>
        </div>
      </Card>
    </div>
  );
}

const RECIPIENT_LABEL: Record<RecipientStatus, string> = {
  selected: 'Not sent yet',
  sent: 'Sent, awaiting reply',
  send_failed: 'Send failed',
  responded: 'Replied',
  declined: 'Declined to quote',
  no_response: 'No response',
};

function Recipients({
  detail,
  options,
  onChanged,
}: {
  detail: Detail;
  options: Options;
  onChanged: () => void;
}) {
  const { run, busy, state } = useFreight();
  const { rfq } = detail;
  const locked = rfq.status !== 'draft' && rfq.status !== 'awaiting_approval';
  const isManager = state?.user?.role === 'logistics_manager';

  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(options.filter((o) => o.selected).map((o) => o.linkId)),
  );
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    setSelected(new Set(options.filter((o) => o.selected).map((o) => o.linkId)));
  }, [options]);

  const needle = query.trim().toLowerCase();
  const shown = options.filter((o) =>
    needle ? o.providerName.toLowerCase().includes(needle) || o.lanes.join(' ').toLowerCase().includes(needle) : true,
  );

  const blocked = options.filter((o) => !o.contactable);
  const chosenCount = selected.size;

  async function save() {
    const result = await run({ type: 'rfq.setRecipients', rfqId: rfq.id, linkIds: [...selected] });
    if (result) onChanged();
  }

  const nonResponders = detail.recipients.filter(
    (r) => r.recipient.status === 'sent' || r.recipient.status === 'no_response',
  );

  return (
    <div className="stack">
      {locked ? (
        <Card className="flush">
          <CardHead
            title="Providers on this request"
            hint="The request has gone out, so the recipient list is fixed. Each provider only ever sees their own email."
          />
          <div>
            {detail.recipients.map((r) => (
              <div key={r.recipient.id} className="fr-row">
                <div className="main">
                  <div className="t">{r.providerName}</div>
                  <div className="m">{r.contacts.map((c) => c.email).join(', ') || 'no contacts on file'}</div>
                  {r.recipient.remindersSent > 0 ? (
                    <div className="m">
                      {r.recipient.remindersSent} reminder{r.recipient.remindersSent === 1 ? '' : 's'} sent
                    </div>
                  ) : null}
                </div>
                <div className="side">
                  <Pill
                    tone={
                      r.recipient.status === 'responded'
                        ? 'good'
                        : r.recipient.status === 'send_failed'
                          ? 'bad'
                          : r.recipient.status === 'no_response'
                            ? 'warn'
                            : 'neutral'
                    }
                  >
                    {RECIPIENT_LABEL[r.recipient.status]}
                  </Pill>
                </div>
              </div>
            ))}
          </div>
          {nonResponders.length > 0 && rfq.status !== 'completed' ? (
            <div className="card-body" style={{ borderTop: '1px solid var(--line, #e3e6ea)' }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="small">
                  {nonResponders.length} provider{nonResponders.length === 1 ? ' has' : 's have'} not replied.
                </span>
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() =>
                    void run({
                      type: 'rfq.prepareReminders',
                      rfqId: rfq.id,
                      linkIds: nonResponders.map((r) => r.recipient.companyProviderId),
                    }).then(onChanged)
                  }
                >
                  Prepare reminders
                </button>
                <span className="small muted">Reminders need approval too.</span>
              </div>
            </div>
          ) : null}

          {(rfq.status === 'collecting' || rfq.status === 'sent') && isManager ? (
            <div className="card-body" style={{ borderTop: '1px solid var(--line, #e3e6ea)' }}>
              <ConfirmButton
                className="btn"
                label="Close response collection"
                confirmLabel="Confirm - stop collecting"
                disabled={busy}
                onConfirm={() => run({ type: 'rfq.close', rfqId: rfq.id }).then(onChanged)}
              />
              <p className="fr-foot-note">
                Collection stays open until you close it. The deadline is shown to providers but does not
                close the request on its own.
              </p>
            </div>
          ) : null}
          {rfq.status === 'closed' || rfq.status === 'comparison_ready' ? (
            <div className="card-body" style={{ borderTop: '1px solid var(--line, #e3e6ea)' }}>
              <button
                className="btn ghost sm"
                disabled={busy}
                onClick={() => void run({ type: 'rfq.reopen', rfqId: rfq.id }).then(onChanged)}
              >
                Reopen for more responses
              </button>
            </div>
          ) : null}
        </Card>
      ) : (
        <>
          {blocked.length > 0 ? (
            <Notice tone="warn" title="Some providers cannot be contacted for this company. ">
              They are listed below and cannot be selected. This protects existing agreements and
              deliberate exclusions.
            </Notice>
          ) : null}

          <Card className="flush">
            <CardHead
              title="Choose providers"
              hint="One email is prepared per provider, so none of them sees who else was asked."
              right={
                <input
                  className="input"
                  style={{ width: 210 }}
                  type="search"
                  placeholder="Search name or lane"
                  aria-label="Search providers"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              }
            />
            <div className="prov-list">
              {shown.map((o) => (
                <label key={o.linkId} className="prov-item" data-blocked={!o.contactable}>
                  <input
                    className="check"
                    type="checkbox"
                    checked={selected.has(o.linkId)}
                    disabled={!o.contactable}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(o.linkId);
                      else next.delete(o.linkId);
                      setSelected(next);
                    }}
                  />
                  <div className="main" style={{ flex: 1, minWidth: 0 }}>
                    <div className="t">
                      {o.providerName}{' '}
                      {o.servesLane ? (
                        <Pill tone="good">Serves this lane</Pill>
                      ) : null}
                    </div>
                    <div className="m">
                      {o.contacts.length > 0
                        ? o.contacts.map((c) => c.email).join(', ')
                        : 'No contact email on file'}
                    </div>
                    {o.lanes.length > 0 ? (
                      <div className="m" style={{ marginTop: 4 }}>
                        {o.lanes.map((l) => (
                          <span key={l} className="lane-chip">
                            {l}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {o.blockedReason ? (
                      <div className="m" style={{ color: '#a3352f', marginTop: 4 }}>
                        Cannot be contacted: {o.blockedReason}
                      </div>
                    ) : null}
                  </div>
                  <div className="side">
                    <Pill tone={o.contactable ? 'neutral' : 'bad'}>{o.statusLabel}</Pill>
                  </div>
                </label>
              ))}
            </div>
            <div className="card-body" style={{ borderTop: '1px solid var(--line, #e3e6ea)' }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn primary" disabled={busy || chosenCount === 0} onClick={() => void save()}>
                  Save {chosenCount} recipient{chosenCount === 1 ? '' : 's'}
                </button>
                {detail.recipients.length > 0 ? (
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void run({ type: 'rfq.prepareEmails', rfqId: rfq.id }).then(onChanged)}
                  >
                    Prepare the RFQ emails
                  </button>
                ) : null}
              </div>
              <p className="fr-foot-note">
                Saving a recipient list sends nothing. Each email is prepared for you to read and approve.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Emails({ detail, focused, onChanged }: { detail: Detail; focused: string | null; onChanged: () => void }) {
  const { run, busy, state } = useFreight();
  const [open, setOpen] = React.useState<string | null>(focused);

  React.useEffect(() => {
    if (focused) setOpen(focused);
  }, [focused]);

  const emails = detail.emails;
  const approved = emails.filter((e) => e.status === 'approved');
  const isManager = state?.user?.role === 'logistics_manager';

  if (emails.length === 0) {
    return (
      <Card>
        <div className="card-body">
          <Empty title="No emails have been prepared">
            Choose the providers first, then prepare the RFQ emails. Each one is shown in full for
            approval before anything is sent.
          </Empty>
          {detail.recipients.length > 0 ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void run({ type: 'rfq.prepareEmails', rfqId: detail.rfq.id }).then(onChanged)}
            >
              Prepare the RFQ emails
            </button>
          ) : null}
        </div>
      </Card>
    );
  }

  const current = emails.find((e) => e.id === open) ?? null;

  return (
    <div className="stack">
      {approved.length > 1 && isManager ? (
        <Card>
          <div className="card-body">
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="small">
                {approved.length} emails are approved and ready to send.
              </span>
              <ConfirmButton
                className="btn primary"
                label={`Send all ${approved.length}`}
                confirmLabel={
                  state?.integrations?.mail.connected
                    ? 'Confirm - these will really send'
                    : 'Confirm (simulated send)'
                }
                disabled={busy}
                onConfirm={() =>
                  run({
                    type: 'email.sendBatch',
                    rfqId: detail.rfq.id,
                    emailIds: approved.map((e) => e.id),
                  }).then(onChanged)
                }
              />
            </div>
          </div>
        </Card>
      ) : null}

      <Card className="flush">
        <CardHead title="Emails on this request" hint="Select one to read it in full." />
        <div>
          {emails.map((e) => {
            const provider =
              detail.recipients.find((r) => r.recipient.companyProviderId === e.companyProviderId)?.providerName ??
              e.to.map((t) => t.name ?? t.email).join(', ');
            return (
              <button
                key={e.id}
                className="fr-row"
                style={{ width: '100%', textAlign: 'left', background: open === e.id ? '#f6f8fa' : undefined, border: 0, borderBottom: '1px solid var(--line, #e3e6ea)', cursor: 'pointer', font: 'inherit' }}
                onClick={() => setOpen(open === e.id ? null : e.id)}
                aria-expanded={open === e.id}
              >
                <div className="main">
                  <div className="t">
                    {e.kind === 'rfq' ? 'RFQ' : e.kind === 'reminder' ? 'Reminder' : 'Comparison'} — {provider}
                  </div>
                  <div className="m">{truncate(e.subject, 80)}</div>
                </div>
                <div className="side">
                  <EmailStatusPill status={e.status} simulated={e.simulated} />
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {current ? (
        <EmailPanel
          email={current}
          providerLabel={
            detail.recipients.find((r) => r.recipient.companyProviderId === current.companyProviderId)?.providerName ??
            current.to.map((t) => t.name ?? t.email).join(', ')
          }
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
}

function Quotes({ detail, focused, onChanged }: { detail: Detail; focused: string | null; onChanged: () => void }) {
  const [open, setOpen] = React.useState<string | null>(focused ?? detail.quotes[0]?.quote.id ?? null);

  React.useEffect(() => {
    if (focused) setOpen(focused);
  }, [focused]);

  if (detail.quotes.length === 0) {
    return (
      <Card>
        <div className="card-body">
          <Empty title="No quotations yet">
            Replies are collected automatically and matched to this request. Anything that cannot be
            matched waits in Replies for a person to attach it.
          </Empty>
        </div>
      </Card>
    );
  }

  const current = detail.quotes.find((q) => q.quote.id === open) ?? detail.quotes[0];

  return (
    <div className="stack">
      <Card className="flush">
        <CardHead title="Quotations received" hint="Each one must be checked against its source before it can be compared." />
        <div>
          {detail.quotes.map((q) => (
            <button
              key={q.quote.id}
              className="fr-row"
              style={{ width: '100%', textAlign: 'left', background: current.quote.id === q.quote.id ? '#f6f8fa' : undefined, border: 0, borderBottom: '1px solid var(--line, #e3e6ea)', cursor: 'pointer', font: 'inherit' }}
              onClick={() => setOpen(q.quote.id)}
            >
              <div className="main">
                <div className="t">
                  {q.providerName} {q.quote.version > 1 ? <Pill tone="info">Revised, v{q.quote.version}</Pill> : null}
                </div>
                <div className="m">
                  {q.uncertain.length > 0 ? q.uncertain.slice(0, 3).join('; ') : 'All figures read cleanly'}
                  {q.uncertain.length > 3 ? ` and ${q.uncertain.length - 3} more` : ''}
                </div>
              </div>
              <div className="side">
                <QuoteStatusPill status={q.quote.status} />
              </div>
            </button>
          ))}
        </div>
      </Card>

      <QuoteReview view={current} onChanged={onChanged} />
    </div>
  );
}

function ComparisonTab({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const { run, busy, state } = useFreight();
  const { rfq, comparison } = detail;
  const criteria = comparison?.criteria ?? state?.settings?.criteria ?? null;

  const [cost, setCost] = React.useState(criteria ? Math.round(criteria.weightCost * 100) : 60);
  const [transit, setTransit] = React.useState(criteria ? Math.round(criteria.weightTransit * 100) : 25);
  const [free, setFree] = React.useState(criteria ? Math.round(criteria.weightFreeDays * 100) : 15);

  const unchecked = detail.quotes.filter((q) => q.quote.status === 'needs_review').length;
  const comparisonEmail = detail.emails.find((e) => e.kind === 'comparison') ?? null;

  async function build() {
    const result = await run({
      type: 'comparison.build',
      rfqId: rfq.id,
      criteria: {
        weightCost: cost / 100,
        weightTransit: transit / 100,
        weightFreeDays: free / 100,
        minValidityDays: criteria?.minValidityDays ?? 7,
        baseCurrency: criteria?.baseCurrency ?? 'USD',
      },
    });
    if (result) onChanged();
  }

  return (
    <div className="stack">
      {unchecked > 0 ? (
        <Notice tone="warn" title={`${unchecked} quotation${unchecked === 1 ? '' : 's'} still need checking. `}>
          Unchecked offers are shown but kept out of the ranking, so a figure nobody has verified cannot
          decide the recommendation.
        </Notice>
      ) : null}

      <Card>
        <CardHead
          title="Ranking criteria"
          hint="Change the weights and rebuild. Nothing is hidden: these three numbers are the whole ranking."
        />
        <div className="card-body">
          <div className="row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Weight label="Cost" value={cost} onChange={setCost} />
            <Weight label="Transit time" value={transit} onChange={setTransit} />
            <Weight label="Free days" value={free} onChange={setFree} />
            <button className="btn primary" disabled={busy} onClick={() => void build()}>
              {comparison ? 'Rebuild comparison' : 'Build comparison'}
            </button>
          </div>
          <p className="fr-foot-note">
            Weights are normalised, so they do not have to add up to 100. Offers in a different currency
            or on a different container basis are never ranked against these - they are listed with what
            is needed to compare them.
          </p>
        </div>
      </Card>

      {!comparison ? (
        <Card>
          <div className="card-body">
            <Empty title="No comparison has been built yet">
              Build one once the responses you want are in. You can rebuild it at any time, and a
              correction made while checking a quote flows straight through.
            </Empty>
          </div>
        </Card>
      ) : (
        <>
          <RecommendationCard comparison={comparison} />

          <Card className="flush">
            <CardHead
              title="Side by side"
              hint="Rows where the offers differ are marked. Nothing missing is shown as zero."
              right={
                comparison.workbookKey ? (
                  <a className="btn sm" href={`/api/freight/file/${encodeURIComponent(comparison.workbookKey)}`}>
                    Download Excel
                  </a>
                ) : null
              }
            />
            <div className="card-body">
              <ComparisonMatrix comparison={comparison} quotes={detail.quotes} />
            </div>
          </Card>

          <Card>
            <CardHead title="Send the outcome to the manager" />
            <div className="card-body">
              {comparisonEmail ? (
                <p className="small">
                  The comparison email has been prepared and is in the Emails tab
                  {comparisonEmail.status === 'sent' ? ' and has been sent.' : ', waiting for approval.'}
                </p>
              ) : (
                <>
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() =>
                      void run({ type: 'comparison.prepareEmail', comparisonId: comparison.id }).then(onChanged)
                    }
                  >
                    Prepare the comparison email
                  </button>
                  <p className="fr-foot-note">
                    It includes a summary, the recommendation, the caveats and the Excel comparison. It
                    still needs approval before it is sent.
                  </p>
                </>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Weight({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const id = React.useId();
  return (
    <div className="field" style={{ minWidth: 150 }}>
      <label htmlFor={id}>
        {label}: {value}%
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function RecordTab({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const { run, busy, state } = useFreight();
  const { comparison, sync } = detail;
  const erp = state?.integrations?.erp;

  if (!comparison) {
    return (
      <Card>
        <div className="card-body">
          <Empty title="Nothing to record yet">Build the comparison first.</Empty>
        </div>
      </Card>
    );
  }

  return (
    <div className="stack">
      <Card>
        <CardHead
          title="ERPNext record"
          hint="The outcome of the comparison, recorded against the company and the RFQ reference."
          right={sync ? <SyncStatusPill status={sync.status} simulated={sync.adapter === 'simulated'} /> : null}
        />
        <div className="card-body stack">
          {erp && !erp.connected ? (
            <Notice tone="warn" title={`${erp.label}. `}>
              {erp.detail}
            </Notice>
          ) : null}

          {sync?.lastError ? (
            <Notice tone="bad" title={`Attempt ${sync.attempts} did not succeed. `}>
              {sync.lastError}
            </Notice>
          ) : null}

          {sync?.status === 'success' ? (
            <Facts
              items={[
                { k: 'Destination', v: sync.doctype ?? 'not recorded' },
                { k: 'Record', v: sync.remoteName ?? 'not recorded' },
                { k: 'Attempts', v: String(sync.attempts) },
                { k: 'Completed', v: sync.completedAt ? formatWhen(sync.completedAt) : '—' },
              ]}
            />
          ) : null}

          {sync && sync.setupRequirements.length > 0 ? (
            <div>
              <h3 style={{ fontSize: 13, marginBottom: 6 }}>Setup still required for a live ERPNext write</h3>
              <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
                {sync.setupRequirements.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {sync?.status !== 'success' ? (
              <ConfirmButton
                className="btn primary"
                label={sync && sync.attempts > 0 ? 'Retry recording' : 'Record the outcome'}
                confirmLabel={erp?.connected ? 'Confirm - write to ERPNext' : 'Confirm (recorded locally)'}
                disabled={busy}
                onConfirm={() => run({ type: 'erp.sync', comparisonId: comparison.id }).then(onChanged)}
              />
            ) : (
              <span className="small muted">
                This has been recorded. Retrying is blocked so it cannot be written twice.
              </span>
            )}
          </div>

          <p className="fr-foot-note">
            The record says the offer is <b>recommended, not selected</b>. Choosing and booking a provider
            stays with the team and happens outside this application.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Activity({ detail }: { detail: Detail }) {
  return (
    <Card className="flush">
      <CardHead title="Everything that happened" hint="Who did what, and when." />
      {detail.timeline.length === 0 ? (
        <div className="card-body">
          <Empty title="Nothing recorded yet" />
        </div>
      ) : (
        <div>
          {detail.timeline.map((e, i) => (
            <div key={i} className="fr-row">
              <div className="main">
                <div className="t" style={{ fontWeight: 450 }}>
                  {e.summary}
                </div>
                <div className="m">
                  {e.actor} · {formatWhen(e.at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
