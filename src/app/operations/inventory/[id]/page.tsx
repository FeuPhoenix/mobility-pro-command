'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, Empty, Field, Icon, Notice, PageLoading, Pill } from '@/components/ui';
import {
  activePriceList,
  byId,
  customersWhoBought,
  observedUnitsPerMonth,
  receivables,
  salesForSku,
  skuLongLabel,
  stockBySku,
} from '@/domain/selectors';
import { CARRYING_COST_ANNUAL_PCT, TRANSFER_COST_PER_UNIT, runScenario, type ScenarioId } from '@/domain/scenarios';
import { discountAuthority } from '@/domain/credit';
import { formatDate, formatEGP, formatNumber, formatQty } from '@/domain/money';

const DISCOUNTS = [5, 8, 10] as const;

export default function OpportunityPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { state, dispatch, busy } = useDemo();

  const opp = state ? byId(state.opportunities, decodeURIComponent(params.id)) : undefined;

  const [qty, setQty] = useState(420);
  const [discount, setDiscount] = useState(8);
  const [transferQty, setTransferQty] = useState(240);
  const [customerId, setCustomerId] = useState<string>('');
  const [uplift, setUplift] = useState<number | null>(null);
  const [horizon, setHorizon] = useState<number | null>(null);
  const [delay, setDelay] = useState<number | null>(null);
  const [showAllScenarios, setShowAllScenarios] = useState(false);

  const positions = state && opp ? stockBySku(state, opp.skuId) : [];
  const here = positions.find((p) => p.warehouseId === opp?.warehouseId);
  const history = state && opp ? customersWhoBought(state, opp.skuId) : [];

  const chosenCustomerId = customerId || history[0]?.customerId || '';
  const customer = state && chosenCustomerId ? byId(state.customers, chosenCustomerId) : undefined;

  const assumption = useMemo(() => {
    if (!opp) return null;
    return {
      baselineUnitsPerMonth: opp.assumption.baselineUnitsPerMonth,
      unitsPerDiscountPoint: uplift ?? opp.assumption.unitsPerDiscountPoint,
      horizonMonths: horizon ?? opp.assumption.horizonMonths,
    };
  }, [opp, uplift, horizon]);

  // Keep the proposed quantity inside what is actually available. Availability
  // changes when a reservation is created elsewhere in the session.
  const available = here?.available ?? 0;
  useEffect(() => {
    if (available > 0) setQty((q) => Math.max(1, Math.min(q, available)));
  }, [available]);

  const scenarios = useMemo(() => {
    if (!state || !opp || !here || !assumption) return [];
    const pl = activePriceList(state);
    const listPrice = pl.prices[opp.skuId] ?? byId(state.skus, opp.skuId)!.listPrice;
    const common = {
      lotQty: here.available,
      proposedQty: qty,
      listPrice,
      unitCost: here.weightedCost,
      paymentTermsDays: customer?.paymentTermsDays ?? 60,
      assumption,
      collectionDelayDays: delay ?? opp.assumption.collectionDelayDays,
      today: state.meta.today,
    };
    const ids: { id: ScenarioId; discount: number }[] = [
      { id: 'hold', discount: 0 },
      { id: 'transfer', discount: 0 },
      ...DISCOUNTS.map((d) => ({ id: `discount-${d}` as ScenarioId, discount: d })),
    ];
    return ids.map((x) =>
      runScenario({ ...common, scenarioId: x.id, discountPct: x.discount, transferQty }),
    );
  }, [state, opp, here, assumption, qty, transferQty, customer, delay]);

  if (!state) return <PageLoading />;
  if (!opp || !here) {
    return (
      <div className="page">
        <Card>
          <Empty title="Opportunity not found">
            <Link href="/operations/inventory">Back to inventory opportunities</Link>.
          </Empty>
        </Card>
      </div>
    );
  }

  const sku = byId(state.skus, opp.skuId)!;
  const pl = activePriceList(state);
  const listPrice = pl.prices[opp.skuId] ?? sku.listPrice;
  const selected = scenarios.find((s) => s.id === (`discount-${discount}` as ScenarioId));
  // Five columns at once is more comparison than anyone actually makes. Show the
  // do-nothing baseline against the option on the table; the rest stay one click away.
  const visibleScenarios = showAllScenarios
    ? scenarios
    : scenarios.filter((s) => s.id === 'hold' || s.id === `discount-${discount}`);
  const holdScenario = scenarios.find((s) => s.id === 'hold');
  const recentSales = salesForSku(state, opp.skuId).slice(0, 8);
  const auth = discountAuthority(discount);
  const existingOrder = opp.salesOrderId ? byId(state.salesOrders, opp.salesOrderId) : undefined;
  const custAr = customer ? receivables(state, customer.id) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ gap: 9, marginBottom: 6 }}>
          <Link className="btn ghost sm" href="/operations/inventory">
            ← Inventory
          </Link>
          <Pill tone="warn">{opp.ruleId}</Pill>
          <Pill tone={opp.status === 'Actioned' ? 'good' : opp.status === 'In progress' ? 'info' : 'neutral'}>
            {opp.status}
          </Pill>
        </div>
        <h1>{skuLongLabel(state, opp.skuId)}</h1>
        <p className="sub">{opp.reason}</p>
      </div>

      {existingOrder ? (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="info" title={`An order has already been prepared from this opportunity`}>
            {existingOrder.id} is currently &ldquo;{existingOrder.status}&rdquo;.{' '}
            <Link href={`/operations/orders/${existingOrder.id}`}>Open the order</Link> to continue
            the fulfilment decision.
          </Notice>
        </div>
      ) : null}

      <div className="grid g-detail">
        <div className="stack">
          {/* ------------------------- The evidence ------------------------- */}
          <Card className="flush">
            <CardHead title="What we actually know" hint="Observed facts. No modelling has been applied here." />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Location</th>
                    <th className="r">On hand</th>
                    <th className="r">Reserved</th>
                    <th className="r">Available</th>
                    <th className="r">Oldest lot</th>
                    <th className="r">Weighted landed cost</th>
                    <th className="r">Carrying value</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.warehouseId} style={p.warehouseId === opp.warehouseId ? { background: 'var(--accent-soft)' } : undefined}>
                      <td className="primary-cell">
                        {byId(state.warehouses, p.warehouseId)?.name}
                        <div className="tiny muted">{byId(state.warehouses, p.warehouseId)?.governorate}</div>
                      </td>
                      <td className="r">{p.onHand.toLocaleString('en-EG')}</td>
                      <td className="r">{p.reserved.toLocaleString('en-EG')}</td>
                      <td className="r">{p.available.toLocaleString('en-EG')}</td>
                      <td className="r">
                        <span className={p.maxAgeDays > 180 ? 'cmp-val bad' : undefined}>{p.maxAgeDays} d</span>
                        <div className="tiny muted">{formatDate(p.oldestReceivedOn)}</div>
                      </td>
                      <td className="r">{formatEGP(p.weightedCost)}</td>
                      <td className="r">{formatEGP(p.onHand * p.weightedCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 26 }}>
                <div>
                  <div className="eyebrow">Shipped, last 3 months</div>
                  <div className="num" style={{ fontSize: 15, fontWeight: 620 }}>
                    {formatNumber(observedUnitsPerMonth(state, opp.skuId, 3), 1)} pcs/month
                  </div>
                </div>
                <div>
                  <div className="eyebrow">Shipped, last 6 months</div>
                  <div className="num" style={{ fontSize: 15, fontWeight: 620 }}>
                    {formatNumber(observedUnitsPerMonth(state, opp.skuId, 6), 1)} pcs/month
                  </div>
                </div>
                <div>
                  <div className="eyebrow">Active list price</div>
                  <div className="num" style={{ fontSize: 15, fontWeight: 620 }}>
                    {formatEGP(listPrice)}
                  </div>
                  <div className="tiny muted">{pl.name}</div>
                </div>
              </div>
            </div>
          </Card>

          {/* ------------------------- Recommendation ----------------------- */}
          <Card>
            <CardHead title="Recommended action" hint="With the evidence behind it and what it cannot tell you." />
            <div className="card-body stack" style={{ gap: 11 }}>
              <p className="small">
                Move a defined quantity at a managed discount to a customer with recent purchase
                history for this exact SKU, rather than holding or relocating. The reasoning is that
                a transfer changes location but not demand, and holding is the only option with a
                certain cost and no certain return.
              </p>
              <div className="band deterministic">
                <b>Evidence</b>
                <ul>
                  <li>
                    {here.available.toLocaleString('en-EG')} pcs available at{' '}
                    {byId(state.warehouses, opp.warehouseId)?.name}, oldest lot {here.maxAgeDays} days.
                  </li>
                  <li>
                    Shipped volume fell from 157 pcs/month across March–June to{' '}
                    {observedUnitsPerMonth(state, opp.skuId, 3)} pcs/month over the trailing three
                    months — a fall of{' '}
                    {(100 - (observedUnitsPerMonth(state, opp.skuId, 3) / 157) * 100).toFixed(0)}%.
                  </li>
                  <li>
                    {history.length} customers have bought this SKU, the largest being{' '}
                    {history[0]?.customerName} at {formatQty(history[0]?.totalQty ?? 0)}.
                  </li>
                  <li>
                    Holding costs {formatEGP(holdScenario?.carryingCostOverHorizon ?? 0)} over{' '}
                    {assumption?.horizonMonths} months at {(CARRYING_COST_ANNUAL_PCT * 100).toFixed(0)}% per year.
                  </li>
                </ul>
              </div>
              <div className="band assumption">
                <b>What this cannot tell you</b>
                <ul>
                  <li>Whether a discount actually produces extra volume. It is an assumption, editable below.</li>
                  <li>Whether the destination in a transfer scenario has demand this stock cannot already reach.</li>
                  <li>Whether the customer will pay on time. Collection timing is an assumption, not a commitment.</li>
                  <li>Competitor pricing and market movement are not in the demo dataset at all.</li>
                </ul>
              </div>
            </div>
          </Card>

          {/* --------------------------- Scenarios -------------------------- */}
          <Card className="flush">
            <CardHead
              title="Scenario comparison"
              hint="Deterministic arithmetic is separated from the demand assumption. Change the inputs and everything recalculates."
              right={
                <div className="row" style={{ gap: 9 }}>
                  <Pill tone="info">
                    {formatQty(qty)} at {discount}%
                  </Pill>
                  <button
                    className="btn sm"
                    onClick={() => setShowAllScenarios((v) => !v)}
                    aria-expanded={showAllScenarios}
                  >
                    {showAllScenarios ? 'Compare two' : 'Compare all five'}
                  </button>
                </div>
              }
            />

            <div className="card-body" style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="grid g3">
                <Field
                  label={`Proposed quantity (max ${here.available.toLocaleString('en-EG')})`}
                  help="The quantity that would actually be committed on an order."
                >
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={here.available}
                    value={qty}
                    onChange={(e) => setQty(Math.max(1, Math.min(here.available, Number(e.target.value) || 1)))}
                  />
                  <input
                    type="range"
                    min={1}
                    max={here.available}
                    step={1}
                    value={qty}
                    onChange={(e) => setQty(Number(e.target.value))}
                    aria-label="Proposed quantity"
                  />
                </Field>
                <Field label="Discount off list" help={`Authority: ${auth.role} (${auth.clause}).`}>
                  <div className="seg" role="radiogroup" aria-label="Discount">
                    {[0, ...DISCOUNTS].map((d) => (
                      <button
                        key={d}
                        type="button"
                        role="radio"
                        aria-checked={discount === d}
                        data-on={discount === d}
                        onClick={() => setDiscount(d)}
                      >
                        {d}%
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Transfer quantity" help={`Handling cost EGP ${TRANSFER_COST_PER_UNIT}/pc (demo assumption).`}>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={here.available}
                    value={transferQty}
                    onChange={(e) => setTransferQty(Math.max(0, Math.min(here.available, Number(e.target.value) || 0)))}
                  />
                </Field>
              </div>
            </div>

            <div className="scen-grid">
              {visibleScenarios.map((s) => {
                const isSelected = s.id === `discount-${discount}`;
                return (
                  <div className="scen" key={s.id} data-sel={isSelected}>
                    <div>
                      <div className="scen-name">{s.name}</div>
                      <div className="scen-sum">{s.summary}</div>
                    </div>

                    <div className="scen-block">
                      <span className="eyebrow">Deterministic</span>
                      {s.deal ? (
                        <>
                          <div className="scen-line">
                            <span>Unit price</span>
                            <b>{formatEGP(s.deal.unitPrice, { cents: true })}</b>
                          </div>
                          <div className="scen-line">
                            <span>Revenue</span>
                            <b>{formatEGP(s.deal.revenue)}</b>
                          </div>
                          <div className="scen-line">
                            <span>Cost of goods</span>
                            <b>{formatEGP(s.deal.costOfGoods)}</b>
                          </div>
                          <div className="scen-line">
                            <span>Gross profit</span>
                            <b className={s.deal.grossProfit >= 0 ? 'pos' : 'neg'}>
                              {formatEGP(s.deal.grossProfit)}
                            </b>
                          </div>
                          <div className="scen-line">
                            <span>Gross margin</span>
                            <b>{s.deal.grossMarginPct.toFixed(1)}%</b>
                          </div>
                          <div className="scen-line">
                            <span>Est. collection</span>
                            <b>{formatDate(s.deal.estimatedCollectionDate)}</b>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="scen-line">
                            <span>Revenue</span>
                            <b>—</b>
                          </div>
                          <div className="scen-line">
                            <span>Direct cost</span>
                            <b className={s.transferCost ? 'neg' : undefined}>
                              {s.transferCost ? formatEGP(s.transferCost) : '—'}
                            </b>
                          </div>
                        </>
                      )}
                      <div className="scen-line">
                        <span>Remaining stock</span>
                        <b>{s.remainingStock.toLocaleString('en-EG')} pcs</b>
                      </div>
                      <div className="scen-line">
                        <span>Carrying cost</span>
                        <b className="neg">{formatEGP(s.carryingCostOverHorizon)}</b>
                      </div>
                    </div>

                    <div className="scen-block">
                      <span className="eyebrow" style={{ color: 'var(--amber)' }}>
                        Assumption-led
                      </span>
                      <div className="scen-line">
                        <span>Assumed rate</span>
                        <b>{s.assumed.assumedUnitsPerMonth}/mo</b>
                      </div>
                      <div className="scen-line">
                        <span>Months to clear rest</span>
                        <b>{s.assumed.monthsToClearRemaining?.toFixed(1) ?? '—'}</b>
                      </div>
                      <div className="scen-line">
                        <span>Carrying avoided</span>
                        <b className={s.assumed.carryingCostAvoided > 0 ? 'pos' : undefined}>
                          {formatEGP(s.assumed.carryingCostAvoided)}
                        </b>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="card-body stack" style={{ borderTop: '1px solid var(--line)', gap: 11 }}>
              <div className="band caution">
                <b>Read this before quoting any of the above</b>
                <ul>
                  {(selected?.cautions ?? []).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>

              <div className="grid g3">
                <Field
                  label="Uplift assumption (pcs/month per 1pp discount)"
                  help="The single lever that decides whether a discount looks worthwhile. It is an assumption, not evidence."
                >
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={uplift ?? opp.assumption.unitsPerDiscountPoint}
                    onChange={(e) => setUplift(Number(e.target.value))}
                  />
                </Field>
                <Field label="Modelling horizon (months)" help="Window over which carrying cost and clearance are modelled.">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={12}
                    value={horizon ?? opp.assumption.horizonMonths}
                    onChange={(e) => setHorizon(Number(e.target.value))}
                  />
                </Field>
                <Field label="Collection delay beyond terms (days)" help="Used only for the estimated collection date.">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={180}
                    value={delay ?? opp.assumption.collectionDelayDays}
                    onChange={(e) => setDelay(Number(e.target.value))}
                  />
                </Field>
              </div>
              <div className="row">
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() =>
                    void dispatch({
                      type: 'opportunity.setAssumption',
                      opportunityId: opp.id,
                      unitsPerDiscountPoint: uplift ?? opp.assumption.unitsPerDiscountPoint,
                      horizonMonths: horizon ?? opp.assumption.horizonMonths,
                      collectionDelayDays: delay ?? opp.assumption.collectionDelayDays,
                    })
                  }
                >
                  Save the assumption to this opportunity
                </button>
                <span className="tiny muted">
                  Baseline {opp.assumption.baselineUnitsPerMonth} pcs/month is observed, not assumed,
                  and is not editable.
                </span>
              </div>
            </div>
          </Card>

          {/* -------------------------- Prepare order ----------------------- */}
          <Card>
            <CardHead
              title="Prepare a proposed order"
              hint="Creates a draft order and runs the credit and stock checks immediately."
            />
            <div className="card-body stack">
              {existingOrder ? (
                <Notice tone="info" title="Already prepared">
                  {existingOrder.id} was created from this opportunity.{' '}
                  <Link href={`/operations/orders/${existingOrder.id}`}>Continue there</Link>.
                </Notice>
              ) : (
                <>
                  <div className="grid g3">
                    <Field label="Customer" help="Ranked by historical volume for this SKU.">
                      <select
                        className="input"
                        value={chosenCustomerId}
                        onChange={(e) => setCustomerId(e.target.value)}
                      >
                        {history.map((h) => (
                          <option key={h.customerId} value={h.customerId}>
                            {h.customerName} — {h.totalQty} pcs bought
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Quantity" help={`${here.available.toLocaleString('en-EG')} available at this location.`}>
                      <input
                        className="input"
                        type="number"
                        value={qty}
                        min={1}
                        max={here.available}
                        onChange={(e) => setQty(Number(e.target.value))}
                      />
                    </Field>
                    <Field label="Discount" help={`${auth.role} authority (${auth.clause}).`}>
                      <input
                        className="input"
                        type="number"
                        value={discount}
                        min={0}
                        max={40}
                        onChange={(e) => setDiscount(Number(e.target.value))}
                      />
                    </Field>
                  </div>

                  {selected?.deal ? (
                    <div className="band deterministic">
                      <b>What will be committed</b>
                      {formatQty(selected.deal.qty)} at {formatEGP(selected.deal.unitPrice, { cents: true })} each ={' '}
                      {formatEGP(selected.deal.revenue)} revenue, {formatEGP(selected.deal.grossProfit)} gross profit
                      ({selected.deal.grossMarginPct.toFixed(1)}% margin). Stock remaining at this
                      location afterwards: {selected.remainingStock.toLocaleString('en-EG')} pcs.
                    </div>
                  ) : null}

                  {custAr && custAr.overdue > 0 ? (
                    <Notice tone="warn" title={`${customer?.name} carries an overdue balance`}>
                      {formatEGP(custAr.overdue)} overdue, oldest {custAr.worstOverdueDays} days past
                      due. The credit check will run when the order is created and may withhold
                      automatic release.
                    </Notice>
                  ) : null}

                  <button
                    className="btn primary"
                    style={{ alignSelf: 'flex-start' }}
                    disabled={busy || !chosenCustomerId}
                    onClick={async () => {
                      const r = await dispatch({
                        type: 'opportunity.createOrder',
                        opportunityId: opp.id,
                        customerId: chosenCustomerId,
                        qty,
                        discountPct: discount,
                      });
                      if (r.ok && r.navigateTo) router.push(r.navigateTo);
                    }}
                  >
                    Prepare proposed order <Icon name="arrow" size={14} />
                  </button>
                </>
              )}
            </div>
          </Card>
        </div>

        {/* ---------------------------- Side rail ---------------------------- */}
        <div className="stack">
          <Card className="flush">
            <CardHead title="Who has bought this SKU" hint="The evidence behind every suggestion." />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="r">Bought</th>
                    <th className="r">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const ar = receivables(state, h.customerId);
                    return (
                      <tr key={h.customerId}>
                        <td>
                          <Link href={`/customers/${h.customerId}`} className="primary-cell">
                            {h.customerName}
                          </Link>
                          <div className="tiny muted">
                            {h.orderCount} order{h.orderCount === 1 ? '' : 's'} · avg{' '}
                            {formatEGP(h.avgUnitPrice)}
                          </div>
                          {ar.overdue > 0 ? (
                            <div style={{ marginTop: 4 }}>
                              <Pill tone="bad">{formatEGP(ar.overdue)} overdue</Pill>
                            </div>
                          ) : null}
                        </td>
                        <td className="r">{h.totalQty.toLocaleString('en-EG')}</td>
                        <td className="r tiny">
                          {formatDate(h.lastPurchase)}
                          <div className="muted">{h.daysSinceLast} d ago</div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="flush">
            <CardHead title="Recent shipped sales" hint="Raw history for this SKU." />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Customer</th>
                    <th className="r">Qty</th>
                    <th className="r">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSales.map((h) => (
                    <tr key={h.id}>
                      <td className="tiny">{formatDate(h.soldOn)}</td>
                      <td className="tiny">{byId(state.customers, h.customerId)?.name}</td>
                      <td className="r">{h.qty}</td>
                      <td className="r">{formatEGP(h.unitPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHead title="Substitutes in the same size" hint="Where a customer could be offered an alternative." />
            <div className="card-body stack" style={{ gap: 9 }}>
              {state.skus
                .filter((s) => s.size === sku.size && s.id !== sku.id)
                .map((s) => {
                  const pos = stockBySku(state, s.id);
                  const avail = pos.reduce((n, p) => n + p.available, 0);
                  return (
                    <div key={s.id} className="row" style={{ justifyContent: 'space-between' }}>
                      <div>
                        <div className="primary-cell">
                          {s.size} {s.ply}
                        </div>
                        <div className="tiny muted">
                          {s.brand} {s.pattern}
                        </div>
                      </div>
                      <div className="r">
                        <div className="num">{avail.toLocaleString('en-EG')} avail.</div>
                        <div className="tiny muted">{formatEGP(pl.prices[s.id] ?? s.listPrice)}</div>
                      </div>
                    </div>
                  );
                })}
              {state.skus.filter((s) => s.size === sku.size && s.id !== sku.id).length === 0 ? (
                <span className="small muted">No alternative pattern is stocked in this size.</span>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
