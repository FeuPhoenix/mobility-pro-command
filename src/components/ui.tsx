'use client';

import React from 'react';
import Link from 'next/link';
import { formatEGP } from '@/domain/money';
import type { MeasureKind, RecordRef } from '@/domain/types';

/* ------------------------------- Primitives -------------------------------- */

export function Card({
  children,
  className = '',
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardHead({
  title,
  hint,
  right,
  eyebrow,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="card-head">
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <div className="eyebrow" style={{ marginBottom: 3 }}>{eyebrow}</div> : null}
        <h2>{title}</h2>
        {hint ? <div className="hint" style={{ marginTop: 3 }}>{hint}</div> : null}
      </div>
      <div className="spacer" />
      {right}
    </div>
  );
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export function Pill({ tone = 'neutral', children, dot }: { tone?: Tone; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={`pill ${tone}`}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'bad' | 'good' | 'info';
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`notice ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <div>
        {title ? <b>{title}</b> : null}
        {children}
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: string | number; style?: React.CSSProperties }) {
  return <div className="skel" style={{ height: h, width: w, ...style }} />;
}

export function PageLoading({ label = 'Loading the workspace' }: { label?: string }) {
  return (
    <div className="page">
      <div className="stack" aria-busy="true" aria-label={label}>
        <Skeleton h={168} style={{ borderRadius: 14 }} />
        <div className="grid g-main">
          <Card>
            <div className="card-body stack">
              <Skeleton h={18} w="42%" />
              <Skeleton h={62} />
              <Skeleton h={62} />
              <Skeleton h={62} />
            </div>
          </Card>
          <Card>
            <div className="card-body stack">
              <Skeleton h={18} w="55%" />
              <Skeleton h={120} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Fields ---------------------------------- */

/**
 * Associates the label with its control so screen readers (and keyboard users
 * clicking the label) behave correctly. The generated id is injected into the
 * first native form control among the children that does not already have one.
 */
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = React.useId();
  let assigned = false;
  const kids = React.Children.map(children, (child) => {
    if (
      !assigned &&
      React.isValidElement(child) &&
      typeof child.type === 'string' &&
      ['input', 'select', 'textarea'].includes(child.type) &&
      !(child.props as { id?: string }).id
    ) {
      assigned = true;
      return React.cloneElement(child as React.ReactElement<{ id?: string }>, { id });
    }
    return child;
  });

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {kids}
      {help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-on={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- Measure --------------------------------- */

export const MEASURE_TITLES: Record<MeasureKind, string> = {
  inventory_carrying_value: 'Inventory carrying value',
  potential_sales_value: 'Potential sales value',
  gross_profit: 'Gross profit',
  receivables_at_risk: 'Receivables at risk',
  purchase_value_exposed: 'Purchase value exposed',
};

export function MeasureRow({
  label,
  amount,
  note,
}: {
  label: string;
  amount: number;
  note: string;
}) {
  return (
    <div className="measure">
      <div className="m-label">{label}</div>
      <div className="m-value">{formatEGP(amount)}</div>
      <div className="m-note">{note}</div>
    </div>
  );
}

/* ---------------------------------- Refs ----------------------------------- */

export function refHref(ref: RecordRef): string {
  switch (ref.type) {
    case 'document':
      return `/operations/documents/${ref.id}`;
    case 'case':
      return `/operations/documents?case=${ref.id}`;
    case 'shipment':
      return `/operations/documents?shipment=${ref.id}`;
    case 'purchaseOrder':
      return `/operations/documents?po=${ref.id}`;
    case 'opportunity':
      return `/operations/inventory/${ref.id}`;
    case 'sku':
      return `/operations/inventory?sku=${ref.id}`;
    case 'salesOrder':
      return `/operations/orders/${ref.id}`;
    case 'customer':
      return `/customers/${ref.id}`;
    case 'approval':
      return `/approvals?focus=${ref.id}`;
    default:
      return '/';
  }
}

export function RefChip({ refItem }: { refItem: RecordRef }) {
  return (
    <Link className="ref-chip" href={refHref(refItem)}>
      {refItem.label}
    </Link>
  );
}

/* --------------------------------- Modal ----------------------------------- */

export function Modal({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2 style={{ fontSize: 16 }}>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </>
  );
}

/* ---------------------------------- Icons ---------------------------------- */

type IconName =
  | 'overview'
  | 'documents'
  | 'inventory'
  | 'orders'
  | 'customers'
  | 'approvals'
  | 'automations'
  | 'assistant'
  | 'reset'
  | 'play'
  | 'menu'
  | 'close'
  | 'check'
  | 'alert'
  | 'arrow';

const PATHS: Record<IconName, React.ReactNode> = {
  overview: <path d="M3 10.5 10 4l7 6.5M5 9.5V16h10V9.5" />,
  documents: <path d="M5 3h6l4 4v10H5zM11 3v4h4" />,
  inventory: <path d="M3 7l7-4 7 4v6l-7 4-7-4zM3 7l7 4 7-4M10 11v6" />,
  orders: <path d="M4 5h12M4 10h12M4 15h7" />,
  customers: <path d="M7 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2.5 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M13 7.5a2 2 0 1 0 0-4M14 16c0-2 .5-3 1.5-3.6" />,
  approvals: <path d="M4 10.5 8 14l8-8" />,
  automations: (
    <>
      <path d="M4 6h3.5a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2H16" />
      <circle cx="3" cy="6" r="1.6" />
      <circle cx="17" cy="14" r="1.6" />
      <path d="M12.5 4.5 15 7l-2.5 2.5" />
    </>
  ),
  assistant: <path d="M4 4h12v8H8l-4 3z" />,
  reset: <path d="M16 10a6 6 0 1 1-1.8-4.3M16 3v3h-3" />,
  play: <path d="M6 4l9 6-9 6z" />,
  menu: <path d="M3 5h14M3 10h14M3 15h14" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  check: <path d="M4 10.5 8 14l8-8" />,
  alert: <path d="M10 3 2.5 16h15zM10 8v4M10 14.2v.1" />,
  arrow: <path d="M4 10h11M11 6l4 4-4 4" />,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
