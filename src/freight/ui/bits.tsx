'use client';

/** Small shared pieces used across the freight screens. */

import React from 'react';
import type { Confidence, EmailStatus, Extracted, QuoteStatus, RfqStatus, SyncStatus } from '@/freight/types';
import { EMAIL_STATUS_LABEL, QUOTE_STATUS_LABEL, RFQ_STATUS_LABEL, SYNC_STATUS_LABEL } from '@/freight/types';
import { Pill, type Tone } from '@/components/ui';

export function formatMoney(n: number | null, currency: string | null): string {
  if (n === null) return 'not available';
  return `${currency ?? ''} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`.trim();
}

export function formatDay(iso: string | null): string {
  if (!iso) return 'not stated';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })} ${d.toLocaleTimeString(
    'en-GB',
    { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' },
  )}`;
}

/** "in 3 days", "4 hours ago" - the deadline needs to read at a glance. */
export function relativeHours(hours: number): string {
  const abs = Math.abs(hours);
  const unit = abs >= 48 ? `${Math.round(abs / 24)} days` : abs >= 1 ? `${Math.round(abs)} hours` : 'less than an hour';
  return hours >= 0 ? `in ${unit}` : `${unit} ago`;
}

const RFQ_TONE: Record<RfqStatus, Tone> = {
  draft: 'neutral',
  awaiting_approval: 'warn',
  sent: 'info',
  collecting: 'info',
  closed: 'neutral',
  comparison_ready: 'good',
  completed: 'good',
  cancelled: 'neutral',
};

export function RfqStatusPill({ status }: { status: RfqStatus }) {
  return <Pill tone={RFQ_TONE[status]}>{RFQ_STATUS_LABEL[status]}</Pill>;
}

const EMAIL_TONE: Record<EmailStatus, Tone> = {
  draft: 'neutral',
  awaiting_approval: 'warn',
  approved: 'info',
  sent: 'good',
  failed: 'bad',
  approval_stale: 'bad',
};

export function EmailStatusPill({ status, simulated }: { status: EmailStatus; simulated?: boolean }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <Pill tone={EMAIL_TONE[status]}>{EMAIL_STATUS_LABEL[status]}</Pill>
      {status === 'sent' && simulated ? <span className="sim-chip">Simulated</span> : null}
    </span>
  );
}

const QUOTE_TONE: Record<QuoteStatus, Tone> = {
  needs_review: 'warn',
  confirmed: 'good',
  superseded: 'neutral',
  unreadable: 'bad',
  declined: 'neutral',
};

export function QuoteStatusPill({ status }: { status: QuoteStatus }) {
  return <Pill tone={QUOTE_TONE[status]}>{QUOTE_STATUS_LABEL[status]}</Pill>;
}

const SYNC_TONE: Record<SyncStatus, Tone> = {
  pending: 'neutral',
  success: 'good',
  failed: 'bad',
  blocked: 'warn',
};

export function SyncStatusPill({ status, simulated }: { status: SyncStatus; simulated: boolean }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <Pill tone={SYNC_TONE[status]}>{SYNC_STATUS_LABEL[status]}</Pill>
      {status === 'success' && simulated ? <span className="sim-chip">Simulated, not in ERPNext</span> : null}
    </span>
  );
}

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'Read directly',
  medium: 'Inferred',
  low: 'Uncertain',
  missing: 'Not stated',
};

export function ConfidenceMark({ confidence }: { confidence: Confidence }) {
  return (
    <span className="conf" data-c={confidence} title={CONFIDENCE_LABEL[confidence]}>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

/** Renders an extracted value honestly: a missing one says so in words. */
export function ExtractedValue({
  field,
  format,
}: {
  field: Extracted<unknown>;
  format?: (v: unknown) => string;
}) {
  if (field.value === null || field.value === undefined || (Array.isArray(field.value) && field.value.length === 0)) {
    return <span className="missing">not stated</span>;
  }
  const text = format ? format(field.value) : Array.isArray(field.value) ? field.value.join(', ') : String(field.value);
  return <span>{text}</span>;
}

export function SourceRef({ field }: { field: Extracted<unknown> }) {
  if (field.correctedBy) {
    return <span className="src">Corrected by a reviewer{field.sourceRef ? <> · originally <code>{field.sourceRef}</code></> : null}</span>;
  }
  if (!field.sourceRef) {
    return <span className="src">{field.note ?? 'No source recorded.'}</span>;
  }
  return (
    <span className="src">
      <code>{field.sourceRef}</code>
      {field.sourceText ? <> · &ldquo;{truncate(field.sourceText, 90)}&rdquo;</> : null}
      {field.note ? <> · {field.note}</> : null}
    </span>
  );
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** A labelled block of key/value facts. */
export function Facts({ items }: { items: { k: string; v: React.ReactNode }[] }) {
  return (
    <div className="kv-grid">
      {items.map((i) => (
        <div key={i.k}>
          <div className="k">{i.k}</div>
          <div className="v">{i.v}</div>
        </div>
      ))}
    </div>
  );
}

/** A confirm-before-acting button, for anything with an outward-facing effect. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = 'btn',
  disabled,
  title,
}: {
  label: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);

  if (!armed) {
    return (
      <button className={className} disabled={disabled} title={title} onClick={() => setArmed(true)}>
        {label}
      </button>
    );
  }
  return (
    <button
      className={`${className} primary`}
      disabled={disabled}
      onClick={async () => {
        setArmed(false);
        await onConfirm();
      }}
    >
      {confirmLabel}
    </button>
  );
}
