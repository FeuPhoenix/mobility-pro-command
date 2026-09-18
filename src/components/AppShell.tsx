'use client';

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDemo } from './DemoProvider';
import { AssistantPanel } from './Assistant';
import { GuidedDemo } from './GuidedDemo';
import { Icon, Modal, PageLoading } from './ui';
import { buildExceptions } from '@/domain/exceptions';
import { formatDate } from '@/domain/money';

const NAV = [
  { href: '/', label: 'Overview', icon: 'overview' as const, exact: true },
  { href: '/operations/documents', label: 'Document cases', icon: 'documents' as const },
  { href: '/operations/inventory', label: 'Inventory', icon: 'inventory' as const },
  { href: '/operations/orders', label: 'Orders', icon: 'orders' as const },
  { href: '/customers', label: 'Customers', icon: 'customers' as const },
  { href: '/approvals', label: 'Approvals', icon: 'approvals' as const },
  { href: '/automations', label: 'Automations', icon: 'automations' as const },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { state, loading, error, reset, busy, toasts, dismissToast, dispatch } = useDemo();
  const pathname = usePathname();
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const counts = useMemo(() => {
    if (!state) return { docs: 0, inv: 0, orders: 0, approvals: 0, critical: 0 };
    const exceptions = buildExceptions(state);
    return {
      docs: exceptions.filter((e) => e.kind === 'document_discrepancy' && e.status !== 'Resolved').length,
      inv: exceptions.filter((e) => (e.kind === 'aging_inventory' || e.kind === 'warehouse_imbalance') && e.status !== 'Resolved').length,
      orders: exceptions.filter((e) => (e.kind === 'credit_review' || e.kind === 'stale_price_list') && e.status !== 'Resolved').length,
      approvals: state.approvals.filter((a) => a.status === 'Pending').length,
      critical: exceptions.filter((e) => e.severity === 'critical' && e.status !== 'Resolved').length,
    };
  }, [state]);

  const currentUser = state?.users.find((u) => u.id === state.meta.currentUserId);

  const countFor = (href: string) =>
    href === '/operations/documents'
      ? counts.docs
      : href === '/operations/inventory'
        ? counts.inv
        : href === '/operations/orders'
          ? counts.orders
          : href === '/approvals'
            ? counts.approvals
            : 0;

  const isActive = (item: (typeof NAV)[number]) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <div className="shell">
      <nav className="rail" data-open={railOpen} aria-label="Main">
        <div className="rail-brand">
          <Link href="/" className="wordmark" onClick={() => setRailOpen(false)}>
            <span className="wordmark-glyph">MP</span>
            <span className="wordmark-text">
              <b>Mobility Pro</b>
              <span>Command</span>
            </span>
          </Link>
        </div>

        <div className="rail-nav">
          <div className="rail-group-label" style={{ paddingTop: 4 }}>
            Today
          </div>
          {NAV.slice(0, 1).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rail-link"
              data-active={isActive(item)}
              onClick={() => setRailOpen(false)}
            >
              <Icon name={item.icon} />
              {item.label}
              {counts.critical > 0 ? <span className="count">{counts.critical}</span> : null}
            </Link>
          ))}

          <div className="rail-group-label">Operations</div>
          {NAV.slice(1, 4).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rail-link"
              data-active={isActive(item)}
              data-tone={item.href === '/operations/documents' && counts.docs > 0 ? 'alert' : undefined}
              onClick={() => setRailOpen(false)}
            >
              <Icon name={item.icon} />
              {item.label}
              {countFor(item.href) > 0 ? <span className="count">{countFor(item.href)}</span> : null}
            </Link>
          ))}

          <div className="rail-group-label">Commercial</div>
          {NAV.slice(4, 6).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rail-link"
              data-active={isActive(item)}
              onClick={() => setRailOpen(false)}
            >
              <Icon name={item.icon} />
              {item.label}
              {countFor(item.href) > 0 ? <span className="count">{countFor(item.href)}</span> : null}
            </Link>
          ))}

          <div className="rail-group-label">Platform</div>
          {NAV.slice(6).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rail-link"
              data-active={isActive(item)}
              onClick={() => setRailOpen(false)}
            >
              <Icon name={item.icon} />
              {item.label}
            </Link>
          ))}
        </div>

        <div className="rail-foot">
          <div className="adapter-chip">
            <span className="adapter-dot" />
            <span>
              <b>ERPNext demo adapter</b>
              <span>Local fictional dataset. Not connected to any ERPNext instance.</span>
            </span>
          </div>
          <button className="btn ghost sm" style={{ color: '#9db3c8', justifyContent: 'flex-start' }} onClick={() => setConfirmReset(true)}>
            <Icon name="reset" size={14} /> Reset demo
          </button>
        </div>
      </nav>

      <div className="workspace">
        <header className="topbar">
          <button className="btn ghost sm menu-btn" onClick={() => setRailOpen((v) => !v)} aria-label="Toggle navigation">
            <Icon name="menu" />
          </button>

          <div className="crumbs">
            <b>{state ? formatDate(state.meta.today) : '—'}</b>
            <span className="sep">·</span>
            <span>Mobility Pro Distribution S.A.E.</span>
          </div>

          <span className="demo-chip">Demo data</span>

          <div className="topbar-spacer" />

          {state ? (
            <label className="row" style={{ gap: 7 }}>
              <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>Acting as</span>
              <select
                className="input"
                style={{ width: 'auto', minWidth: 190, padding: '5px 8px', fontSize: 12.5 }}
                value={state.meta.currentUserId}
                onChange={(e) => void dispatch({ type: 'demo.setRole', userId: e.target.value })}
                aria-label="Acting as which demo role"
              >
                {state.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} — {u.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button
            className="btn"
            onClick={() => void dispatch({ type: 'demo.setGuidedStep', step: state?.meta.guidedStep === null ? 0 : null })}
          >
            <Icon name="play" size={14} />
            {state?.meta.guidedStep === null ? 'Start guided demo' : 'Exit guided demo'}
          </button>

          <button className="btn primary" onClick={() => setAssistantOpen((v) => !v)} aria-expanded={assistantOpen}>
            <Icon name="assistant" size={14} /> Assistant
          </button>
        </header>

        {error ? (
          <div className="page">
            <div className="notice bad">
              <div>
                <b>The workspace could not load.</b>
                {error} Check that the server is running, then reload.
              </div>
            </div>
          </div>
        ) : loading || !state ? (
          <PageLoading />
        ) : (
          children
        )}
      </div>

      {railOpen ? <div className="scrim" onClick={() => setRailOpen(false)} /> : null}
      {assistantOpen ? <AssistantPanel onClose={() => setAssistantOpen(false)} /> : null}
      <GuidedDemo />

      {confirmReset ? (
        <Modal
          title="Reset the demo?"
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  await reset();
                  setConfirmReset(false);
                }}
              >
                Reset to the original scenario
              </button>
            </>
          }
        >
          <p className="small">
            Every change you have made in this session will be discarded: document corrections,
            cases and drafts, orders, approvals, reservations and the activity trail. The dataset
            returns to exactly the state a fresh visitor sees.
          </p>
          <p className="small muted" style={{ marginTop: 10 }}>
            Only your own demo session is affected. Sessions are isolated, so anyone else exploring
            the demo keeps their own state.
          </p>
        </Modal>
      ) : null}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-tone={t.tone} onClick={() => dismissToast(t.id)} role="status">
            <span className="tmark" aria-hidden>
              {t.tone === 'ok' ? <Icon name="check" size={15} /> : <Icon name="alert" size={15} />}
            </span>
            <span style={{ flex: 1 }}>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
