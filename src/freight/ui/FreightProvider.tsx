'use client';

/**
 * Client state for the freight workspace.
 *
 * The server owns the data. This holds one snapshot, refreshes it after every
 * mutation, and surfaces errors as toasts written in the same operational
 * language as the rest of the screen. There is no optimistic update: an
 * approval or a send must never *look* like it happened when it did not.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Company, InboundMessage, RankingCriteria, FxRate, User } from '@/freight/types';
import type { Overview, IntegrationStatus } from '@/freight/view';

export interface ProviderRow {
  linkId: string;
  providerId: string;
  name: string;
  kind: string;
  country: string;
  generalEmail: string | null;
  status: 'active' | 'contracted' | 'excluded' | 'prospect';
  statusLabel: string;
  restrictionReason: string | null;
  accountRef: string | null;
  lanes: { originPort: string; destinationPort: string }[];
  notes: string | null;
  contacts: { id: string; name: string; email: string; role: string | null; isPrimary: boolean }[];
}

export interface FreightState {
  seeded: boolean;
  /** demo: the "Acting as" picker. entra: Sign in with Microsoft. */
  auth?: { mode: 'demo' | 'entra'; signedIn: boolean; problems: string[] };
  user: User | null;
  users: User[];
  companies: Company[];
  companyId: string | null;
  overview: Overview | null;
  providers: ProviderRow[];
  inbox: InboundMessage[];
  integrations: IntegrationStatus | null;
  settings: {
    criteria: RankingCriteria | null;
    fxRates: FxRate[];
    remindersAfterDays: number;
    remindersMaxRounds: number;
  } | null;
}

export interface Toast {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  message: string;
}

interface FreightContextValue {
  state: FreightState | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  companyId: string | null;
  setCompanyId: (id: string | null) => void;
  refresh: () => Promise<void>;
  /** Runs a mutation. Returns the result, or null when it failed. */
  run: <T = unknown>(action: Record<string, unknown>) => Promise<{ message: string; data: T } | null>;
  switchUser: (userId: string) => Promise<void>;
  loadDemo: () => Promise<void>;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  notify: (tone: Toast['tone'], message: string) => void;
}

const FreightContext = createContext<FreightContextValue | null>(null);

export function useFreight(): FreightContextValue {
  const ctx = useContext(FreightContext);
  if (!ctx) throw new Error('useFreight must be used inside FreightProvider');
  return ctx;
}

const COMPANY_KEY = 'freight.companyId';

export function FreightProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<FreightState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyIdRaw] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  // Guards against a slow response overwriting a newer one.
  const requestSeq = useRef(0);

  const notify = useCallback((tone: Toast['tone'], message: string) => {
    const id = (toastId.current += 1);
    // Confirming several quotes in a row should not bury the screen in toasts.
    setToasts((t) => [...t, { id, tone, message }].slice(-3));
    // Errors stay until dismissed; they usually need reading.
    if (tone !== 'bad') {
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const load = useCallback(
    async (company: string | null) => {
      const seq = (requestSeq.current += 1);
      try {
        const url = company ? `/api/freight/state?companyId=${encodeURIComponent(company)}` : '/api/freight/state';
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`The workspace could not be loaded (${res.status}).`);
        const data = (await res.json()) as FreightState;
        if (seq !== requestSeq.current) return;
        setState(data);
        setError(null);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : 'The workspace could not be loaded.');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [],
  );

  // Restore the last company before the first fetch, so the picker does not flicker.
  useEffect(() => {
    let initial: string | null = null;
    try {
      initial = window.localStorage.getItem(COMPANY_KEY);
    } catch {
      initial = null;
    }
    setCompanyIdRaw(initial);
    void load(initial);
  }, [load]);

  const setCompanyId = useCallback(
    (id: string | null) => {
      setCompanyIdRaw(id);
      try {
        if (id) window.localStorage.setItem(COMPANY_KEY, id);
        else window.localStorage.removeItem(COMPANY_KEY);
      } catch {
        // A blocked localStorage is not a reason to fail the switch.
      }
      void load(id);
    },
    [load],
  );

  const refresh = useCallback(async () => {
    await load(companyId);
  }, [companyId, load]);

  const run = useCallback(
    async <T,>(action: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await fetch('/api/freight/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action),
        });
        const payload = (await res.json()) as { ok?: boolean; message?: string; error?: string; data?: T };
        if (!res.ok || !payload.ok) {
          notify('bad', payload.error ?? 'That did not work.');
          return null;
        }
        if (payload.message) notify('ok', payload.message);
        await load(companyId);
        return { message: payload.message ?? '', data: payload.data as T };
      } catch (err) {
        notify('bad', err instanceof Error ? err.message : 'The server could not be reached.');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [companyId, load, notify],
  );

  const switchUser = useCallback(
    async (userId: string) => {
      setBusy(true);
      try {
        const res = await fetch('/api/freight/state', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId }),
        });
        const payload = (await res.json()) as { ok?: boolean; message?: string; error?: string };
        if (!res.ok || !payload.ok) {
          notify('bad', payload.error ?? 'That person could not be selected.');
          return;
        }
        notify('info', payload.message ?? 'Switched.');
        // The new person may not have access to the selected company.
        await load(null);
        setCompanyIdRaw(null);
        try {
          window.localStorage.removeItem(COMPANY_KEY);
        } catch {
          /* ignore */
        }
      } finally {
        setBusy(false);
      }
    },
    [load, notify],
  );

  const loadDemo = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/freight/demo', { method: 'POST' });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !payload.ok) {
        notify('bad', payload.error ?? 'The demonstration dataset could not be loaded.');
        return;
      }
      notify('ok', 'Loaded the demonstration dataset.');
      setCompanyIdRaw(null);
      await load(null);
    } finally {
      setBusy(false);
    }
  }, [load, notify]);

  const value = useMemo<FreightContextValue>(
    () => ({
      state,
      loading,
      busy,
      error,
      companyId,
      setCompanyId,
      refresh,
      run,
      switchUser,
      loadDemo,
      toasts,
      dismissToast,
      notify,
    }),
    [state, loading, busy, error, companyId, setCompanyId, refresh, run, switchUser, loadDemo, toasts, dismissToast, notify],
  );

  return <FreightContext.Provider value={value}>{children}</FreightContext.Provider>;
}
