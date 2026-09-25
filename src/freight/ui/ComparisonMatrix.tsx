'use client';

/**
 * The side-by-side comparison.
 *
 * Providers run across the top and stay readable while the table scrolls; the
 * field names stay pinned on the left. Rows where the offers actually differ
 * are marked, because those are the rows a buyer reads. Confirmed values,
 * missing values and converted values are visually distinct, and an offer that
 * could not be compared keeps its column with the reason in it rather than
 * being dropped.
 */

import React from 'react';
import { Card, CardHead, Notice } from '@/components/ui';
import type { Comparison, Quote } from '@/freight/types';
import { CHARGE_BASIS_LABEL } from '@/freight/types';
import type { QuoteView } from '@/freight/view';
import { describeIssue } from '@/freight/domain/comparison';
import { formatDay } from './bits';

type Tone = 'good' | 'warn' | 'bad' | undefined;
interface Cell {
  text: string;
  tone?: Tone;
  missing?: boolean;
}

export function ComparisonMatrix({
  comparison,
  quotes,
}: {
  comparison: Comparison;
  quotes: QuoteView[];
}) {
  const quoteById = new Map(quotes.map((q) => [q.quote.id, q.quote]));
  const cur = comparison.criteria.baseCurrency;
  const lines = comparison.lines;

  const money = (n: number | null, currency: string | null): Cell =>
    n === null
      ? { text: 'not available', missing: true }
      : { text: `${currency ?? cur} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` };

  const rows: { label: string; cells: Cell[] }[] = [];
  const add = (label: string, make: (quote: Quote | undefined, i: number) => Cell) => {
    rows.push({ label, cells: lines.map((l, i) => make(quoteById.get(l.quoteId), i)) });
  };

  add('Status', (_q, i) => {
    const l = lines[i];
    if (l.quoteId === comparison.recommendedQuoteId) return { text: 'Recommended', tone: 'good' };
    if (!l.comparable) return { text: 'Not comparable', tone: 'bad' };
    if (l.quoteId === comparison.cheapestQuoteId) return { text: 'Cheapest comparable', tone: 'warn' };
    return { text: 'Comparable' };
  });
  add('Rank', (_q, i) => ({ text: lines[i].rank ? `${lines[i].rank} of ${lines.filter((x) => x.rank).length}` : 'not ranked' }));
  add('Shipping line', (q) => textCell(q?.shippingLine.value));
  add('Rate basis', (q) => textCell(q?.containerBasis.value));
  add('Base freight, per container', (q) =>
    q?.baseFreight.value == null ? { text: 'not stated', missing: true, tone: 'bad' } : money(q.baseFreight.value, q.currency.value),
  );

  // One row per surcharge any provider mentioned, so a gap is visible.
  const codes = [...new Set(lines.flatMap((l) => quoteById.get(l.quoteId)?.surcharges.map((s) => s.code) ?? []))];
  for (const code of codes) {
    const label =
      lines.map((l) => quoteById.get(l.quoteId)?.surcharges.find((s) => s.code === code)?.label).find(Boolean) ?? code;
    add(label, (q) => {
      const s = q?.surcharges.find((x) => x.code === code);
      if (!s) return { text: 'not mentioned', missing: true };
      if (s.amount === null) return { text: 'listed, no amount given', tone: 'bad', missing: true };
      return {
        text: `${s.currency ?? ''} ${s.amount.toLocaleString('en-US')} ${CHARGE_BASIS_LABEL[s.basis]}`.trim(),
      };
    });
  }

  add('Total for this shipment', (_q, i) => {
    const l = lines[i];
    return l.totalInQuoteCurrency === null
      ? { text: 'cannot be totalled', tone: 'bad', missing: true }
      : money(l.totalInQuoteCurrency, l.quoteCurrency);
  });
  add(`Total in ${cur}`, (_q, i) => {
    const l = lines[i];
    if (l.totalInBaseCurrency === null) return { text: 'not comparable', tone: 'bad', missing: true };
    return {
      ...money(l.totalInBaseCurrency, cur),
      tone: l.quoteId === comparison.recommendedQuoteId ? 'good' : l.quoteId === comparison.cheapestQuoteId ? 'warn' : undefined,
    };
  });
  if (lines.some((l) => l.fxApplied)) {
    add('Exchange rate applied', (_q, i) => {
      const fx = lines[i].fxApplied;
      return fx
        ? { text: `${fx.rate} ${fx.to}/${fx.from} — ${fx.source}, ${fx.asOf}`, tone: 'warn' }
        : { text: 'none needed' };
    });
  }
  add('Provider stated total', (q, i) => {
    const l = lines[i];
    if (!q || q.totalQuoted.value === null) return { text: 'not stated', missing: true };
    if (l.totalDiscrepancy) {
      return {
        text: `${l.quoteCurrency ?? cur} ${q.totalQuoted.value.toLocaleString('en-US')} — does not match the charges listed`,
        tone: 'warn',
      };
    }
    return money(q.totalQuoted.value, l.quoteCurrency);
  });
  add('Transit time', (_q, i) =>
    lines[i].transitDays === null
      ? { text: 'not stated', missing: true, tone: 'bad' }
      : { text: `${lines[i].transitDays} days` },
  );
  add('Free days at destination', (_q, i) =>
    lines[i].freeDays === null ? { text: 'not stated', missing: true } : { text: `${lines[i].freeDays} days` },
  );
  add('Valid until', (_q, i) => (lines[i].validUntil ? { text: formatDay(lines[i].validUntil) } : { text: 'not stated', missing: true }));
  add('Sailing date', (q) => (q?.sailingDate.value ? { text: formatDay(q.sailingDate.value) } : { text: 'not stated', missing: true }));
  add('Payment terms', (q) => textCell(q?.paymentTerms.value));
  add('Included', (q) => listCell(q?.inclusions.value));
  add('Excluded', (q) => listCell(q?.exclusions.value));
  add('Conditions', (q) => listCell(q?.conditions.value));
  add('Weighted score', (_q, i) =>
    lines[i].scoreTotal === null ? { text: 'not scored' } : { text: (lines[i].scoreTotal as number).toFixed(3) },
  );
  add('What is needed to compare it', (_q, i) => {
    const l = lines[i];
    if (l.comparable) return { text: '—' };
    return { text: l.issues.map((x) => describeIssue(x)).join(' '), tone: 'bad' };
  });

  return (
    <div className="cmp-wrap">
      <table className="cmp">
        <caption className="sr-only">
          Side-by-side comparison of {lines.length} freight offers, with the recommended offer marked.
        </caption>
        <thead>
          <tr>
            <th className="rowhead" scope="col">
              Offer
            </th>
            {lines.map((l) => (
              <th
                key={l.quoteId}
                scope="col"
                data-recommended={l.quoteId === comparison.recommendedQuoteId}
                data-comparable={l.comparable}
              >
                <span className="head-provider">{l.providerName}</span>
                <span className="head-meta">
                  Version {l.version}
                  {l.quoteId === comparison.recommendedQuoteId ? ' · recommended' : ''}
                  {l.quoteId === comparison.cheapestQuoteId && l.quoteId !== comparison.recommendedQuoteId
                    ? ' · cheapest'
                    : ''}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const texts = row.cells.map((c) => c.text);
            const differs = new Set(texts).size > 1 && texts.length > 1;
            return (
              <tr key={row.label} data-differs={differs}>
                <th className="rowhead" scope="row">
                  {row.label}
                </th>
                {row.cells.map((c, i) => (
                  <td key={i} data-tone={c.tone} className={c.text.length > 40 ? undefined : 'num'}>
                    <span className={c.missing ? 'missing' : undefined}>{c.text}</span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function textCell(v: string | null | undefined): Cell {
  return v ? { text: v } : { text: 'not stated', missing: true };
}

function listCell(v: string[] | null | undefined): Cell {
  return v && v.length > 0 ? { text: v.join(', ') } : { text: 'not stated', missing: true };
}

/** The recommendation, its reasoning and what it costs. */
export function RecommendationCard({ comparison }: { comparison: Comparison }) {
  const recommended = comparison.lines.find((l) => l.quoteId === comparison.recommendedQuoteId) ?? null;
  const cheapest = comparison.lines.find((l) => l.quoteId === comparison.cheapestQuoteId) ?? null;
  const cur = comparison.criteria.baseCurrency;

  if (!recommended) {
    return (
      <Card>
        <CardHead title="No offer can be recommended yet" />
        <div className="card-body stack">
          <Notice tone="warn" title="Nothing is comparable on a like-for-like basis. ">
            Every offer received is missing something needed to rank it fairly. What is needed is listed
            below.
          </Notice>
          <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.65 }}>
            {comparison.blockedNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      </Card>
    );
  }

  const differs = cheapest !== null && cheapest.quoteId !== recommended.quoteId;

  return (
    <Card>
      <CardHead
        title="Recommendation"
        hint="This supports your decision. No provider has been selected, nothing negotiated and nothing booked."
      />
      <div className="card-body stack">
        <div className="kv-grid">
          <div>
            <div className="k">Recommended</div>
            <div className="v" style={{ fontSize: 16, fontWeight: 600 }}>
              {recommended.providerName}
            </div>
            <div className="small muted">
              {cur} {(recommended.totalInBaseCurrency as number).toLocaleString('en-US')} ·{' '}
              {recommended.transitDays} days · {recommended.freeDays ?? 0} free days
            </div>
          </div>
          {cheapest ? (
            <div>
              <div className="k">Cheapest comparable</div>
              <div className="v" style={{ fontSize: 16, fontWeight: 600 }}>
                {cheapest.providerName}
              </div>
              <div className="small muted">
                {cur} {(cheapest.totalInBaseCurrency as number).toLocaleString('en-US')}
                {differs ? ' · not recommended' : ' · also the recommendation'}
              </div>
            </div>
          ) : null}
        </div>

        {differs ? (
          <Notice tone="info" title="The cheapest offer is not the recommended one. ">
            That is deliberate: the criteria weigh transit time and free days as well as cost. The
            reasoning is below, and you can change the weights and rebuild.
          </Notice>
        ) : null}

        <div>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>Why</h3>
          <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
            {comparison.recommendationReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>

        {comparison.recommendationTradeoffs.length > 0 ? (
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>Tradeoffs</h3>
            <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              {comparison.recommendationTradeoffs.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {comparison.blockedNotes.length > 0 ? (
          <div>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>Offers left out of the ranking</h3>
            <ul className="small" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
              {comparison.blockedNotes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
