'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, Empty, Field, Icon, Notice, PageLoading, Pill, RefChip } from '@/components/ui';
import { checkCredit, checkStock, discountAuthority } from '@/domain/credit';
import { activePriceList, byId, orderCost, orderValue, receivables, skuLongLabel } from '@/domain/selectors';
import { formatDate, formatDateTime, formatEGP, formatQty } from '@/domain/money';

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { state, dispatch, busy } = useDemo();
  const orderId = decodeURIComponent(params.id);

  const order = state ? byId(state.salesOrders, orderId) : undefined;
  const [qty, setQty] = useState<number>(order?.lines[0]?.qty ?? 0);
  const [discount, setDiscount] = useState<number>(order?.lines[0]?.discountPct ?? 0);
  const [note, setNote] = useState('');
  const [chosenOption, setChosenOption] = useState<string>('');

  useEffect(() => {
    if (order?.lines[0]) {
      setQty(order.lines[0].qty);
      setDiscount(order.lines[0].discountPct);
    }
  }, [order?.lines[0]?.qty, order?.lines[0]?.discountPct]);

  if (!state) return <PageLoading />;
  if (!order) {
    return (
      <div className="page">
        <Card>
          <Empty title="Order not found">
            <Link href="/operations/orders">Back to orders</Link>.
          </Empty>
        </Card>
      </div>
    );
  }

  const customer = byId(state.customers, order.customerId)!;
  const credit = checkCredit(state, order);
  const stock = checkStock(state, order);
  const ar = receivables(state, order.customerId);
  const active = activePriceList(state);
  const stalePrice = order.priceListId !== active.id;
  const value = orderValue(order);
  const gp = value - orderCost(order);
  const approval = order.approvalId ? byId(state.approvals, order.approvalId) : undefined;
  const reservations = state.reservations.filter((r) => !r.releasedAt && r.salesOrderId === order.id);
  const maxDiscount = Math.max(...order.lines.map((l) => l.discountPct));
  const auth = discountAuthority(maxDiscount);
  const editable = order.status !== 'Approved - reserved' && order.lines.length === 1;
  const timeline = state.activity.filter((a) => a.refs.some((r) => r.id === order.id));
  const selectedOption = chosenOption || credit.options.find((o) => !o.selfService)?.id || '';

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ gap: 9, marginBottom: 6 }}>
          <Link className="btn ghost sm" href="/operations/orders">
            ← Orders
          </Link>
          <Pill
            tone={
              order.status === 'Approved - reserved'
                ? 'good'
                : order.status === 'Pending approval'
                  ? 'warn'
                  : order.status === 'Rejected' || order.status === 'Blocked - credit'
                    ? 'bad'
                    : 'neutral'
            }
          >
            {order.status}
          </Pill>
          {order.sourceOpportunityId ? (
            <Link className="ref-chip" href={`/operations/inventory/${order.sourceOpportunityId}`}>
              from {order.sourceOpportunityId}
            </Link>
          ) : null}
        </div>
        <h1>
          {order.id} · {customer.name}
        </h1>
        <p className="sub">
          Created {formatDate(order.createdOn)} by {byId(state.users, order.createdBy)?.name}. Priced
          on {byId(state.priceLists, order.priceListId)?.name}.{' '}
          {order.notes ? order.notes : ''}
        </p>
      </div>

      {/* --------------------------- Headline state --------------------------- */}
      <div className="stack" style={{ marginBottom: 16 }}>
        <Notice
          tone={credit.released ? 'good' : 'bad'}
          title={
            credit.released
              ? 'Within credit policy'
              : credit.outcome === 'blocked_overdue'
                ? 'Held — an invoice is past due'
                : credit.outcome === 'blocked_limit'
                  ? 'Held — credit limit would be exceeded'
                  : 'Held — the account is on hold'
          }
        >
          {credit.headline}
        </Notice>
        {stalePrice ? (
          <Notice tone="warn" title="Priced on a superseded price list">
            This proposal uses {byId(state.priceLists, order.priceListId)?.name}. The active version
            is {active.name}, effective {formatDate(active.effectiveFrom)}. Pricing policy PP-1.1
            requires re-pricing before the order can be confirmed.
          </Notice>
        ) : null}
        {approval?.status === 'Stale - inputs changed' ? (
          <Notice tone="warn" title="The previous approval lapsed">
            A material input changed after approval {approval.id} was requested, so it no longer
            applies (CR-5.4). Resubmit the request with the current figures.
          </Notice>
        ) : null}
      </div>

      <div className="grid g-detail">
        <div className="stack">
          {/* ------------------------------ Lines ----------------------------- */}
          <Card className="flush">
            <CardHead title="Order lines" hint="Unit cost is the weighted landed cost of the stock at the picking location." />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Location</th>
                    <th className="r">Qty</th>
                    <th className="r">List</th>
                    <th className="r">Disc.</th>
                    <th className="r">Unit price</th>
                    <th className="r">Unit cost</th>
                    <th className="r">Line value</th>
                    <th className="r">Line GP</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="primary-cell">{skuLongLabel(state, l.skuId)}</td>
                      <td className="tiny">{byId(state.warehouses, l.warehouseId)?.name}</td>
                      <td className="r">{l.qty.toLocaleString('en-EG')}</td>
                      <td className="r">{formatEGP(l.listPrice)}</td>
                      <td className="r">{l.discountPct}%</td>
                      <td className="r">{formatEGP(l.unitPrice, { cents: true })}</td>
                      <td className="r">{formatEGP(l.unitCost)}</td>
                      <td className="r">{formatEGP(l.qty * l.unitPrice)}</td>
                      <td className="r">{formatEGP(l.qty * (l.unitPrice - l.unitCost))}</td>
                    </tr>
                  ))}
                </tbody>
                <tbody style={{ borderTop: '2px solid var(--line-2)' }}>
                  <tr>
                    <td colSpan={7} className="primary-cell">
                      Order total
                    </td>
                    <td className="r primary-cell">{formatEGP(value)}</td>
                    <td className="r primary-cell">
                      {formatEGP(gp)}
                      <div className="tiny muted">{value > 0 ? ((gp / value) * 100).toFixed(1) : '0.0'}% margin</div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="tiny muted">
                Gross profit is what this order would earn if it is delivered and collected in full.
                No revenue has been recognised and no cash has been received.
              </div>
            </div>
          </Card>

          {/* ---------------------------- Revise ------------------------------ */}
          {editable ? (
            <Card>
              <CardHead
                title="Revise the proposal"
                hint="Changing a material input invalidates any pending approval (CR-5.4)."
              />
              <div className="card-body stack">
                <div className="grid g2">
                  <Field label="Quantity" help={`${stock[0]?.available.toLocaleString('en-EG')} available at this location.`}>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={qty}
                      onChange={(e) => setQty(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Discount %" help={`Authority: ${discountAuthority(discount).role} (${discountAuthority(discount).clause}).`}>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={40}
                      value={discount}
                      onChange={(e) => setDiscount(Number(e.target.value))}
                    />
                  </Field>
                </div>
                <div className="row">
                  <button
                    className="btn"
                    disabled={busy || (qty === order.lines[0].qty && discount === order.lines[0].discountPct)}
                    onClick={() => void dispatch({ type: 'order.updateLine', orderId: order.id, qty, discountPct: discount })}
                  >
                    Apply revision
                  </button>
                  {stalePrice ? (
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void dispatch({ type: 'order.repriceToActive', orderId: order.id })}
                    >
                      Re-price onto {active.name}
                    </button>
                  ) : null}
                </div>
              </div>
            </Card>
          ) : stalePrice ? (
            <Card>
              <div className="card-body">
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void dispatch({ type: 'order.repriceToActive', orderId: order.id })}
                >
                  Re-price onto {active.name}
                </button>
              </div>
            </Card>
          ) : null}

          {/* -------------------------- Credit check -------------------------- */}
          <Card className="flush">
            <CardHead
              title="Credit and fulfilment check"
              hint="Explainable rules from the credit policy. There is no credit score in this product."
            />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Clause</th>
                    <th>Check</th>
                    <th>Result</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {credit.checks.map((c, i) => (
                    <tr key={i}>
                      <td className="mono">{c.clause}</td>
                      <td className="primary-cell">{c.description}</td>
                      <td>
                        <Pill tone={c.passed ? 'good' : 'bad'}>{c.passed ? 'Pass' : 'Fail'}</Pill>
                      </td>
                      <td className="tiny muted">{c.detail}</td>
                    </tr>
                  ))}
                  {stock.map((s, i) => (
                    <tr key={`stock-${i}`}>
                      <td className="mono">Stock</td>
                      <td className="primary-cell">Sufficient available quantity at the picking location</td>
                      <td>
                        <Pill tone={s.ok ? 'good' : 'bad'}>{s.ok ? 'Pass' : 'Fail'}</Pill>
                      </td>
                      <td className="tiny muted">
                        {byId(state.warehouses, s.warehouseId)?.name}: {s.onHand} on hand, {s.reserved}{' '}
                        reserved, {s.available} available against {s.requested} requested.
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card-body" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="grid g2">
                <div>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>How exposure is built</div>
                  <dl className="kv">
                    <dt>Open receivables</dt>
                    <dd>{formatEGP(credit.openReceivables)}</dd>
                    <dt>+ Approved undelivered orders</dt>
                    <dd>{formatEGP(credit.committedOrders)}</dd>
                    <dt>= Exposure before this order</dt>
                    <dd>
                      <b>{formatEGP(credit.exposureBefore)}</b>
                    </dd>
                    <dt>+ This order</dt>
                    <dd>{formatEGP(credit.orderValue)}</dd>
                    <dt>= Exposure after</dt>
                    <dd>
                      <b>{formatEGP(credit.exposureAfter)}</b>
                    </dd>
                    <dt>Credit limit</dt>
                    <dd>{formatEGP(credit.creditLimit)}</dd>
                    <dt>Headroom after</dt>
                    <dd className={credit.availableCreditAfter < 0 ? 'cmp-val bad' : undefined}>
                      {formatEGP(credit.availableCreditAfter)}
                    </dd>
                  </dl>
                </div>
                <div>
                  <div className="eyebrow" style={{ marginBottom: 7 }}>Overdue invoices</div>
                  {ar.overdueInvoices.length === 0 ? (
                    <p className="small muted">Nothing is past due on this account.</p>
                  ) : (
                    <table className="t">
                      <tbody>
                        {ar.overdueInvoices.map((i) => (
                          <tr key={i.id}>
                            <td className="mono tiny">{i.id}</td>
                            <td className="tiny muted">due {formatDate(i.dueOn)}</td>
                            <td className="r">
                              {formatEGP(i.outstanding)}
                              <div className="tiny" style={{ color: 'var(--red)' }}>
                                {i.daysOverdue} days
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="tiny muted" style={{ marginTop: 8 }}>
                    Draft orders are not exposure (CR-2.1). Only approved, undelivered orders count.
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* -------------------------- Fulfilment plan ----------------------- */}
          <Card>
            <CardHead
              title="Fulfilment plan"
              hint={credit.released ? 'This order can be released without an approval request.' : 'Choose how to proceed within policy.'}
            />
            <div className="card-body stack">
              {order.status === 'Approved - reserved' ? (
                <Notice tone="good" title="Released and reserved">
                  {formatQty(reservations.reduce((n, r) => n + r.qty, 0))} held against this order.
                  Delivery, invoicing and collection are separate steps that this demo does not
                  perform.
                </Notice>
              ) : order.status === 'Rejected' ? (
                <Notice tone="bad" title="Rejected">
                  {approval?.decisionNote ?? 'The approval request was rejected. Nothing is reserved.'}
                </Notice>
              ) : approval?.status === 'Pending' ? (
                <Notice tone="warn" title={`Waiting on ${approval.approverRole === 'finance' ? 'the Finance Director' : 'the Commercial Director'}`}>
                  Approval {approval.id} was requested {formatDateTime(approval.requestedAt)}.{' '}
                  <Link href={`/approvals?focus=${approval.id}`}>Open the approval inbox</Link>.
                  Nothing is reserved until a decision is recorded.
                </Notice>
              ) : (
                <>
                  <div className="stack" style={{ gap: 10 }}>
                    {credit.options.map((o) => (
                      <label
                        key={o.id}
                        className="card"
                        style={{
                          padding: 13,
                          cursor: 'pointer',
                          borderColor: selectedOption === o.id ? 'var(--accent)' : undefined,
                          background: selectedOption === o.id ? 'var(--accent-soft)' : undefined,
                        }}
                      >
                        <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 10 }}>
                          <input
                            type="radio"
                            name="plan"
                            checked={selectedOption === o.id}
                            onChange={() => setChosenOption(o.id)}
                            style={{ marginTop: 3 }}
                          />
                          <div style={{ minWidth: 0 }}>
                            <div className="row" style={{ gap: 7 }}>
                              <b style={{ fontSize: 13 }}>{o.label}</b>
                              <span className="mono tiny muted">{o.clause}</span>
                              {o.requiresApprovalBy ? (
                                <Pill tone="warn">{o.requiresApprovalBy}</Pill>
                              ) : (
                                <Pill tone="good">No approval needed</Pill>
                              )}
                            </div>
                            <div className="small muted" style={{ marginTop: 3 }}>
                              {o.description}
                            </div>
                            {o.computed?.length ? (
                              <div className="row" style={{ gap: 18, marginTop: 8 }}>
                                {o.computed.map((c, i) => (
                                  <div key={i}>
                                    <div className="tiny muted">{c.label}</div>
                                    <div className="num" style={{ fontWeight: 600 }}>
                                      {c.value}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {o.assumptions?.length ? (
                              <div className="band assumption" style={{ marginTop: 9 }}>
                                <b>Demo policy assumption</b>
                                {o.assumptions.join(' ')}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>

                  <Field label="Note for the approver (optional)">
                    <textarea
                      className="input"
                      rows={3}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Customer has committed to settle INV-2026-0412 by 30 Sep."
                    />
                  </Field>

                  <div className="row">
                    {credit.released && !auth.needsApproval ? (
                      <button
                        className="btn primary"
                        disabled={busy || stalePrice}
                        onClick={() => void dispatch({ type: 'order.releaseFull', orderId: order.id })}
                      >
                        Release in full and reserve stock
                      </button>
                    ) : (
                      <button
                        className="btn primary"
                        disabled={busy || !selectedOption}
                        onClick={async () => {
                          const r = await dispatch({
                            type: 'order.requestApproval',
                            orderId: order.id,
                            optionId: selectedOption,
                            note,
                          });
                          if (r.ok && r.navigateTo) router.push(r.navigateTo);
                        }}
                      >
                        Request approval <Icon name="arrow" size={14} />
                      </button>
                    )}
                    {stalePrice ? (
                      <span className="tiny" style={{ color: 'var(--amber)' }}>
                        Re-price onto the active list first.
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>

        {/* ----------------------------- Side rail --------------------------- */}
        <div className="stack">
          <Card>
            <CardHead title="Customer" hint={`${customer.segment} · ${customer.governorate}`} />
            <div className="card-body">
              <dl className="kv">
                <dt>Account</dt>
                <dd>
                  <Link href={`/customers/${customer.id}`}>{customer.name}</Link>
                </dd>
                <dt>Contact</dt>
                <dd>{customer.contactName}</dd>
                <dt>Terms</dt>
                <dd>{customer.paymentTermsDays} days</dd>
                <dt>Credit limit</dt>
                <dd>{formatEGP(customer.creditLimit)}</dd>
                <dt>Open receivables</dt>
                <dd>{formatEGP(ar.outstanding)}</dd>
                <dt>Overdue</dt>
                <dd className={ar.overdue > 0 ? 'cmp-val bad' : undefined}>{formatEGP(ar.overdue)}</dd>
                <dt>Customer since</dt>
                <dd>{formatDate(customer.since)}</dd>
              </dl>
            </div>
          </Card>

          {reservations.length ? (
            <Card className="flush">
              <CardHead title="Reservations" hint="Created only on release or approval." />
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Reservation</th>
                      <th>Location</th>
                      <th className="r">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reservations.map((r) => (
                      <tr key={r.id}>
                        <td className="mono tiny">{r.id}</td>
                        <td className="tiny">{byId(state.warehouses, r.warehouseId)?.code}</td>
                        <td className="r">{r.qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          <Card className="flush">
            <CardHead title="Activity on this order" />
            {timeline.length === 0 ? (
              <Empty title="Nothing recorded yet" />
            ) : (
              <div className="timeline">
                {timeline.map((a) => (
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
