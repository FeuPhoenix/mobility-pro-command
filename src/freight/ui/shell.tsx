'use client';

/**
 * The freight workspace shell: navigation, who is acting, which company, and
 * an honest statement of what the integrations are actually doing.
 */

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, Modal } from '@/components/ui';
import { useFreight } from './FreightProvider';

const NAV = [
  { href: '/freight', label: 'Overview', exact: true },
  { href: '/freight/rfqs', label: 'Requests' },
  { href: '/freight/inbox', label: 'Replies' },
  { href: '/freight/providers', label: 'Providers' },
  { href: '/freight/settings', label: 'Settings' },
];

export function FreightShell({ children }: { children: React.ReactNode }) {
  const { state, loading, error, busy, companyId, setCompanyId, switchUser, loadDemo, toasts, dismissToast } =
    useFreight();
  const pathname = usePathname();
  const [confirmDemo, setConfirmDemo] = React.useState(false);

  const counts = state?.overview?.counts;
  const badge = (href: string): number => {
    if (!counts) return 0;
    if (href === '/freight/inbox') return counts.repliesToMatch;
    if (href === '/freight/rfqs') return counts.quotesToCheck;
    if (href === '/freight') return counts.awaitingApproval;
    return 0;
  };

  const isActive = (item: (typeof NAV)[number]) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Freight">
        <div className="rail-brand">
          <Link href="/freight" className="wordmark">
            <span className="wordmark-glyph">MP</span>
            <span className="wordmark-text">
              <b>Mobility Pro</b>
              <span>Freight RFQ</span>
            </span>
          </Link>
        </div>

        <div className="rail-nav">
          <div className="rail-group-label" style={{ paddingTop: 4 }}>
            Freight
          </div>
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rail-link"
              data-active={isActive(item)}
              data-tone={badge(item.href) > 0 ? 'alert' : undefined}
            >
              {item.label}
              {badge(item.href) > 0 ? <span className="count">{badge(item.href)}</span> : null}
            </Link>
          ))}

          <div className="rail-group-label">Other modules</div>
          <Link href="/" className="rail-link">
            Operations demo
          </Link>
        </div>

        <div className="rail-foot">
          <AdapterChip />
          <button className="btn ghost sm" style={{ color: '#9db3c8', justifyContent: 'flex-start' }} onClick={() => setConfirmDemo(true)}>
            <Icon name="reset" size={14} /> Load demo data
          </button>
        </div>
      </nav>

      <div className="workspace">
        <header className="topbar">
          <div className="crumbs">
            <b>Freight RFQ</b>
            <span className="sep">·</span>
            <span>{state?.user?.title ?? 'Logistics'}</span>
          </div>

          {state?.integrations?.demoMode ? <span className="demo-chip">Demo data</span> : null}

          <div className="topbar-spacer" />

          {state && state.companies.length > 0 ? (
            <label className="row" style={{ gap: 7 }}>
              <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>Company</span>
              <select
                className="input"
                style={{ width: 'auto', minWidth: 190, padding: '5px 8px', fontSize: 12.5 }}
                value={companyId ?? ''}
                onChange={(e) => setCompanyId(e.target.value || null)}
                aria-label="Which company to work on"
              >
                <option value="">All companies</option>
                {state.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {state && state.users.length > 0 ? (
            <label className="row" style={{ gap: 7 }}>
              <span className="tiny muted" style={{ whiteSpace: 'nowrap' }}>Acting as</span>
              <select
                className="input"
                style={{ width: 'auto', minWidth: 210, padding: '5px 8px', fontSize: 12.5 }}
                value={state.user?.id ?? ''}
                onChange={(e) => void switchUser(e.target.value)}
                disabled={busy}
                aria-label="Acting as which person"
              >
                {state.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} — {u.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
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
        ) : loading ? (
          <div className="page">
            <div className="stack" aria-busy="true" aria-label="Loading the freight workspace">
              <div className="skel" style={{ height: 120, borderRadius: 14 }} />
              <div className="skel" style={{ height: 240, borderRadius: 14 }} />
            </div>
          </div>
        ) : !state?.seeded ? (
          <EmptyWorkspace onLoad={() => setConfirmDemo(true)} />
        ) : (
          children
        )}
      </div>

      {confirmDemo ? (
        <Modal
          title="Load the demonstration dataset?"
          onClose={() => setConfirmDemo(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDemo(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  await loadDemo();
                  setConfirmDemo(false);
                }}
              >
                Replace everything with the demo data
              </button>
            </>
          }
        >
          <p className="small">
            This clears every company, provider, request, quotation, comparison and record in the
            freight workspace, then rebuilds a fictional dataset by running the real workflow:
            requests are created, approved and sent, and replies are collected and read by the same
            code that handles live mail.
          </p>
          <p className="small muted" style={{ marginTop: 10 }}>
            Nothing is transmitted. Every address in the dataset ends in <code>.test</code>, which
            cannot receive mail. The operations demo elsewhere in this application is not affected.
          </p>
        </Modal>
      ) : null}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast" data-tone={t.tone} onClick={() => dismissToast(t.id)} role="status">
            <span className="tmark" aria-hidden>
              <Icon name={t.tone === 'ok' ? 'check' : 'alert'} size={15} />
            </span>
            <span style={{ flex: 1 }}>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdapterChip() {
  const { state } = useFreight();
  const mail = state?.integrations?.mail;
  const erp = state?.integrations?.erp;
  if (!mail || !erp) return null;

  const live = mail.connected || erp.connected;
  return (
    <div className="adapter-chip">
      <span className="adapter-dot" />
      <span>
        <b>{live ? 'Live connections in use' : 'Simulated mail and ERPNext'}</b>
        <span>
          {live
            ? 'At least one integration is connected. Approved email may be delivered for real.'
            : 'Email is prepared and approved but never transmitted. ERPNext records are local only.'}
        </span>
      </span>
    </div>
  );
}

function EmptyWorkspace({ onLoad }: { onLoad: () => void }) {
  return (
    <div className="page">
      <div className="empty" style={{ maxWidth: 620, margin: '48px auto' }}>
        <h3>This freight workspace is empty</h3>
        <p>
          There are no companies or freight providers yet. Load the demonstration dataset to see the
          whole journey with realistic fictional data, or add your first company in Providers.
        </p>
        <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 14 }}>
          <button className="btn primary" onClick={onLoad}>
            Load the demonstration dataset
          </button>
          <Link className="btn" href="/freight/providers">
            Add a company
          </Link>
        </div>
      </div>
    </div>
  );
}
