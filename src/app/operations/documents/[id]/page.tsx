'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { Card, CardHead, Empty, Icon, Modal, Notice, PageLoading, Pill } from '@/components/ui';
import { documentTotals, receivingReadiness } from '@/domain/documentRules';
import { byId } from '@/domain/selectors';
import { formatDate, formatEGP, formatUSD } from '@/domain/money';
import type { Discrepancy, DocPage, SupplierDocument } from '@/domain/types';

export default function DocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { state, dispatch, busy } = useDemo();
  const docId = decodeURIComponent(params.id);

  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [focusAnchor, setFocusAnchor] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; label: string; value: string } | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const facsimileRef = useRef<HTMLDivElement>(null);

  const doc = state ? byId(state.documents, docId) : undefined;
  const po = state && doc ? byId(state.purchaseOrders, doc.purchaseOrderId) : undefined;
  const shipment = state && doc?.shipmentId ? byId(state.shipments, doc.shipmentId) : undefined;
  const supplier = state && doc ? byId(state.suppliers, doc.supplierId) : undefined;

  const siblingDocs = useMemo(
    () => (state && doc ? state.documents.filter((d) => d.purchaseOrderId === doc.purchaseOrderId) : []),
    [state, doc],
  );
  const viewedDoc: SupplierDocument | undefined =
    (activeDocId ? siblingDocs.find((d) => d.id === activeDocId) : undefined) ?? doc;

  const discrepancies = useMemo(
    () => (state && doc ? state.discrepancies.filter((d) => d.id.startsWith(`DSC-${doc.id}-`)) : []),
    [state, doc],
  );

  // A case moves onto the revised document when one arrives, so a document is
  // "the case's document" if it IS the current one, the superseded original, or
  // the revision that replaced it.
  const theCase =
    state && doc
      ? state.cases.find(
          (c) =>
            c.documentId === doc.id ||
            c.correctedDocumentId === doc.id ||
            state.documents.find((d) => d.id === c.documentId)?.supersedesId === doc.id,
        )
      : undefined;
  const readiness = state && shipment ? receivingReadiness(state, shipment.id) : null;
  const totals = doc && po ? documentTotals(doc, po) : null;

  useEffect(() => {
    if (theCase?.draft) {
      setDraftSubject(theCase.draft.subject);
      setDraftBody(theCase.draft.body);
    }
  }, [theCase?.draft?.subject, theCase?.draft?.body]);

  useEffect(() => {
    if (!focusAnchor) return;
    const el = facsimileRef.current?.querySelector(`[data-anchor="${focusAnchor}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = window.setTimeout(() => setFocusAnchor(null), 1600);
    return () => window.clearTimeout(t);
  }, [focusAnchor]);

  if (!state) return <PageLoading />;
  if (!doc || !po) {
    return (
      <div className="page">
        <Card>
          <Empty title="Document not found">
            The reference in the address bar does not match a document in this demo session. It may
            have been superseded by a revision, or the demo may have been reset.{' '}
            <Link href="/operations/documents">Back to document control</Link>.
          </Empty>
        </Card>
      </div>
    );
  }

  const blocking = discrepancies.filter((d) => d.severity === 'blocking' && !d.resolved);
  const advisory = discrepancies.filter((d) => d.severity === 'advisory' && !d.resolved);
  const anchorsWithIssues = new Map<string, 'blocking' | 'advisory'>();
  for (const d of discrepancies) {
    if (d.resolved) continue;
    const existing = anchorsWithIssues.get(d.anchor);
    if (existing !== 'blocking') anchorsWithIssues.set(d.anchor, d.severity);
  }

  const supersededBy = state.documents.find((d) => d.supersedesId === doc.id);
  const actingUser = byId(state.users, state.meta.currentUserId);
  const canOverride = actingUser?.role === 'procurement';

  return (
    <div className="page">
      <div className="page-head">
        <div className="row" style={{ gap: 9, marginBottom: 6 }}>
          <Link className="btn ghost sm" href="/operations/documents">
            ← Document control
          </Link>
          <Pill tone="info">{doc.kind}</Pill>
          {doc.revision > 1 ? <Pill tone="neutral">Revision {doc.revision}</Pill> : null}
          <Pill tone="warn">Extraction simulated</Pill>
        </div>
        <h1>
          {doc.reference} <span className="muted" style={{ fontWeight: 400 }}>vs</span> {po.id}
        </h1>
        <p className="sub">
          {supplier?.name}, {supplier?.country}. Issued {formatDate(doc.issuedOn)}, received{' '}
          {formatDate(doc.receivedOn)}. Compared against the purchase order line by line under the
          import document control SOP v1.9.
        </p>
      </div>

      {supersededBy ? (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="info" title="This revision has been superseded">
            {supersededBy.reference} is the current document on this case.{' '}
            <Link href={`/operations/documents/${supersededBy.id}`}>Open the current revision</Link>.
          </Notice>
        </div>
      ) : null}

      {readiness ? (
        <div style={{ marginBottom: 16 }}>
          <Notice
            tone={
              readiness.state === 'Ready for receiving'
                ? 'good'
                : readiness.state === 'Held - document control'
                  ? 'bad'
                  : 'info'
            }
            title={`${shipment?.id} — ${readiness.state}`}
          >
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {readiness.reasons.map((r, i) => (
                <li key={i} style={{ marginBottom: 2 }}>
                  {r}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      <div className="grid g-doc">
        {/* ------------------------ Left: comparison ------------------------- */}
        <div className="stack">
          <Card className="flush">
            <CardHead
              title="Field comparison"
              hint="Extracted from the supplier document, set against the ordered value. Click a page reference to jump to it in the document."
              right={
                <div className="row" style={{ gap: 7 }}>
                  <Pill tone={blocking.length ? 'bad' : 'good'}>
                    {blocking.length} blocking
                  </Pill>
                  <Pill tone={advisory.length ? 'warn' : 'neutral'}>{advisory.length} advisory</Pill>
                </div>
              }
            />

            {discrepancies.length === 0 ? (
              <div style={{ padding: 18 }}>
                <Notice tone="good" title="This document matches the purchase order">
                  Every checked field — size, ply rating, pattern, quantity, unit price and payment
                  terms — agrees with {po.id}. No case is needed.
                </Notice>
              </div>
            ) : null}

            <ComparisonTable
              doc={doc}
              discrepancies={discrepancies}
              onJump={(anchor, docIdForAnchor) => {
                setActiveDocId(docIdForAnchor);
                setFocusAnchor(anchor);
              }}
              onEdit={(key, label, value) => setEditing({ key, label, value })}
              onConfirm={(key) => void dispatch({ type: 'document.confirmField', documentId: doc.id, key })}
              busy={busy}
            />

            <div className="card-body tight" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="tiny muted" style={{ maxWidth: '62ch' }}>
                  Extraction states record whether a person has read the value against the source.
                  Confirming does not change the comparison result. No confidence percentages are
                  shown because no real extraction ran.
                </div>
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void dispatch({ type: 'document.revalidate', documentId: doc.id })}
                >
                  <Icon name="reset" size={13} /> Re-check this document
                </button>
              </div>
            </div>
          </Card>

          {totals ? (
            <Card>
              <CardHead title="Totals" hint="Document total against ordered total, at the FX rate recorded on the document." />
              <div className="card-body">
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Measure</th>
                        <th className="r">Purchase order</th>
                        <th className="r">This document</th>
                        <th className="r">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Total quantity</td>
                        <td className="r">{totals.orderQty.toLocaleString('en-EG')} pcs</td>
                        <td className={`r ${totals.documentQty !== totals.orderQty ? 'cmp-val bad' : ''}`}>
                          {totals.documentQty.toLocaleString('en-EG')} pcs
                        </td>
                        <td className="r">
                          {totals.documentQty - totals.orderQty === 0
                            ? '—'
                            : `${totals.documentQty - totals.orderQty > 0 ? '+' : ''}${(totals.documentQty - totals.orderQty).toLocaleString('en-EG')} pcs`}
                        </td>
                      </tr>
                      <tr>
                        <td>Value in document currency</td>
                        <td className="r">{formatUSD(totals.orderValueUsd)}</td>
                        <td className={`r ${totals.varianceUsd !== 0 ? 'cmp-val bad' : ''}`}>
                          {formatUSD(totals.documentValueUsd)}
                        </td>
                        <td className="r">
                          {totals.varianceUsd === 0 ? '—' : `${totals.varianceUsd > 0 ? '+' : ''}${formatUSD(totals.varianceUsd)}`}
                        </td>
                      </tr>
                      <tr>
                        <td>
                          Value in EGP
                          <div className="tiny muted">at {po.fxRate.toFixed(2)} EGP/USD, fixed on the document</div>
                        </td>
                        <td className="r">{formatEGP(totals.orderValueEgp)}</td>
                        <td className={`r ${totals.varianceEgp !== 0 ? 'cmp-val bad' : ''}`}>
                          {formatEGP(totals.documentValueEgp)}
                        </td>
                        <td className="r">
                          {totals.varianceEgp === 0 ? '—' : `${totals.varianceEgp > 0 ? '+' : ''}${formatEGP(totals.varianceEgp)}`}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div className="tiny muted" style={{ marginTop: 10 }}>
                  This is the value of an open purchase commitment. It is not a payment, not a cost
                  incurred, and not a loss.
                </div>
              </div>
            </Card>
          ) : null}

          <CrossCheck state={state} doc={doc} />

          <CasePanel
            docId={doc.id}
            theCase={theCase}
            blockingCount={blocking.length}
            advisoryCount={advisory.length}
            draftSubject={draftSubject}
            draftBody={draftBody}
            setDraftSubject={setDraftSubject}
            setDraftBody={setDraftBody}
            onOverride={() => setOverrideOpen(true)}
            busy={busy}
            dispatch={dispatch}
            onNavigate={(id) => router.push(`/operations/documents/${id}`)}
          />
        </div>

        {/* ---------------------- Right: source document --------------------- */}
        <div className="stack">
          <Card className="flush">
            <CardHead
              title="Original document"
              hint="The sample document as received. Flagged lines are the ones that disagree with the order."
            />
            <div className="card-body tight" style={{ borderBottom: '1px solid var(--line)' }}>
              <div className="row" style={{ gap: 6 }}>
                {siblingDocs.map((d) => (
                  <button
                    key={d.id}
                    className="btn sm"
                    style={
                      d.id === viewedDoc?.id
                        ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)', color: 'var(--accent-ink)' }
                        : undefined
                    }
                    onClick={() => setActiveDocId(d.id)}
                  >
                    {d.kind === 'Pro forma invoice' ? 'PI' : d.kind === 'Packing list' ? 'Packing list' : 'BL'}{' '}
                    {d.revision > 1 ? `rev ${d.revision}` : ''}
                  </button>
                ))}
              </div>
              <div className="tiny muted" style={{ marginTop: 8 }}>
                Open sample documents: {siblingDocs.map((d) => d.reference).join(', ')}. These
                facsimiles always render — no upload or file parsing is involved.
              </div>
            </div>
            <div ref={facsimileRef} style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {viewedDoc?.pages.map((p) => (
                <Facsimile
                  key={p.page}
                  page={p}
                  flags={viewedDoc.id === doc.id ? anchorsWithIssues : new Map()}
                  focusAnchor={focusAnchor}
                />
              ))}
            </div>
          </Card>

          <Card>
            <CardHead title="Purchase order" hint={`${po.id}, ordered ${formatDate(po.orderedOn)}`} />
            <div className="card-body">
              <dl className="kv">
                <dt>Supplier</dt>
                <dd>{supplier?.name}</dd>
                <dt>Incoterm</dt>
                <dd>{po.incoterm}</dd>
                <dt>Payment terms</dt>
                <dd>{po.paymentTerms}</dd>
                <dt>Currency / FX</dt>
                <dd>
                  {po.currency} at {po.fxRate.toFixed(2)} EGP
                </dd>
                <dt>Status</dt>
                <dd>{po.status}</dd>
              </dl>
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="t">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Ordered specification</th>
                      <th className="r">Qty</th>
                      <th className="r">Unit USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.lines.map((l) => (
                      <tr key={l.lineNo}>
                        <td>{l.lineNo}</td>
                        <td>
                          <div className="primary-cell">
                            {l.size} {l.ply}
                          </div>
                          <div className="tiny muted">{l.pattern}</div>
                        </td>
                        <td className="r">{l.qty.toLocaleString('en-EG')}</td>
                        <td className="r">{l.unitPriceUsd.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Card>

          {shipment ? (
            <Card>
              <CardHead title="Shipment" hint={shipment.id} />
              <div className="card-body">
                <dl className="kv">
                  <dt>Vessel</dt>
                  <dd>{shipment.vessel}</dd>
                  <dt>Bill of lading</dt>
                  <dd className="mono">{shipment.blNumber}</dd>
                  <dt>ETD → ETA</dt>
                  <dd>
                    {formatDate(shipment.etd)} → {formatDate(shipment.eta)}
                  </dd>
                  <dt>Route</dt>
                  <dd>
                    {shipment.portOfLoading} → {shipment.portOfDischarge}
                  </dd>
                  <dt>Destination</dt>
                  <dd>{byId(state.warehouses, shipment.destinationWarehouseId)?.name}</dd>
                  <dt>Containers</dt>
                  <dd className="mono tiny">{shipment.containers.join(', ')}</dd>
                  <dt>Status</dt>
                  <dd>{shipment.status}</dd>
                </dl>
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      {/* ------------------------------- Modals ------------------------------ */}
      {editing ? (
        <Modal
          title={`Correct: ${editing.label}`}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  const r = await dispatch({
                    type: 'document.editField',
                    documentId: doc.id,
                    key: editing.key,
                    value: editing.value,
                  });
                  if (r.ok) setEditing(null);
                }}
              >
                Save and re-validate
              </button>
            </>
          }
        >
          <p className="small muted" style={{ marginBottom: 12 }}>
            Correcting a value records that a person read the source document differently from the
            extraction. The comparison, the blocking count and the shipment&apos;s receiving
            readiness all recalculate on the server.
          </p>
          <div className="field">
            <label htmlFor="edit-val">Value as it reads on the document</label>
            <input
              id="edit-val"
              className="input mono"
              value={editing.value}
              autoFocus
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            />
          </div>
        </Modal>
      ) : null}

      {overrideOpen && theCase ? (
        <Modal
          title="Override the blocking mismatches"
          onClose={() => setOverrideOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOverrideOpen(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={busy || overrideReason.trim().length < 15 || !canOverride}
                onClick={async () => {
                  const r = await dispatch({ type: 'case.override', caseId: theCase.id, reason: overrideReason });
                  if (r.ok) {
                    setOverrideOpen(false);
                    setOverrideReason('');
                  }
                }}
              >
                Override with this reason
              </button>
            </>
          }
        >
          <Notice tone="warn" title="This does not correct anything">
            The mismatches stay on record. Receiving readiness is released on the authority of the
            override, not because the document was fixed. Approval matrix AM-3.1 reserves this to
            the Procurement Manager and requires a written reason.
          </Notice>
          {!canOverride ? (
            <div style={{ marginTop: 10 }}>
              <Notice tone="bad" title={`You are acting as ${actingUser?.name}`}>
                Only the Procurement Manager may record an override (AM-3.1). Change the role in the
                top bar to continue — the server refuses the action otherwise.
              </Notice>
            </div>
          ) : null}
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="ovr">Reason (retained on the case)</label>
            <textarea
              id="ovr"
              className="input"
              rows={4}
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="e.g. Supplier confirmed the 18PR casing is an approved upgrade at no cost; commercial terms unchanged."
            />
            <div className="help">
              {overrideReason.trim().length < 15
                ? `At least 15 characters required (${overrideReason.trim().length} so far).`
                : 'Ready to record.'}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ------------------------------ Sub-components ----------------------------- */

function ComparisonTable({
  doc,
  discrepancies,
  onJump,
  onEdit,
  onConfirm,
  busy,
}: {
  doc: SupplierDocument;
  discrepancies: Discrepancy[];
  onJump: (anchor: string, docId: string) => void;
  onEdit: (key: string, label: string, value: string) => void;
  onConfirm: (key: string) => void;
  busy: boolean;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof doc.extraction>();
    for (const f of doc.extraction) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return [...map.entries()];
  }, [doc]);

  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Field</th>
            <th>Extracted from document</th>
            <th>Ordered value</th>
            <th>State</th>
            <th>Rule</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map(([group, fields]) => (
            <React.Fragment key={group}>
              <tr>
                <td colSpan={6} style={{ background: 'var(--surface-2)', padding: '6px 14px' }}>
                  <span className="eyebrow">{group}</span>
                </td>
              </tr>
              {fields.map((f) => {
                const issue = discrepancies.find((d) => d.fieldKey === f.key && !d.resolved);
                return (
                  <tr key={f.key}>
                    <td>
                      <div className="primary-cell">{f.label}</div>
                      <button
                        className="tiny muted"
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
                        onClick={() => onJump(f.anchor, doc.id)}
                      >
                        Page {f.page} · {f.anchor}
                      </button>
                    </td>
                    <td>
                      <span className={`cmp-val ${issue ? 'bad' : 'ok'}`}>{f.value}</span>
                      {f.value !== f.originalValue ? (
                        <div className="tiny muted">
                          originally extracted as <span className="mono">{f.originalValue}</span>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {issue ? (
                        <span className="cmp-val ok">{issue.orderValue}</span>
                      ) : (
                        <span className="tiny muted">matches</span>
                      )}
                      {issue?.impactEgp ? (
                        <div className="tiny muted">
                          {formatEGP(Math.abs(issue.impactEgp))}{' '}
                          {issue.impactEgp > 0 ? 'above the order' : 'short of the order'}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Pill
                        tone={
                          f.state === 'Confirmed' ? 'good' : f.state === 'Corrected' ? 'info' : 'neutral'
                        }
                      >
                        {f.state}
                      </Pill>
                      {issue ? (
                        <div style={{ marginTop: 4 }}>
                          <Pill tone={issue.severity === 'blocking' ? 'bad' : 'warn'}>
                            {issue.severity}
                          </Pill>
                        </div>
                      ) : null}
                    </td>
                    <td className="tiny muted" style={{ maxWidth: '26ch' }}>
                      {issue ? (
                        <>
                          <span className="mono">{issue.ruleId}</span>
                          <div style={{ marginTop: 2 }}>{issue.rule}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="r">
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 5, flexWrap: 'nowrap' }}>
                        <button className="btn sm" onClick={() => onEdit(f.key, f.label, f.value)}>
                          Correct
                        </button>
                        <button
                          className="btn sm ghost"
                          disabled={busy || f.state === 'Confirmed'}
                          onClick={() => onConfirm(f.key)}
                        >
                          Confirm
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Facsimile({
  page,
  flags,
  focusAnchor,
}: {
  page: DocPage;
  flags: Map<string, 'blocking' | 'advisory'>;
  focusAnchor: string | null;
}) {
  return (
    <div className="doc-facsimile">
      <div className="doc-page-title">{page.title}</div>
      {page.rows.map((row) => {
        const flag = flags.get(row.anchor);
        const cls = [
          'doc-row',
          flag === 'blocking' ? 'flagged' : flag === 'advisory' ? 'flagged-advisory' : '',
          focusAnchor === row.anchor ? 'focused' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={row.anchor}
            className={cls}
            data-anchor={row.anchor}
            data-cols={row.cells.length >= 4 ? 4 : 2}
            data-heading={row.heading ? 'true' : undefined}
          >
            {row.cells.map((c, i) => (
              <div key={i} className={i === 0 ? 'c1' : undefined} data-align={i > 0 && row.cells.length >= 4 ? 'r' : undefined}>
                {c}
              </div>
            ))}
          </div>
        );
      })}
      {page.footer?.length ? (
        <div className="doc-foot">
          {page.footer.map((f, i) => (
            <div key={i}>{f}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Corroboration across the documents on the same purchase order.
 * Where two supplier documents disagree with each other, that is a stronger
 * signal than either disagreeing with the order alone.
 */
function CrossCheck({
  state,
  doc,
}: {
  state: NonNullable<ReturnType<typeof useDemo>['state']>;
  doc: SupplierDocument;
}) {
  const po = byId(state.purchaseOrders, doc.purchaseOrderId);
  const others = state.documents.filter(
    (d) => d.purchaseOrderId === doc.purchaseOrderId && d.id !== doc.id && !d.supersedesId,
  );
  if (!po || others.length === 0) return null;

  const rows = po.lines.flatMap((line) => {
    const key = `line.${line.lineNo}.qty`;
    const mine = doc.extraction.find((f) => f.key === key);
    if (!mine) return [];
    return others.flatMap((other) => {
      const theirs = other.extraction.find((f) => f.key === key);
      if (!theirs) return [];
      return [
        {
          lineNo: line.lineNo,
          otherRef: other.reference,
          otherKind: other.kind,
          mine: mine.value,
          theirs: theirs.value,
          ordered: String(line.qty),
        },
      ];
    });
  });

  if (rows.length === 0) return null;

  return (
    <Card className="flush">
      <CardHead
        title="Cross-document check"
        hint="Quantities compared across every document received against this purchase order."
      />
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Line</th>
              <th>Ordered</th>
              <th>{doc.reference}</th>
              <th>Other document</th>
              <th>Reading</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const mineAgrees = r.mine === r.ordered;
              const theirsAgrees = r.theirs === r.ordered;
              return (
                <tr key={i}>
                  <td className="primary-cell">Line {r.lineNo}</td>
                  <td className="cmp-val ok">{r.ordered}</td>
                  <td className={`cmp-val ${mineAgrees ? 'ok' : 'bad'}`}>{r.mine}</td>
                  <td>
                    <span className={`cmp-val ${theirsAgrees ? 'ok' : 'bad'}`}>{r.theirs}</span>
                    <div className="tiny muted">
                      {r.otherKind} {r.otherRef}
                    </div>
                  </td>
                  <td className="tiny muted" style={{ maxWidth: '38ch' }}>
                    {mineAgrees && theirsAgrees
                      ? 'All three agree.'
                      : !mineAgrees && theirsAgrees
                        ? `The ${r.otherKind.toLowerCase()} agrees with the order, so the difference sits with this document rather than with what was packed.`
                        : mineAgrees && !theirsAgrees
                          ? `This document agrees with the order; the ${r.otherKind.toLowerCase()} does not.`
                          : 'Both supplier documents differ from the order.'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function CasePanel({
  docId,
  theCase,
  blockingCount,
  advisoryCount,
  draftSubject,
  draftBody,
  setDraftSubject,
  setDraftBody,
  onOverride,
  busy,
  dispatch,
  onNavigate,
}: {
  docId: string;
  theCase: ReturnType<typeof byId<NonNullable<ReturnType<typeof useDemo>['state']>['cases'][number]>> | undefined;
  blockingCount: number;
  advisoryCount: number;
  draftSubject: string;
  draftBody: string;
  setDraftSubject: (v: string) => void;
  setDraftBody: (v: string) => void;
  onOverride: () => void;
  busy: boolean;
  dispatch: ReturnType<typeof useDemo>['dispatch'];
  onNavigate: (id: string) => void;
}) {
  if (!theCase) {
    return (
      <Card>
        <CardHead
          title="Discrepancy case"
          hint="A case groups the differences, carries the supplier correspondence, and holds receiving readiness until it is closed."
        />
        <div className="card-body stack">
          {blockingCount + advisoryCount === 0 ? (
            <Empty title="Nothing to raise">
              This document agrees with the purchase order on every checked field.
            </Empty>
          ) : (
            <>
              <p className="small">
                {blockingCount} blocking and {advisoryCount} advisory difference(s) are outstanding on
                this document.
              </p>
              <button
                className="btn primary"
                style={{ alignSelf: 'flex-start' }}
                disabled={busy}
                onClick={() => void dispatch({ type: 'case.create', documentId: docId })}
              >
                Create discrepancy case
              </button>
            </>
          )}
        </div>
      </Card>
    );
  }

  const statusTone =
    theCase.status === 'Resolved' ? 'good' : theCase.status === 'Overridden' ? 'warn' : 'bad';

  return (
    <Card>
      <CardHead
        title={`Case ${theCase.id}`}
        hint={theCase.title}
        right={<Pill tone={statusTone}>{theCase.status}</Pill>}
      />
      <div className="card-body stack">
        {/* Step 1 — draft */}
        <div className="stack" style={{ gap: 9 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="eyebrow">Supplier clarification</div>
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => void dispatch({ type: 'case.generateDraft', caseId: theCase.id })}
            >
              {theCase.draft ? 'Regenerate draft' : 'Generate draft'}
            </button>
          </div>

          {theCase.draft ? (
            <>
              <div className="field">
                <label htmlFor="d-to">To</label>
                <input id="d-to" className="input" value={theCase.draft.to} readOnly />
              </div>
              <div className="field">
                <label htmlFor="d-sub">Subject</label>
                <input
                  id="d-sub"
                  className="input"
                  value={draftSubject}
                  onChange={(e) => setDraftSubject(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="d-body">Message</label>
                <textarea
                  id="d-body"
                  className="input"
                  rows={12}
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                />
              </div>
              <div className="row">
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() =>
                    void dispatch({
                      type: 'case.saveDraft',
                      caseId: theCase.id,
                      subject: draftSubject,
                      body: draftBody,
                    })
                  }
                >
                  Save draft
                </button>
                <button
                  className="btn sm primary"
                  disabled={busy || theCase.status === 'Awaiting supplier'}
                  onClick={() => void dispatch({ type: 'case.markSent', caseId: theCase.id })}
                >
                  Record as sent
                </button>
                {theCase.draft.sentInDemoAt ? (
                  <span className="tiny muted">Recorded as sent inside the demo.</span>
                ) : null}
              </div>
              <Notice tone="info">
                Nothing leaves this application. &ldquo;Record as sent&rdquo; writes to the case
                timeline only — no email account or messaging service is connected.
              </Notice>
            </>
          ) : (
            <p className="small muted">
              Generate an editable message listing each blocking point with the ordered value beside
              it.
            </p>
          )}
        </div>

        {/* Step 2 — corrected document */}
        <div className="stack" style={{ gap: 9, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <div className="eyebrow">Revised document</div>
          {theCase.correctedDocumentId ? (
            <>
              <Notice tone="good" title="A revised document has been received">
                It supersedes the original and is now the document under comparison.
              </Notice>
              <div className="row">
                <button
                  className="btn sm primary"
                  disabled={busy}
                  onClick={() => void dispatch({ type: 'case.revalidate', caseId: theCase.id })}
                >
                  Re-run validation and close the case
                </button>
                <button className="btn sm" onClick={() => onNavigate(theCase.correctedDocumentId!)}>
                  Open the revision
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="small muted">
                Simulate the supplier returning a corrected pro forma invoice. The revision is
                generated from the purchase order, so the blocking points are answered while any
                wording-only difference persists.
              </p>
              <button
                className="btn sm"
                style={{ alignSelf: 'flex-start' }}
                disabled={busy || theCase.status === 'Resolved' || theCase.status === 'Overridden'}
                onClick={async () => {
                  const r = await dispatch({ type: 'case.simulateCorrected', caseId: theCase.id });
                  if (r.ok && r.created?.documentId) onNavigate(r.created.documentId);
                }}
              >
                Simulate receipt of a corrected document
              </button>
            </>
          )}
        </div>

        {/* Step 3 — override */}
        <div className="stack" style={{ gap: 9, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <div className="eyebrow">Or accept the difference</div>
          {theCase.status === 'Overridden' ? (
            <Notice tone="warn" title={`Overridden by ${theCase.overrideBy}`}>
              {theCase.overrideReason}
            </Notice>
          ) : (
            <>
              <p className="small muted">
                An authorised Procurement Manager can release receiving readiness without a
                correction, provided a written reason is recorded (AM-3.1).
              </p>
              <button
                className="btn sm danger"
                style={{ alignSelf: 'flex-start' }}
                disabled={busy || theCase.status === 'Resolved' || blockingCount === 0}
                onClick={onOverride}
              >
                Override with a reason
              </button>
            </>
          )}
        </div>

        {theCase.status === 'Resolved' ? (
          <Notice tone="good" title="Case resolved">
            No blocking mismatches remain. Receiving readiness is released. This does not mean the
            goods have arrived, been counted, or that payment is approved — those are separate steps
            (PR-3.1).
          </Notice>
        ) : null}
      </div>
    </Card>
  );
}
