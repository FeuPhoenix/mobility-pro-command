'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SEED_VERSION } from '@/domain/version';
import type { Action } from '@/server/actions';
import type { DemoState } from '@/domain/types';

/**
 * The browser owns the demo document.
 *
 * It is kept in `localStorage` (~42 KB) so a refresh, a new tab, or a closed
 * laptop never loses the state mid-presentation, and so two people opening the
 * same link get genuinely independent sessions. Every mutation is still computed
 * by the server — see `src/server/demoState.ts` for why it works this way.
 */
const STORAGE_KEY = `mpc.demo.${SEED_VERSION}`;

interface Toast {
  id: number;
  tone: 'ok' | 'error';
  message: string;
}

interface DemoContextValue {
  state: DemoState | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  dispatch: (
    action: Action,
  ) => Promise<{ ok: boolean; message: string; navigateTo?: string; created?: Record<string, string> }>;
  reset: () => Promise<void>;
  refresh: () => Promise<void>;
  toasts: Toast[];
  pushToast: (tone: Toast['tone'], message: string) => void;
  dismissToast: (id: number) => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

/* --------------------------- local persistence ---------------------------- */

function readStored(): DemoState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemoState;
    if (parsed?.meta?.seedVersion !== SEED_VERSION) return null;
    return parsed;
  } catch {
    // Private browsing, blocked site data, or a corrupt entry: start fresh.
    return null;
  }
}

function writeStored(state: DemoState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable. The demo still works for this page view; it
    // just will not survive a refresh. Not worth interrupting the user over.
  }
}

function clearStored(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/* -------------------------------- provider -------------------------------- */

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DemoState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  /** Keeps the newest state available to callbacks without re-creating them. */
  const stateRef = useRef<DemoState | null>(null);
  const commit = useCallback((next: DemoState) => {
    stateRef.current = next;
    setState(next);
    writeStored(next);
  }, []);

  const pushToast = useCallback((tone: Toast['tone'], message: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((t) => [...t, { id, tone, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 8000 : 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  /** Fetches a brand-new seeded document from the server. */
  const seedFromServer = useCallback(async (): Promise<DemoState> => {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not load the demo dataset (${res.status}).`);
    const data = (await res.json()) as { state: DemoState };
    return data.state;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const stored = readStored();
      if (stored) {
        stateRef.current = stored;
        setState(stored);
        setError(null);
        return;
      }
      const fresh = await seedFromServer();
      commit(fresh);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the demo state.');
    } finally {
      setLoading(false);
    }
  }, [commit, seedFromServer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const dispatch = useCallback<DemoContextValue['dispatch']>(
    async (action) => {
      const current = stateRef.current;
      if (!current) {
        const message = 'The demo is still loading.';
        pushToast('error', message);
        return { ok: false, message };
      }

      setBusy(true);
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: current, action }),
        });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
          const message = data.error ?? `Request failed (${res.status}).`;
          pushToast('error', message);
          return { ok: false, message };
        }
        commit(data.state as DemoState);
        pushToast('ok', data.message);
        return {
          ok: true,
          message: data.message as string,
          navigateTo: data.navigateTo as string | undefined,
          created: data.created as Record<string, string> | undefined,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Unexpected error.';
        pushToast('error', message);
        return { ok: false, message };
      } finally {
        setBusy(false);
      }
    },
    [commit, pushToast],
  );

  const reset = useCallback(async () => {
    setBusy(true);
    try {
      clearStored();
      const res = await fetch('/api/reset', { method: 'POST' });
      const data = await res.json();
      commit(data.state as DemoState);
      pushToast('ok', data.message ?? 'Demo reset.');
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : 'Reset failed.');
    } finally {
      setBusy(false);
    }
  }, [commit, pushToast]);

  const value = useMemo(
    () => ({ state, loading, busy, error, dispatch, reset, refresh, toasts, pushToast, dismissToast }),
    [state, loading, busy, error, dispatch, reset, refresh, toasts, pushToast, dismissToast],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoContextValue {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error('useDemo must be used inside <DemoProvider>.');
  return ctx;
}

/** Convenience hook for pages that cannot render without state. */
export function useDemoState(): DemoState | null {
  return useDemo().state;
}
