'use client';

/**
 * Settings, kept deliberately small.
 *
 * Only the things that change how the workflow behaves: how offers are ranked,
 * which exchange rates may be applied, and when to chase a provider. Everything
 * else about the integrations is reported here rather than configured, because
 * credentials belong in the environment, not in a form in the browser.
 */

import React from 'react';
import { Card, CardHead, Field, Notice, Pill } from '@/components/ui';
import { useFreight } from '@/freight/ui/FreightProvider';
import type { FxRate } from '@/freight/types';

export default function SettingsPage() {
  const { state } = useFreight();
  if (!state) return null;

  return (
    <div className="page">
      <div className="fr-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">
            How offers are ranked, which conversions are allowed, and when providers are chased.
          </div>
        </div>
      </div>

      <div className="fr-grid two">
        <div className="stack">
          <CriteriaCard />
          <FxCard />
          <RemindersCard />
        </div>
        <div className="stack">
          <IntegrationsCard />
        </div>
      </div>
    </div>
  );
}

function CriteriaCard() {
  const { state, run, busy } = useFreight();
  const saved = state?.settings?.criteria;
  const [cost, setCost] = React.useState(saved ? Math.round(saved.weightCost * 100) : 60);
  const [transit, setTransit] = React.useState(saved ? Math.round(saved.weightTransit * 100) : 25);
  const [free, setFree] = React.useState(saved ? Math.round(saved.weightFreeDays * 100) : 15);
  const [validity, setValidity] = React.useState(saved?.minValidityDays ?? 7);
  const [currency, setCurrency] = React.useState(saved?.baseCurrency ?? 'USD');

  const total = cost + transit + free;

  return (
    <Card>
      <CardHead
        title="Default ranking criteria"
        hint="These three weights are the whole ranking. There is no hidden score and no provider reliability rating."
      />
      <div className="card-body stack">
        <div className="g3">
          <Field label={`Cost ${pct(cost, total)}`}>
            <input type="range" min={0} max={100} step={5} value={cost} onChange={(e) => setCost(Number(e.target.value))} />
          </Field>
          <Field label={`Transit time ${pct(transit, total)}`}>
            <input type="range" min={0} max={100} step={5} value={transit} onChange={(e) => setTransit(Number(e.target.value))} />
          </Field>
          <Field label={`Free days ${pct(free, total)}`}>
            <input type="range" min={0} max={100} step={5} value={free} onChange={(e) => setFree(Number(e.target.value))} />
          </Field>
        </div>
        <div className="g2">
          <Field label="Flag offers expiring within (days)">
            <input
              className="input"
              type="number"
              min={0}
              max={90}
              value={validity}
              onChange={(e) => setValidity(Number(e.target.value))}
            />
          </Field>
          <Field label="Comparison currency" help="Offers in another currency need a recorded exchange rate.">
            <input
              className="input mono"
              maxLength={3}
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </Field>
        </div>
        <div>
          <button
            className="btn primary"
            disabled={busy || total === 0}
            onClick={() =>
              void run({
                type: 'settings.criteria',
                criteria: {
                  weightCost: cost / 100,
                  weightTransit: transit / 100,
                  weightFreeDays: free / 100,
                  minValidityDays: validity,
                  baseCurrency: currency,
                },
              })
            }
          >
            Save criteria
          </button>
          <p className="fr-foot-note">
            Weights do not have to add up to 100; they are normalised. Existing comparisons keep the
            criteria they were built with, so a saved comparison never changes underneath a decision.
          </p>
        </div>
      </div>
    </Card>
  );
}

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((n / total) * 100)}%` : '0%';
}

function FxCard() {
  const { state, run, busy } = useFreight();
  const [rates, setRates] = React.useState<FxRate[]>(state?.settings?.fxRates ?? []);
  const [from, setFrom] = React.useState('EUR');
  const [to, setTo] = React.useState('USD');
  const [rate, setRate] = React.useState('');
  const [source, setSource] = React.useState('');
  const [asOf, setAsOf] = React.useState(new Date().toISOString().slice(0, 10));

  React.useEffect(() => {
    setRates(state?.settings?.fxRates ?? []);
  }, [state?.settings?.fxRates]);

  function add() {
    const next = [
      ...rates.filter((r) => !(r.from === from && r.to === to)),
      { from, to, rate: Number(rate), source, asOf },
    ];
    setRates(next);
    void run({ type: 'settings.fxRates', rates: next });
    setRate('');
    setSource('');
  }

  return (
    <Card>
      <CardHead
        title="Exchange rates"
        hint="Offers in a different currency are only converted when a rate with a source and a date exists. Otherwise they are flagged, never guessed."
      />
      <div className="card-body stack">
        {rates.length === 0 ? (
          <p className="small muted">
            No rates recorded. Any offer quoted in a currency other than the comparison currency will be
            listed as not comparable, with an explanation.
          </p>
        ) : (
          <div>
            {rates.map((r, i) => (
              <div key={`${r.from}${r.to}`} className="row" style={{ gap: 10, padding: '6px 0', fontSize: 13, alignItems: 'center' }}>
                <span className="mono">
                  1 {r.from} = {r.rate} {r.to}
                </span>
                <span className="muted">
                  {r.source}, {r.asOf}
                </span>
                <button
                  className="btn ghost sm"
                  style={{ marginLeft: 'auto' }}
                  disabled={busy}
                  onClick={() => {
                    const next = rates.filter((_, n) => n !== i);
                    setRates(next);
                    void run({ type: 'settings.fxRates', rates: next });
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="From">
            <input className="input mono" style={{ width: 74 }} maxLength={3} value={from} onChange={(e) => setFrom(e.target.value.toUpperCase())} />
          </Field>
          <Field label="To">
            <input className="input mono" style={{ width: 74 }} maxLength={3} value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Rate">
            <input className="input" style={{ width: 110 }} type="number" step="any" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
          <Field label="Source">
            <input className="input" style={{ minWidth: 170 }} placeholder="e.g. CBE daily rate" value={source} onChange={(e) => setSource(e.target.value)} />
          </Field>
          <Field label="As of">
            <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <button className="btn" disabled={busy || !rate || !source} onClick={add}>
            Add rate
          </button>
        </div>
      </div>
    </Card>
  );
}

function RemindersCard() {
  const { state, run, busy } = useFreight();
  const [after, setAfter] = React.useState(state?.settings?.remindersAfterDays ?? 3);
  const [rounds, setRounds] = React.useState(state?.settings?.remindersMaxRounds ?? 2);

  return (
    <Card>
      <CardHead
        title="Chasing non-responders"
        hint="Reminders are prepared for you, never sent automatically. Every one still needs approval."
      />
      <div className="card-body stack">
        <div className="g2">
          <Field label="Suggest a reminder after (days)">
            <input className="input" type="number" min={1} max={30} value={after} onChange={(e) => setAfter(Number(e.target.value))} />
          </Field>
          <Field label="Most reminders per provider">
            <input className="input" type="number" min={0} max={5} value={rounds} onChange={(e) => setRounds(Number(e.target.value))} />
          </Field>
        </div>
        <div>
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void run({ type: 'settings.reminders', afterDays: after, maxRounds: rounds })}
          >
            Save
          </button>
        </div>
      </div>
    </Card>
  );
}

function IntegrationsCard() {
  const { state, run, busy } = useFreight();
  const i = state?.integrations;
  if (!i) return null;

  const blocks: {
    title: string;
    s: { label: string; connected: boolean; detail: string; setupRequirements: string[]; lastProbedAt?: string };
    check?: 'mail' | 'mailbox' | 'erp';
  }[] = [
    { title: 'Outgoing email', s: i.mail, check: i.mail.kind === 'graph' ? 'mail' : undefined },
    { title: 'Incoming email', s: i.mailbox, check: i.mailbox.kind === 'graph' ? 'mailbox' : undefined },
    { title: 'ERPNext', s: i.erp, check: i.erp.kind === 'live' ? 'erp' : undefined },
    {
      title: 'AI assistance',
      s: { label: i.ai.label, connected: i.ai.enabled, detail: i.ai.detail, setupRequirements: i.ai.setupRequirements },
    },
  ];

  return (
    <Card>
      <CardHead
        title="Connections"
        hint="What is actually running. Credentials are set in the environment on the server, never here."
      />
      <div className="card-body stack">
        {blocks.map((b) => (
          <div key={b.title}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <strong style={{ fontSize: 13.5 }}>{b.title}</strong>
              <Pill tone={b.s.connected ? 'good' : 'neutral'}>{b.s.connected ? 'Connected' : 'Not connected'}</Pill>
              {b.check ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void run({ type: 'connection.check', target: b.check })}
                >
                  Check connection
                </button>
              ) : null}
            </div>
            <p className="small muted" style={{ marginTop: 4, lineHeight: 1.55 }}>
              {b.s.detail}
              {b.s.lastProbedAt ? ` Last checked ${new Date(b.s.lastProbedAt).toLocaleString('en-GB')}.` : ''}
            </p>
            {b.s.setupRequirements.length > 0 ? (
              <ul className="small muted" style={{ paddingLeft: 18, marginTop: 5, lineHeight: 1.6 }}>
                {b.s.setupRequirements.map((r, n) => (
                  <li key={n}>{r}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}

        <CollectionStatus />

        {i.demoMode ? (
          <Notice tone="warn" title="This workspace holds demonstration data. ">
            Every company, provider and rate in it is fictional, and every address ends in{' '}
            <code>.test</code>, which cannot receive email.
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}

function CollectionStatus() {
  const { state, run, busy } = useFreight();
  const c = state?.integrations?.collection;
  if (!c) return null;
  const last = c.lastRun;
  const canEdit = state?.user?.role !== 'viewer';

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <strong style={{ fontSize: 13.5 }}>Reply collection</strong>
        <Pill tone={c.pollSeconds ? 'good' : 'neutral'}>{c.pollSeconds ? 'Scheduled' : 'Not scheduled'}</Pill>
        {canEdit ? (
          <button type="button" className="btn sm" disabled={busy} onClick={() => void run({ type: 'mailbox.collect' })}>
            Collect now
          </button>
        ) : null}
      </div>
      <p className="small muted" style={{ marginTop: 4, lineHeight: 1.55 }}>
        {c.pollSeconds
          ? `The Mailbox Collector checks for new replies every ${c.pollSeconds} seconds.`
          : 'No schedule is running. Set MAILBOX_POLL_SECONDS on the server to collect replies automatically.'}
        {c.externalTrigger ? ' An external scheduler may also trigger collection.' : ''} Collection only files
        replies; it cannot edit, approve or send anything.
      </p>
      {last ? (
        <p className="small muted" style={{ marginTop: 4, lineHeight: 1.55 }} data-testid="last-collection">
          Last run {new Date(last.finishedAt).toLocaleString('en-GB')} (
          {last.trigger === 'manual' && last.requestedBy ? `requested by ${last.requestedBy}` : last.trigger}
          {last.adapter === 'simulated' ? ', simulated mailbox' : ''}):{' '}
          {last.outcome === 'failed'
            ? `failed. ${last.error}`
            : `${last.filed} new, ${last.matched} matched, ${last.needsReview} waiting for a person${last.duplicates > 0 ? `, ${last.duplicates} already collected` : ''}.`}
          {last.quarantined.length > 0
            ? ` ${last.quarantined.length} message${last.quarantined.length === 1 ? ' was' : 's were'} set aside after repeated failures; see the activity log.`
            : ''}
        </p>
      ) : null}
    </div>
  );
}
