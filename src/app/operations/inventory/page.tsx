'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useDemo } from '@/components/DemoProvider';
import { OpsNav } from '@/components/OpsNav';
import { Card, CardHead, Icon, PageLoading, Pill, Segmented } from '@/components/ui';
import {
  agingProfile,
  byId,
  inventoryCarryingValue,
  observedUnitsPerMonth,
  skuLabel,
  stockBySku,
} from '@/domain/selectors';
import { daysBetween, formatEGP, formatQty } from '@/domain/money';

type SortKey = 'age' | 'value' | 'cover';

export default function InventoryPage() {
  const { state } = useDemo();
  const [sort, setSort] = useState<SortKey>('age');
  const [warehouse, setWarehouse] = useState<string>('all');

  const rows = useMemo(() => {
    if (!state) return [];
    return state.skus
      .map((s) => {
        const positions = stockBySku(state, s.id).filter(
          (p) => warehouse === 'all' || p.warehouseId === warehouse,
        );
        const onHand = positions.reduce((n, p) => n + p.onHand, 0);
        const available = positions.reduce((n, p) => n + p.available, 0);
        const value = positions.reduce((n, p) => n + p.onHand * p.weightedCost, 0);
        const oldest = positions.map((p) => p.oldestReceivedOn).sort()[0];
        const age = oldest ? daysBetween(oldest, state.meta.today) : 0;
        const rate = observedUnitsPerMonth(state, s.id, 3);
        const cover = rate > 0 ? available / rate : Infinity;
        const opp = state.opportunities.find((o) => o.skuId === s.id);
        return { s, positions, onHand, available, value, age, rate, cover, opp };
      })
      .filter((r) => r.onHand > 0)
      .sort((a, b) =>
        sort === 'age' ? b.age - a.age : sort === 'value' ? b.value - a.value : b.cover - a.cover,
      );
  }, [state, sort, warehouse]);

  if (!state) return <PageLoading />;

  const buckets = agingProfile(state);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Inventory opportunities</h1>
        <p className="sub">
          Stock positions across three distribution centres, ranked so the slow and the stranded rise
          to the top. Cover is calculated from actual shipped volume over the last three months, not
          from a forecast.
        </p>
      </div>
      <OpsNav />

      <div className="grid g-main">
        <div className="stack">
          <Card className="flush">
            <CardHead
              title="Stock by SKU"
              right={
                <div className="row" style={{ gap: 8 }}>
                  <select
                    className="input"
                    style={{ width: 'auto', fontSize: 12.5, padding: '5px 8px' }}
                    value={warehouse}
                    onChange={(e) => setWarehouse(e.target.value)}
                    aria-label="Filter by warehouse"
                  >
                    <option value="all">All warehouses</option>
                    {state.warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                  <Segmented
                    ariaLabel="Sort stock"
                    value={sort}
                    onChange={setSort}
                    options={[
                      { value: 'age', label: 'Oldest' },
                      { value: 'value', label: 'Value' },
                      { value: 'cover', label: 'Cover' },
                    ]}
                  />
                </div>
              }
            />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Locations</th>
                    <th className="r">On hand</th>
                    <th className="r">Available</th>
                    <th className="r">Carrying value</th>
                    <th className="r">Oldest lot</th>
                    <th className="r">Cover</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.s.id}>
                      <td>
                        <div className="primary-cell">
                          {r.s.size} {r.s.ply}
                        </div>
                        <div className="tiny muted">
                          {r.s.brand} {r.s.pattern} · {r.s.segment}
                        </div>
                      </td>
                      <td className="tiny">
                        {r.positions.map((p) => (
                          <div key={p.warehouseId}>
                            {byId(state.warehouses, p.warehouseId)?.code}{' '}
                            <span className="muted num">
                              {p.available}/{p.onHand}
                            </span>
                          </div>
                        ))}
                      </td>
                      <td className="r">{r.onHand.toLocaleString('en-EG')}</td>
                      <td className="r">{r.available.toLocaleString('en-EG')}</td>
                      <td className="r">{formatEGP(r.value)}</td>
                      <td className="r">
                        <span className={r.age > 180 ? 'cmp-val bad' : undefined}>{r.age} d</span>
                      </td>
                      <td className="r">
                        {Number.isFinite(r.cover) ? (
                          <span className={r.cover > 12 ? 'cmp-val bad' : undefined}>
                            {r.cover.toFixed(1)} mo
                          </span>
                        ) : (
                          <span className="muted">no sales</span>
                        )}
                        <div className="tiny muted">{r.rate}/mo</div>
                      </td>
                      <td className="r">
                        {r.opp ? (
                          <Link className="btn sm primary" href={`/operations/inventory/${r.opp.id}`}>
                            Review <Icon name="arrow" size={13} />
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card className="flush">
            <CardHead title="Open opportunities" hint="Raised by inventory rules, each with an owner." />
            {state.opportunities.map((o) => {
              const positions = stockBySku(state, o.skuId).filter((p) => p.warehouseId === o.warehouseId);
              const value = positions.reduce((n, p) => n + p.onHand * p.weightedCost, 0);
              return (
                <div key={o.id} className="card-body" style={{ borderBottom: '1px solid var(--line)' }}>
                  <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                    <Pill tone={o.status === 'Actioned' ? 'good' : o.status === 'In progress' ? 'info' : 'warn'}>
                      {o.status}
                    </Pill>
                    <span className="mono tiny muted">{o.ruleId}</span>
                  </div>
                  <div className="primary-cell">{skuLabel(state, o.skuId)}</div>
                  <div className="tiny muted" style={{ marginTop: 3, lineHeight: 1.5 }}>
                    {o.reason}
                  </div>
                  <dl className="kv" style={{ marginTop: 10 }}>
                    <dt>Location</dt>
                    <dd>{byId(state.warehouses, o.warehouseId)?.name}</dd>
                    <dt>Carrying value</dt>
                    <dd>{formatEGP(value)}</dd>
                    <dt>Owner</dt>
                    <dd>{byId(state.users, o.ownerId)?.name}</dd>
                  </dl>
                  <Link className="btn primary sm" href={`/operations/inventory/${o.id}`} style={{ marginTop: 10 }}>
                    Compare scenarios
                  </Link>
                </div>
              );
            })}
          </Card>

          <Card className="flush">
            <CardHead title="Aging profile" hint="Landed cost of physical stock, by age band." />
            <div className="measures">
              {buckets.map((b) => (
                <div className="measure" key={b.label}>
                  <div className="m-label">{b.label}</div>
                  <div className="m-value">{formatEGP(b.value)}</div>
                  <div className="m-note">{formatQty(b.qty)} on hand in this band.</div>
                </div>
              ))}
            </div>
            <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="tiny muted">
                Total inventory carrying value {formatEGP(inventoryCarryingValue(state))}. This is
                cash tied up in stock — not sales value and not profit.
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
