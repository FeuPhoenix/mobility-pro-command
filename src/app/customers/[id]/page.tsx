'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, Empty, MeasureRow, PageLoading, Pill, RefChip } from '@/components/ui';
import { byId, creditExposure, orderValue, receivables, skuLongLabel } from '@/domain/selectors';
import { daysBetween, formatDate, formatDateTime, formatEGP, formatQty } from '@/domain/money';

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const { state } = useDemo();
  const customer = state ? byId(state.customers, decodeURIComponent(params.id)) : undefined;

  const skuHistory = useMemo(() => {
    if (!state || !customer) return [];
    const map = new Map<string, { qty: number; revenue: number; last: string; count: number }>();
    for (const h of state.historicalSales.filter((x) => x.customerId === customer.id)) {
      const e = map.get(h.skuId) ?? { qty: 0, revenue: 0, last: h.soldOn, count: 0 };
      e.qty += h.qty;
      e.revenue += h.qty * h.unitPrice;
      e.count += 1;
      if (h.soldOn > e.last) e.last = h.soldOn;
      map.set(h.skuId, e);
    }
    return [...map.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  }, [state, customer]);

  if (!state) return <PageLoading />;
  if (!customer) {
    return (
      <div className="page">
        <Card>
          <Empty title="Customer not found">
            <Link href="/customers">Back to customers</Link>.
          </Empty>
        </Card>
      </div>
    );
  }

  const ar = receivables(state, customer.id);
  const exposure = creditExposure(state, customer.id);
  const orders = state.salesOrders.filter((o) => o.customerId === customer.id);
  const owner = byId(state.users, customer.owner);
  const lifetime = state.historicalSales
    .filter((h) => h.customerId === customer.id)
    .reduce((n, h) => n + h.qty * h.unitPrice, 0);
  const timeline = state.activity.filter(
    (a) => a.refs.some((r) => r.id === customer.id) || a.refs.some((r) => orders.some((o) => o.id === r.id)),
  );

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ gap: 9, marginBottom: 6 }}>
          <Link className="btn ghost sm" href="/customers">
            ← Customers
          </Link>
          <Pill tone="neutral">{customer.segment}</Pill>
          {customer.onHold ? <Pill tone="bad">On hold</Pill> : null}
          {ar.overdue > 0 ? <Pill tone="bad">{formatEGP(ar.overdue)} overdue</Pill> : <Pill tone="good">No overdue</Pill>}
        </div>
        <h1>{customer.name}</h1>
        <p className="sub">
          {customer.governorate} · {customer.paymentTermsDays}-day terms · customer since{' '}
          {formatDate(customer.since)} · account owner {owner?.name}. Contact {customer.contactName},{' '}
          {customer.contactEmail}.
        </p>
      </div>

      <div className="grid g-detail">
        <div className="stack">
          <Card className="flush">
            <CardHead title="Receivables" hint="Invoiced and unpaid. Not revenue for the period, and not cash." />
            {ar.overdueInvoices.length + ar.currentInvoices.length === 0 ? (
              <Empty title="Nothing outstanding" />
            ) : (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Issued</th>
                      <th>Due</th>
                      <th className="r">Total</th>
                      <th className="r">Outstanding</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.invoices
                      .filter((i) => i.customerId === customer.id)
                      .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
                      .map((i) => {
                        const overdueDays = daysBetween(i.dueOn, state.meta.today);
                        const isOverdue = i.outstanding > 0 && overdueDays > 0;
                        return (
                          <tr key={i.id}>
                            <td className="mono primary-cell">{i.id}</td>
                            <td className="tiny">{formatDate(i.issuedOn)}</td>
                            <td className="tiny">{formatDate(i.dueOn)}</td>
                            <td className="r">{formatEGP(i.total)}</td>
                            <td className="r">
                              <span className={isOverdue ? 'cmp-val bad' : undefined}>
                                {formatEGP(i.outstanding)}
                              </span>
                            </td>
                            <td>
                              {i.outstanding === 0 ? (
                                <Pill tone="good">Settled</Pill>
                              ) : isOverdue ? (
                                <Pill tone="bad">{overdueDays} days past due</Pill>
                              ) : (
                                <Pill tone="neutral">Due in {Math.abs(overdueDays)} days</Pill>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="flush">
            <CardHead title="Purchasing history" hint="What this account actually buys, by revenue." />
            {skuHistory.length === 0 ? (
              <Empty title="No purchase history in the demo dataset" />
            ) : (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="r">Pieces</th>
                      <th className="r">Revenue</th>
                      <th className="r">Orders</th>
                      <th className="r">Last purchase</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skuHistory.map(([skuId, e]) => (
                      <tr key={skuId}>
                        <td className="primary-cell">{skuLongLabel(state, skuId)}</td>
                        <td className="r">{e.qty.toLocaleString('en-EG')}</td>
                        <td className="r">{formatEGP(e.revenue)}</td>
                        <td className="r">{e.count}</td>
                        <td className="r tiny">
                          {formatDate(e.last)}
                          <div className="muted">{daysBetween(e.last, state.meta.today)} d ago</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="flush">
            <CardHead title="Orders in flight" />
            {orders.length === 0 ? (
              <Empty title="No open orders">
                Nothing is currently proposed, blocked or reserved for this account.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Created</th>
                      <th>Lines</th>
                      <th className="r">Value</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link href={`/operations/orders/${o.id}`} className="mono primary-cell">
                            {o.id}
                          </Link>
                        </td>
                        <td className="tiny">{formatDate(o.createdOn)}</td>
                        <td className="tiny">
                          {o.lines.map((l, i) => (
                            <div key={i}>
                              {formatQty(l.qty)} × {skuLongLabel(state, l.skuId)}
                            </div>
                          ))}
                        </td>
                        <td className="r">{formatEGP(orderValue(o))}</td>
                        <td>
                          <Pill
                            tone={
                              o.status === 'Approved - reserved'
                                ? 'good'
                                : o.status === 'Pending approval'
                                  ? 'warn'
                                  : o.status === 'Blocked - credit' || o.status === 'Rejected'
                                    ? 'bad'
                                    : 'neutral'
                            }
                          >
                            {o.status}
                          </Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card className="flush">
            <CardHead title="Commercial position" hint="Four separate measures." />
            <div className="measures">
              <MeasureRow
                label="Credit limit"
                amount={customer.creditLimit}
                note="The approved ceiling on total exposure for this account."
              />
              <MeasureRow
                label="Open receivables"
                amount={ar.outstanding}
                note={`Invoiced and unpaid, of which ${formatEGP(ar.overdue)} is past due.`}
              />
              <MeasureRow
                label="Credit exposure"
                amount={exposure}
                note="Open receivables plus approved undelivered orders (CR-2.1). Draft orders excluded."
              />
              <MeasureRow
                label="Lifetime purchases"
                amount={lifetime}
                note="Historical shipped sales value in the demo dataset. Not an amount owed."
              />
            </div>
            <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="tiny muted">Headroom before new orders</span>
                <b className={customer.creditLimit - exposure < 0 ? 'cmp-val bad num' : 'num'}>
                  {formatEGP(customer.creditLimit - exposure)}
                </b>
              </div>
            </div>
          </Card>

          <Card className="flush">
            <CardHead title="Payments received" />
            {state.payments.filter((p) => p.customerId === customer.id).length === 0 ? (
              <Empty title="No payments recorded" />
            ) : (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Payment</th>
                      <th>Received</th>
                      <th className="r">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.payments
                      .filter((p) => p.customerId === customer.id)
                      .map((p) => (
                        <tr key={p.id}>
                          <td>
                            <div className="mono tiny">{p.id}</div>
                            <div className="tiny muted">against {p.invoiceId}</div>
                          </td>
                          <td className="tiny">{formatDate(p.receivedOn)}</td>
                          <td className="r">{formatEGP(p.amount)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="flush">
            <CardHead title="Activity" hint="Shared trail across this account's records." />
            {timeline.length === 0 ? (
              <Empty title="Nothing recorded yet" />
            ) : (
              <div className="timeline">
                {timeline.slice(0, 10).map((a) => (
                  <div className="tl" data-kind={a.kind} key={a.id}>
                    <div className="tl-node">
                      <i />
                    </div>
                    <div className="tl-main">
                      <b>{a.summary}</b>
                      <div className="tl-meta">
                        {a.actor} · {formatDateTime(a.at)}
                      </div>
                      {a.detail ? <div className="tl-detail">{a.detail}</div> : null}
                      <div className="tl-refs">
                        {a.refs.map((r, i) => (
                          <RefChip key={i} refItem={r} />
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
