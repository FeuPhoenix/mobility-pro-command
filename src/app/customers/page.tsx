'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, PageLoading, Pill } from '@/components/ui';
import { creditExposure, orderValue, receivables } from '@/domain/selectors';
import { formatEGP } from '@/domain/money';

export default function CustomersPage() {
  const { state } = useDemo();
  const router = useRouter();
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    if (!state) return [];
    return state.customers
      .map((c) => {
        const ar = receivables(state, c.id);
        const exposure = creditExposure(state, c.id);
        const orders = state.salesOrders.filter((o) => o.customerId === c.id);
        const lifetime = state.historicalSales
          .filter((h) => h.customerId === c.id)
          .reduce((n, h) => n + h.qty * h.unitPrice, 0);
        return { c, ar, exposure, orders, lifetime, headroom: c.creditLimit - exposure };
      })
      .filter((r) =>
        q.trim()
          ? `${r.c.name} ${r.c.segment} ${r.c.governorate}`.toLowerCase().includes(q.trim().toLowerCase())
          : true,
      )
      .sort((a, b) => b.ar.overdue - a.ar.overdue || b.exposure - a.exposure);
  }, [state, q]);

  if (!state) return <PageLoading />;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Customers</h1>
        <p className="sub">
          The commercial relationship next to the operational reality: what they buy, what they owe,
          how much room is left on their limit, and what is currently in flight.
        </p>
      </div>

      <Card className="flush">
        <CardHead
          title={`${rows.length} accounts`}
          hint="Sorted by overdue balance, then by total credit exposure."
          right={
            <input
              className="input"
              style={{ width: 230 }}
              placeholder="Filter by name, segment, governorate"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Filter customers"
            />
          }
        />
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Segment</th>
                <th className="r">Credit limit</th>
                <th className="r">Open receivables</th>
                <th className="r">Overdue</th>
                <th className="r">Exposure</th>
                <th className="r">Headroom</th>
                <th>In flight</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.c.id} className="clickable" onClick={() => router.push(`/customers/${r.c.id}`)}>
                  <td>
                    <div className="primary-cell">{r.c.name}</div>
                    <div className="tiny muted">
                      {r.c.governorate} · {r.c.paymentTermsDays}-day terms
                    </div>
                    {r.c.onHold ? (
                      <div style={{ marginTop: 4 }}>
                        <Pill tone="bad">On hold</Pill>
                      </div>
                    ) : null}
                  </td>
                  <td className="tiny">{r.c.segment}</td>
                  <td className="r">{formatEGP(r.c.creditLimit)}</td>
                  <td className="r">{formatEGP(r.ar.outstanding)}</td>
                  <td className="r">
                    {r.ar.overdue > 0 ? (
                      <>
                        <span className="cmp-val bad">{formatEGP(r.ar.overdue)}</span>
                        <div className="tiny muted">oldest {r.ar.worstOverdueDays} d</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="r">{formatEGP(r.exposure)}</td>
                  <td className="r">
                    <span className={r.headroom < 0 ? 'cmp-val bad' : undefined}>{formatEGP(r.headroom)}</span>
                  </td>
                  <td className="tiny">
                    {r.orders.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      r.orders.map((o) => (
                        <div key={o.id}>
                          <Link href={`/operations/orders/${o.id}`} className="mono">
                            {o.id}
                          </Link>{' '}
                          <span className="muted">
                            {o.status} · {formatEGP(orderValue(o))}
                          </span>
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="tiny muted">
            Exposure = open receivables + approved undelivered orders (CR-2.1). Draft orders are
            excluded. Receivables are amounts invoiced and unpaid — not revenue for the period.
          </div>
        </div>
      </Card>
    </div>
  );
}
