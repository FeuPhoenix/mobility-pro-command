'use client';

/**
 * Sign in, and first-run setup.
 *
 * One screen handles both: when nobody can sign in yet it offers to create the
 * first account, and otherwise it asks for credentials. While the workspace
 * holds demonstration data it also lists the demo accounts, because a demo
 * nobody can get into is not a demo.
 */

import React from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHead, Field, Notice } from '@/components/ui';
import { WorkspaceModeSwitch } from '@/freight/ui/WorkspaceModeSwitch';

interface DemoAccount {
  name: string;
  title: string;
  email: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = React.useState<'loading' | 'signin' | 'setup'>('loading');
  const [demo, setDemo] = React.useState<{ password: string; accounts: DemoAccount[] } | null>(null);
  const [canGoDemo, setCanGoDemo] = React.useState(false);

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/freight/auth/state', { cache: 'no-store' });
        const data = (await res.json()) as {
          signedIn?: boolean;
          needsSetup?: boolean;
          demo?: { password: string; accounts: DemoAccount[] } | null;
          workspace?: { switchEnabled: boolean };
        };
        if (cancelled) return;
        if (data.signedIn) {
          router.replace('/freight');
          return;
        }
        setDemo(data.demo ?? null);
        // Only offered while nobody has an account, so there is nothing to protect.
        setCanGoDemo(Boolean(data.workspace?.switchEnabled && data.needsSetup));
        setMode(data.needsSetup ? 'setup' : 'signin');
      } catch {
        if (!cancelled) setMode('signin');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === 'setup' ? '/api/freight/auth/setup' : '/api/freight/auth/login';
      const body = mode === 'setup' ? { name, email, password } : { email, password };
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) {
        setError(payload.error ?? 'That did not work.');
        return;
      }
      // A full navigation, so every server component re-reads the new session.
      window.location.href = '/freight';
    } catch {
      setError('The server could not be reached.');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'loading') {
    return (
      <main className="signin-page">
        <div className="skel" style={{ height: 320, width: 'min(420px, 92vw)', borderRadius: 14 }} />
      </main>
    );
  }

  return (
    <main className="signin-page">
      <div className="signin-box">
        <div className="signin-brand">
          <span className="wordmark-glyph">MP</span>
          <span>
            <b>Mobility Pro</b>
            <span>Freight RFQ</span>
          </span>
        </div>

        <Card>
          <CardHead
            title={mode === 'setup' ? 'Create the first account' : 'Sign in'}
            hint={
              mode === 'setup'
                ? 'Nobody can sign in to this workspace yet. This account will be the Logistics Operations Manager.'
                : 'Approving an email is a named act, so it needs a named person.'
            }
          />
          <div className="card-body">
            <form onSubmit={submit} className="stack">
              {mode === 'setup' ? (
                <Field label="Your name">
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    required
                  />
                </Field>
              ) : null}

              <Field label="Email address">
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </Field>

              <Field
                label="Password"
                help={mode === 'setup' ? 'At least 10 characters, with a letter and a number.' : undefined}
              >
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                  required
                />
              </Field>

              {error ? (
                <Notice tone="bad" title="">
                  {error}
                </Notice>
              ) : null}

              <button className="btn primary block" type="submit" disabled={busy}>
                {busy ? 'Working…' : mode === 'setup' ? 'Create the account' : 'Sign in'}
              </button>
            </form>
          </div>
        </Card>

        {canGoDemo ? <WorkspaceModeSwitch mode="production" /> : null}

        {demo && demo.accounts.length > 0 ? (
          <Card>
            <CardHead
              title="Demonstration accounts"
              hint="This workspace holds fictional data, so the accounts are listed. They are real accounts with real passwords."
            />
            <div className="card-body">
              <table className="demo-accounts">
                <caption className="sr-only">Accounts available in the demonstration dataset</caption>
                <tbody>
                  {demo.accounts.map((a) => (
                    <tr key={a.email}>
                      <td>
                        <b>{a.name}</b>
                        <span>{a.title}</span>
                      </td>
                      <td>
                        <code>{a.email}</code>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => {
                            setEmail(a.email);
                            setPassword(demo.password);
                            setError(null);
                          }}
                        >
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="fr-foot-note">
                Password for all of them: <code>{demo.password}</code>. Reseeding the demonstration
                data replaces these accounts.
              </p>
            </div>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
