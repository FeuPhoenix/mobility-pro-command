'use client';

/**
 * The demonstration / production switch. Only rendered when the server has
 * FREIGHT_MODE_SWITCH=on. The two workspaces are separate databases, so
 * switching never mixes or deletes anything; it changes which one is open.
 */

import React from 'react';
import { Modal } from '@/components/ui';

export function WorkspaceModeSwitch({ mode }: { mode: 'demo' | 'production' }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const target = mode === 'demo' ? 'production' : 'demo';

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/freight/workspace-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: target }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) {
        setError(payload.error ?? 'That did not work.');
        return;
      }
      // A full navigation, so every request re-reads the workspace that is now open.
      window.location.href = '/freight';
    } catch {
      setError('The server could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row" style={{ gap: 8 }} data-testid="workspace-mode">
        <span className={mode === 'demo' ? 'demo-chip' : 'tiny'} style={mode === 'demo' ? undefined : { fontWeight: 600 }}>
          {mode === 'demo' ? 'Demo workspace' : 'Production'}
        </span>
        <button className="btn sm" onClick={() => setOpen(true)}>
          {mode === 'demo' ? 'Switch to production' : 'Switch to demo'}
        </button>
      </div>
      {open ? (
        <Modal
          title={target === 'production' ? 'Switch to production?' : 'Switch to the demonstration?'}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void go()}>
                {target === 'production' ? 'Switch to production' : 'Switch to demo'}
              </button>
            </>
          }
        >
          {target === 'production' ? (
            <p className="small" style={{ lineHeight: 1.6 }}>
              You will be asked to sign in, or to create the first account if there is none. The demonstration data
              stays where it is and is not copied across.
            </p>
          ) : (
            <p className="small" style={{ lineHeight: 1.6 }}>
              The demonstration workspace has no sign-in: anyone who can reach this server can act as anyone in it. It
              holds only fictional data, and email and ERPNext stay simulated. Your production data is not opened,
              changed or deleted.
            </p>
          )}
          {error ? <p className="small" style={{ color: 'var(--bad, #b42318)' }}>{error}</p> : null}
        </Modal>
      ) : null}
    </>
  );
}
