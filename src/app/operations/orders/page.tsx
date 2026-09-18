'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { OpsNav } from '@/components/OpsNav';
import { Card, CardHead, Empty, Icon, PageLoading, Pill } from '@/components/ui';
import { activePriceList, byId, orderCost, orderValue, skuLabel } from '@/domain/selectors';
import { formatDate, formatEGP } from '@/domain/money';
import type { SalesOrderStatus } from '@/domain/types';

const TONE: Record<SalesOrderStatus, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  Draft: 'neutral',
  'Blocked - credit': 'bad',
  'Pending approval': 'warn',
  'Approved - reserved': 'good',
  Rejected: 'bad',
  Delivered: 'info',
  Invoiced: 'info',
};

export default function OrdersPage() {
  const { state } = useDemo();
  const router = useRouter();
  if (!state) return <PageLoading />;

  const active = activePriceList(state);
  const orders = [...state.salesOrders].sort((a, b) => b.createdOn.localeCompare(a.createdOn));

  return (
    <div className="page">
      <div className="page-head">
        <h1>Customer orders</h1>
        <p className="sub">
          Proposed and confirmed orders with their pricing basis, credit position and fulfilment
          state. An order only holds stock once it has been released or approved.
        </p>
      </div>
      <OpsNav />

      <Card className="flush">
        <CardHead
          title="Orders"
          hint="Gross profit shown is what the order would earn if delivered and collected. It is not revenue recognised."
        />
        {orders.length === 0 ? (
          <Empty title="No orders yet">
            Prepare one from an inventory opportunity to start the fulfilment journey.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Lines</th>
                  <th className="r">Value</th>
                  <th className="r">Gross profit</th>
                  <th>Price basis</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const cust = byId(state.customers, o.customerId);
                  const value = orderValue(o);
                  const gp = value - orderCost(o);
                  const stale = o.priceListId !== active.id;
                  const reserved = state.reservations.filter((r) => !r.releasedAt && r.salesOrderId === o.id);
                  return (
                    <tr key={o.id} className="clickable" onClick={() => router.push(`/operations/orders/${o.id}`)}>
                      <td>
                        <div className="primary-cell mono">{o.id}</div>
                        <div className="tiny muted">{formatDate(o.createdOn)}</div>
                      </td>
                      <td>
                        <div className="primary-cell">{cust?.name}</div>
                        <div className="tiny muted">
                          {cust?.segment} · {cust?.paymentTermsDays}-day terms
                        </div>
                      </td>
                      <td className="tiny">
                        {o.lines.map((l, i) => (
                          <div key={i}>
                            {l.qty.toLocaleString('en-EG')} × {skuLabel(state, l.skuId)}
                            {l.discountPct > 0 ? (
                              <span className="muted"> @ −{l.discountPct}%</span>
                            ) : null}
                            <div className="muted">{byId(state.warehouses, l.warehouseId)?.code}</div>
                          </div>
                        ))}
                      </td>
                      <td className="r">{formatEGP(value)}</td>
                      <td className="r">
                        {formatEGP(gp)}
                        <div className="tiny muted">{value > 0 ? ((gp / value) * 100).toFixed(1) : '0.0'}%</div>
                      </td>
                      <td>
                        {stale ? (
                          <Pill tone="warn">Superseded list</Pill>
                        ) : (
                          <Pill tone="neutral">Active list</Pill>
                        )}
                        <div className="tiny muted" style={{ marginTop: 3 }}>
                          {byId(state.priceLists, o.priceListId)?.name}
                        </div>
                      </td>
                      <td>
                        <Pill tone={TONE[o.status]}>{o.status}</Pill>
                        {reserved.length ? (
                          <div className="tiny muted" style={{ marginTop: 3 }}>
                            {reserved.reduce((n, r) => n + r.qty, 0)} pcs reserved
                          </div>
                        ) : null}
                      </td>
                      <td className="r">
                        <Link className="btn sm" href={`/operations/orders/${o.id}`}>
                          Open <Icon name="arrow" size={13} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
