'use client';

/**
 * Checking an extracted quotation against its source.
 *
 * The original text sits beside the fields so a reviewer can confirm a figure
 * without leaving the screen or opening the attachment. Every field shows where
 * it was read from and how confident the parser was, and a missing value says
 * "not stated" rather than showing a zero.
 */

import React from 'react';
import { Card, CardHead, Notice, Pill } from '@/components/ui';
import { useFreight } from './FreightProvider';
import { ConfidenceMark, QuoteStatusPill, SourceRef, formatWhen } from './bits';
import type { QuoteView } from '@/freight/view';
import type { ChargeBasis, Extracted, Quote } from '@/freight/types';
import { CHARGE_BASIS_LABEL, EXTRACTED_FIELD_LABEL, EXTRACTED_SCALAR_KEYS } from '@/freight/types';

const NUMERIC = new Set(['baseFreight', 'totalQuoted', 'transitDays', 'freeDaysDestination']);
const DATE = new Set(['validUntil', 'sailingDate']);

export function QuoteReview({ view, onChanged }: { view: QuoteView; onChanged: () => void }) {
  const { run, busy } = useFreight();
  const q = view.quote;

  const [values, setValues] = React.useState<Record<string, string>>({});
  const [surcharges, setSurcharges] = React.useState(q.surcharges);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    const initial: Record<string, string> = {};
    for (const key of EXTRACTED_SCALAR_KEYS) {
      const field = q[key] as Extracted<unknown>;
      initial[key] = field.value === null || field.value === undefined ? '' : String(field.value);
    }
    setValues(initial);
    setSurcharges(q.surcharges);
    setDirty(false);
  }, [q]);

  const edit = (key: string, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setDirty(true);
  };

  const editSurcharge = (code: string, patch: Partial<(typeof surcharges)[number]>) => {
    setSurcharges((s) => s.map((x) => (x.code === code ? { ...x, ...patch } : x)));
    setDirty(true);
  };

  function changedFields() {
    const out: { field: string; value: string | number | null }[] = [];
    for (const key of EXTRACTED_SCALAR_KEYS) {
      const field = q[key] as Extracted<unknown>;
      const original = field.value === null || field.value === undefined ? '' : String(field.value);
      const next = values[key] ?? '';
      if (next === original) continue;
      out.push({
        field: key,
        value: next.trim() === '' ? null : NUMERIC.has(key) ? Number(next) : next.trim(),
      });
    }
    return out;
  }

  async function save(confirm: boolean) {
    const result = await run({
      type: 'quote.review',
      quoteId: q.id,
      fields: changedFields(),
      surcharges: surcharges.map((s) => ({
        code: s.code,
        label: s.label,
        amount: s.amount,
        currency: s.currency,
        basis: s.basis,
      })),
      confirm,
    });
    if (result) {
      setDirty(false);
      onChanged();
    }
  }

  return (
    <div className="stack">
      {q.status === 'unreadable' ? (
        <Notice tone="bad" title="This quotation could not be read. ">
          {q.unreadableReason} Nothing has been guessed. Enter the figures below from the original, or
          leave it flagged and it stays out of the comparison.
        </Notice>
      ) : null}

      {view.history.length > 1 ? (
        <Notice tone="info" title="This provider has sent more than one quotation. ">
          You are looking at version {q.version}. Earlier versions are kept and are listed below the
          fields.
        </Notice>
      ) : null}

      <div className="side-by-side">
        <Card className="flush">
          <CardHead
            title={`${view.providerName} — version ${q.version}`}
            hint={
              q.reviewedAt
                ? `Checked ${formatWhen(q.reviewedAt)}.`
                : 'Confirm each figure against the source on the right. Correct anything that is wrong.'
            }
            right={<QuoteStatusPill status={q.status} />}
          />
          <div className="card-body">
            <div className="prov">
              {EXTRACTED_SCALAR_KEYS.map((key) => {
                const field = q[key] as Extracted<unknown>;
                const attention = field.value === null || field.confidence === 'low' || field.confidence === 'medium';
                return (
                  <div className="prov-row" key={key} data-attention={attention}>
                    <div>
                      <div className="label">{EXTRACTED_FIELD_LABEL[key]}</div>
                      <ConfidenceMark confidence={field.confidence} />
                    </div>
                    <div>
                      <input
                        className="input"
                        type={NUMERIC.has(key) ? 'number' : DATE.has(key) ? 'date' : 'text'}
                        step="any"
                        value={values[key] ?? ''}
                        placeholder="not stated"
                        aria-label={EXTRACTED_FIELD_LABEL[key]}
                        onChange={(e) => edit(key, e.target.value)}
                      />
                    </div>
                    <SourceRef field={field} />
                  </div>
                );
              })}
            </div>

            <h3 style={{ fontSize: 13, marginTop: 18, marginBottom: 8 }}>Surcharges</h3>
            {surcharges.length === 0 ? (
              <p className="small muted">
                No surcharges were found in this quotation. If the provider listed any, add the amounts
                after checking the original.
              </p>
            ) : (
              <div className="prov">
                {surcharges.map((s) => (
                  <div className="prov-row" key={s.code} data-attention={s.amount === null}>
                    <div>
                      <div className="label">{s.label}</div>
                      <ConfidenceMark confidence={s.amount === null ? 'missing' : s.confidence} />
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <input
                        className="input"
                        type="number"
                        step="any"
                        style={{ width: 110 }}
                        value={s.amount ?? ''}
                        placeholder="not stated"
                        aria-label={`${s.label} amount`}
                        onChange={(e) =>
                          editSurcharge(s.code, {
                            amount: e.target.value.trim() === '' ? null : Number(e.target.value),
                          })
                        }
                      />
                      <select
                        className="input"
                        style={{ width: 130 }}
                        value={s.basis}
                        aria-label={`${s.label} basis`}
                        onChange={(e) => editSurcharge(s.code, { basis: e.target.value as ChargeBasis })}
                      >
                        {(Object.keys(CHARGE_BASIS_LABEL) as ChargeBasis[]).map((b) => (
                          <option key={b} value={b}>
                            {CHARGE_BASIS_LABEL[b]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <span className="src">
                        {s.sourceRef ? <code>{s.sourceRef}</code> : 'entered during review'}
                      </span>
                      {s.amount === null ? (
                        <div className="src" style={{ color: '#a3352f' }}>
                          Left blank, this offer cannot be compared. It is never counted as zero.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <ListFacts quote={q} />

            <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={busy} onClick={() => void save(true)}>
                {q.status === 'confirmed' ? 'Save and keep checked' : 'Confirm these figures'}
              </button>
              <button className="btn" disabled={busy || !dirty} onClick={() => void save(false)}>
                Save without confirming
              </button>
              {q.status !== 'declined' ? (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => void run({ type: 'quote.markDeclined', quoteId: q.id }).then(onChanged)}
                >
                  Record as declined
                </button>
              ) : null}
            </div>
            <p className="fr-foot-note">
              Confirming means the figures match the source. Corrections are kept with your name against
              them and flow straight into the comparison.
            </p>

            {view.history.length > 1 ? (
              <div style={{ marginTop: 14 }}>
                <h3 style={{ fontSize: 13, marginBottom: 6 }}>Version history</h3>
                {view.history.map((h) => (
                  <div key={h.id} className="row" style={{ gap: 8, fontSize: 12.5, padding: '3px 0' }}>
                    <Pill tone={h.id === q.id ? 'info' : 'neutral'}>v{h.version}</Pill>
                    <span className="muted">{formatWhen(h.createdAt)}</span>
                    <span className="muted">
                      {h.id === q.id ? 'current' : h.status === 'superseded' ? 'superseded, kept on record' : h.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </Card>

        <Card className="flush">
          <CardHead
            title="The original"
            hint={
              q.sourceAttachment
                ? `Read from ${q.sourceAttachment}.`
                : 'Read from the body of the provider’s email.'
            }
            right={
              view.message?.attachments.length ? (
                <a
                  className="btn sm"
                  href={`/api/freight/file/${encodeURIComponent(view.message.attachments[0].storageKey)}`}
                >
                  Download
                </a>
              ) : null
            }
          />
          <div className="card-body">
            {view.message ? (
              <>
                <div className="mail-field" style={{ marginBottom: 4 }}>
                  <span className="k">From</span>
                  <span>{view.message.fromEmail}</span>
                </div>
                <div className="mail-field" style={{ marginBottom: 4 }}>
                  <span className="k">Subject</span>
                  <span>{view.message.subject}</span>
                </div>
                <div className="mail-field" style={{ marginBottom: 10 }}>
                  <span className="k">Matched</span>
                  <span className="small muted">{view.message.matchBasis}</span>
                </div>
                <pre className="source-text">{view.message.bodyText}</pre>
              </>
            ) : (
              <p className="small muted">
                This quotation was entered by hand, so there is no original message to show.
              </p>
            )}
            <p className="fr-foot-note">
              Extracted with <code>{q.extractorId}</code> on {formatWhen(q.extractedAt)}.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ListFacts({ quote }: { quote: Quote }) {
  const lists: { label: string; field: Extracted<string[]> }[] = [
    { label: 'Included', field: quote.inclusions },
    { label: 'Excluded', field: quote.exclusions },
    { label: 'Conditions', field: quote.conditions },
  ];
  return (
    <div style={{ marginTop: 16 }}>
      {lists.map((l) => (
        <div key={l.label} className="row" style={{ gap: 10, alignItems: 'baseline', padding: '4px 0', fontSize: 13 }}>
          <span className="muted" style={{ minWidth: 90 }}>
            {l.label}
          </span>
          <span>
            {l.field.value && l.field.value.length > 0 ? (
              l.field.value.join(', ')
            ) : (
              <span className="muted">not stated</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
