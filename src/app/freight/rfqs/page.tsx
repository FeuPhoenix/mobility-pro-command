'use client';

import React from 'react';
import Link from 'next/link';
import { Card, Empty } from '@/components/ui';
import { useFreight } from '@/freight/ui/FreightProvider';
import { RfqStatusPill, relativeHours } from '@/freight/ui/bits';
import type { RfqStatus } from '@/freight/types';

const FILTERS: { key: string; label: string; match: (s: RfqStatus) => boolean }[] = [
  { key: 'open', label: 'Open', match: (s) => s !== 'completed' && s !== 'cancelled' },
  { key: 'awaiting', label: 'Awaiting approval', match: (s) => s === 'awaiting_approval' },
  { key: 'collecting', label: 'Collecting', match: (s) => s === 'collecting' || s === 'sent' },
  { key: 'ready', label: 'Comparison ready', match: (s) => s === 'comparison_ready' || s === 'closed' },
  { key: 'completed', label: 'Completed', match: (s) => s === 'completed' },
  { key: 'all', label: 'All', match: () => true },
];

export default function RfqListPage() {
  const { state } = useFreight();
  const [filter, setFilter] = React.useState('open');
  const [query, setQuery] = React.useState('');

  const all = state?.overview?.rfqs ?? [];
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const needle = query.trim().toLowerCase();

  const rows = all
    .filter((r) => active.match(r.status))
    .filter((r) =>
      needle.length === 0
        ? true
        : [r.reference, r.title, r.route, r.companyName].some((v) => v.toLowerCase().includes(needle)),
    );

  return (
    <div className="page">
      <div className="fr-head">
        <div>
          <h1>Shipping requirements</h1>
          <div className="sub">
            Every request keeps its reference from the first email through to the recorded outcome.
          </div>
        </div>
        <div className="fr-head-actions">
          <a className="btn" href="/api/freight/template/rfq">
            Download Excel template
          </a>
          <Link className="btn primary" href="/freight/rfqs/new">
            New shipping requirement
          </Link>
        </div>
      </div>

      <div className="fr-bar">
        <div className="seg" role="radiogroup" aria-label="Filter requests by status">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="radio"
              aria-checked={filter === f.key}
              data-on={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="search"
          placeholder="Search reference, route or title"
          aria-label="Search requests"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <Card className="flush">
        {rows.length === 0 ? (
          <div className="card-body">
            <Empty title="Nothing here">
              {all.length === 0
                ? 'No shipping requirements have been created yet.'
                : 'No request matches this filter. Try "All".'}
            </Empty>
          </div>
        ) : (
          <div>
            {rows.map((r) => (
              <Link key={r.id} className="fr-row" href={`/freight/rfqs/${r.id}`}>
                <div className="main">
                  <div className="t">{r.title}</div>
                  <div className="m">
                    <span className="fr-ref">{r.reference}</span> · {r.route} · {r.companyName}
                  </div>
                  <div className="m">
                    {r.recipients > 0
                      ? `${r.responded} of ${r.recipients} providers replied`
                      : 'No providers selected yet'}
                    {r.quotesToCheck > 0 ? ` · ${r.quotesToCheck} to check` : ''}
                    {r.status === 'collecting' || r.status === 'sent'
                      ? ` · deadline ${relativeHours(r.hoursToDeadline)}`
                      : ''}
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
    </div>
  );
}
