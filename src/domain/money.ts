/**
 * Centralised currency + number handling.
 *
 * DEMO ASSUMPTION: the entire dataset is denominated in EGP (Egyptian pound).
 * There is no multi-currency conversion engine in this demo; supplier documents
 * are quoted in USD and carry an explicit, fixed demo FX rate recorded on the
 * document itself.
 */

export const DEMO_CURRENCY = 'EGP' as const;

/** Fixed demo FX rate used only where a supplier document is quoted in USD. */
export const DEMO_USD_EGP = 48.5;

/** Round to 2dp using half-up, avoiding binary float drift on .005 boundaries. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round0(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n + Number.EPSILON);
}

/** Money formatter. `EGP 1,234,567` or `EGP 1,234.56` when piastres matter. */
export function formatEGP(n: number, opts: { cents?: boolean; compact?: boolean } = {}): string {
  const v = opts.cents ? round2(n) : round0(n);
  if (opts.compact && Math.abs(v) >= 1_000_000) {
    return `EGP ${(v / 1_000_000).toFixed(2)}M`;
  }
  if (opts.compact && Math.abs(v) >= 10_000) {
    return `EGP ${(v / 1_000).toFixed(0)}K`;
  }
  return `EGP ${v.toLocaleString('en-EG', {
    minimumFractionDigits: opts.cents ? 2 : 0,
    maximumFractionDigits: opts.cents ? 2 : 0,
  })}`;
}

/** Supplier documents are quoted in USD; only ever shown next to the EGP value. */
export function formatUSD(n: number, cents = true): string {
  return `USD ${round2(n).toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

export function usdToEgp(usd: number, rate: number = DEMO_USD_EGP): number {
  return round2(usd * rate);
}

export function formatQty(n: number, unit = 'pcs'): string {
  return `${round0(n).toLocaleString('en-EG')} ${unit}`;
}

export function formatNumber(n: number, dp = 0): string {
  return n.toLocaleString('en-EG', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function formatPercent(fraction: number, dp = 1): string {
  return `${(fraction * 100).toFixed(dp)}%`;
}

/** Percentage points difference, e.g. margin delta. */
export function pctPoints(a: number, b: number, dp = 1): string {
  const d = (a - b) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(dp)} pp`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatDateShort(iso: string): string {
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) +
    ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
  );
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso.length === 10 ? fromIso + 'T00:00:00Z' : fromIso);
  const b = Date.parse(toIso.length === 10 ? toIso + 'T00:00:00Z' : toIso);
  return Math.round((b - a) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
