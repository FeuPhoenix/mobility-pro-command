'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, Empty, Icon, MeasureRow, PageLoading, Pill, RefChip } from '@/components/ui';
import { buildBriefing, buildExceptions } from '@/domain/exceptions';
import { DEMAND_TO_CASH } from '@/domain/cycle';
import { byId, daysInventoryOutstanding, inventoryCarryingValue } from '@/domain/selectors';
import { formatDateShort, formatDateTime, formatEGP, formatQty } from '@/domain/money';
import type { ExceptionItem } from '@/domain/types';

const SEV_TONE = { critical: 'bad', high: 'warn', medium: 'info' } as const;

export default function OverviewPage() {
  const { state, dispatch } = useDemo();
  const router = useRouter();

  const exceptions = useMemo(() => (state ? buildExceptions(state) : []), [state]);
  const briefing = useMemo(() => (state ? buildBriefing(state, exceptions) : null), [state, exceptions]);

  if (!state || !briefing) return <PageLoading />;

  const open = exceptions.filter((e) => e.status !== 'Resolved');
  const resolved = exceptions.filter((e) => e.status === 'Resolved');
  const user = byId(state.users, state.meta.currentUserId);
  const mine = open.filter((e) => e.ownerId === state.meta.currentUserId);

  return (
    <div className="page">
      {/* ---------------------------- Focal point ---------------------------- */}
      <section className="briefing">
        <div className="eyebrow">Your operation today</div>
        <h1>{briefing.headline}</h1>
        <ul>
          {briefing.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
          {mine.length > 0 ? (
            <li>
              {mine.length} of these sit with you, {user?.name} ({user?.title}).
            </li>
          ) : null}
        </ul>
        <div className="briefing-actions">
          <button className="btn primary" onClick={() => void dispatch({ type: 'demo.setGuidedStep', step: 0 })}>
            <Icon name="play" size={14} />{' '}
            {state.meta.guidedStep === null ? 'Start guided demo' : 'Restart guided demo'}
          </button>
          <Link className="btn" href="/operations/documents">
            Explore freely
          </Link>
          {open[0] ? (
            <Link className="btn" href={open[0].href}>
              Go to the top item <Icon name="arrow" size={14} />
            </Link>
          ) : null}
        </div>
      </section>

      <div className="grid g-main" style={{ marginTop: 18 }}>
        {/* -------------------------- Exception queue ------------------------ */}
        <div className="stack">
          <Card className="flush">
            <CardHead
              eyebrow="Ranked by severity, then by the value involved"
              title="Exception queue"
              hint="Every row names the rule that raised it. Open one to reach the underlying records."
              right={
                <span className="tiny muted num">
                  {open.length} open · {resolved.length} resolved today
                </span>
              }
            />
            {open.length === 0 ? (
              <Empty title="Nothing needs a decision">
                Every rule-driven exception in this dataset has been resolved. Reset the demo to
                return to the original scenario.
              </Empty>
            ) : (
              <div>
                {open.map((e) => (
                  <ExceptionRow key={e.id} item={e} state={state} onOpen={() => router.push(e.href)} />
                ))}
              </div>
            )}
            {resolved.length > 0 ? (
              <div>
                {resolved.map((e) => (
                  <ExceptionRow key={e.id} item={e} state={state} onOpen={() => router.push(e.href)} />
                ))}
              </div>
            ) : null}
          </Card>

          <Card className="flush">
            <CardHead
              title="Activity across related records"
              hint="One trail joining documents, inventory decisions, orders and approvals."
              right={
                <span className="tiny muted">
                  <Pill tone="info" dot>System rule</Pill>{' '}
                  <Pill tone="good" dot>Person</Pill>{' '}
                  <Pill tone="warn" dot>Assistant</Pill>
                </span>
              }
            />
            <div className="timeline">
              {state.activity.slice(0, 9).map((a) => (
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
                    {a.refs.length ? (
                      <div className="tl-refs">
                        {a.refs.map((r, i) => (
                          <RefChip key={`${r.id}-${i}`} refItem={r} />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ----------------------------- Context ----------------------------- */}
        <div className="stack">
          <Card className="flush">
            <CardHead
              title="What is at stake"
              hint="Four different measures. They are deliberately never added together."
            />
            <div className="measures">
              {briefing.measures.map((m) => (
                <MeasureRow key={m.kind} label={m.label} amount={m.amount} note={m.note} />
              ))}
            </div>
          </Card>

          <Card>
            <CardHead title="Inventory position" hint="Across three distribution centres." />
            <div className="card-body">
              <dl className="kv">
                <dt>Inventory carrying value</dt>
                <dd>{formatEGP(inventoryCarryingValue(state))}</dd>
                <dt>Days inventory outstanding</dt>
                <dd>{daysInventoryOutstanding(state)} days</dd>
                <dt>Stock lots on hand</dt>
                <dd>{state.lots.length}</dd>
                <dt>Pieces on hand</dt>
                <dd>{formatQty(state.lots.reduce((n, l) => n + l.qty, 0))}</dd>
                <dt>Reserved against orders</dt>
                <dd>
                  {formatQty(
                    state.reservations.filter((r) => !r.releasedAt).reduce((n, r) => n + r.qty, 0),
                  )}
                </dd>
              </dl>
              <div className="tiny muted" style={{ marginTop: 10, lineHeight: 1.5 }}>
                Carrying value is landed cost of physical stock. It is not sales value and not
                profit. DIO is computed from trailing six-month cost of goods shipped.
              </div>
            </div>
          </Card>

          <CycleCard />
        </div>
      </div>
    </div>
  );
}

/**
 * The demand-to-cash map is orientation, not work — it is collapsed so the
 * landing view stays about what needs a decision today.
 */
function CycleCard() {
  const [open, setOpen] = useState(false);
  const demonstrated = DEMAND_TO_CASH.filter((s) => s.coverage === 'demonstrated').length;

  return (
    <Card className="flush">
      <button
        className="disclosure"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="cycle-body"
      >
        <span>
          <span className="disclosure-title">Demand-to-cash</span>
          <span className="disclosure-sub">
            {demonstrated} of {DEMAND_TO_CASH.length} stages demonstrated here
          </span>
        </span>
        <span className="disclosure-chev" data-open={open} aria-hidden>
          <Icon name="arrow" size={15} />
        </span>
      </button>

      <div id="cycle-body" hidden={!open}>
        <div className="cycle" style={{ borderTop: '1px solid var(--line)' }}>
          {DEMAND_TO_CASH.map((s) => (
            <div className="cycle-row" data-cov={s.coverage} key={s.key}>
              <div className="cycle-node">
                <i />
              </div>
              <div className="cycle-main">
                {s.href ? (
                  <Link href={s.href}>
                    <b>{s.stage}</b>
                  </Link>
                ) : (
                  <b>{s.stage}</b>
                )}
                <span>{s.demoNote ?? s.activities}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="tiny muted">
            Transcribed from the client briefing workbook. Unfilled nodes are shown for orientation
            only — this demo does not claim the wider cycle is automated.
          </div>
        </div>
      </div>
    </Card>
  );
}

function ExceptionRow({
  item,
  state,
  onOpen,
}: {
  item: ExceptionItem;
  state: NonNullable<ReturnType<typeof useDemo>['state']>;
  onOpen: () => void;
}) {
  const owner = byId(state.users, item.ownerId);
  return (
    <div className="exc" data-sev={item.severity} data-status={item.status}>
      <div className="bar" />
      <div className="exc-inner">
        <div className="exc-top">
          <Pill tone={item.status === 'Resolved' ? 'good' : SEV_TONE[item.severity]}>
            {item.status === 'Resolved' ? 'Resolved' : item.severity}
          </Pill>
          <span className="exc-title">{item.title}</span>
          {item.status === 'In progress' ? <Pill tone="info">In progress</Pill> : null}
        </div>

        <p className="exc-why">{item.why}</p>

        {/* One headline number, then everything else in a single quiet line.
            Owner, rule and timestamp still matter for an audit trail, but they
            are not what a person scans the queue for. */}
        <div className="exc-money">
          <b>{formatEGP(item.measure.amount)}</b>
          <span>{measureLabel(item)}</span>
        </div>

        <div className="exc-meta">
          <span>{owner?.name}</span>
          <span className="sep">·</span>
          <span className="mono">{item.ruleId}</span>
          <span className="sep">·</span>
          <span>raised {formatDateShort(item.detectedAt.slice(0, 10))}</span>
        </div>

        <div className="exc-cta">
          <button className="btn sm primary" onClick={onOpen}>
            {item.nextAction} <Icon name="arrow" size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

function measureLabel(item: ExceptionItem): string {
  return (
    {
      inventory_carrying_value: 'Carrying value',
      potential_sales_value: 'Potential sales value',
      gross_profit: 'Gross profit effect',
      receivables_at_risk: 'Receivables at risk',
      purchase_value_exposed: 'Purchase value exposed',
    } as const
  )[item.measure.kind];
}
