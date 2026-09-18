'use client';

import React, { useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDemo } from '@/components/DemoProvider';
import { OpsNav } from '@/components/OpsNav';
import { Card, CardHead, Empty, Icon, PageLoading, Pill } from '@/components/ui';
import { documentTotals, receivingReadiness } from '@/domain/documentRules';
import { byId } from '@/domain/selectors';
import { formatDate, formatEGP, formatUSD } from '@/domain/money';

export default function DocumentsPage() {
  const { state } = useDemo();
  const router = useRouter();

  const rows = useMemo(() => {
    if (!state) return [];
    return state.shipments.map((sh) => {
      const po = byId(state.purchaseOrders, sh.purchaseOrderId)!;
      const docs = state.documents.filter((d) => d.shipmentId === sh.id);
      const pi = docs
        .filter((d) => d.kind === 'Pro forma invoice')
        .sort((a, b) => b.revision - a.revision)[0];
      const readiness = receivingReadiness(state, sh.id);
      const relatedCase = state.cases.find((c) => c.shipmentId === sh.id);
      return { sh, po, docs, pi, readiness, relatedCase };
    });
  }, [state]);

  if (!state) return <PageLoading />;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Supplier document control</h1>
        <p className="sub">
          Every supplier pro forma invoice and packing list is checked against the purchase order it
          references, under the import document control SOP. Receiving readiness is held while a
          blocking mismatch is open.
        </p>
      </div>
      <OpsNav />

      <div className="stack">
        <Card className="flush">
          <CardHead
            title="Shipments and their documents"
            hint="Open a row to compare the original document with the extracted fields."
          />
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Shipment</th>
                  <th>Purchase order</th>
                  <th>Documents on file</th>
                  <th className="r">Order value</th>
                  <th className="r">Document value</th>
                  <th>Receiving readiness</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ sh, po, docs, pi, readiness, relatedCase }) => {
                  const totals = pi ? documentTotals(pi, po) : null;
                  const tone =
                    readiness.state === 'Ready for receiving'
                      ? 'good'
                      : readiness.state === 'Held - document control'
                        ? 'bad'
                        : readiness.state === 'Goods received'
                          ? 'info'
                          : 'neutral';
                  return (
                    <tr
                      key={sh.id}
                      className={pi ? 'clickable' : undefined}
                      onClick={() => pi && router.push(`/operations/documents/${pi.id}`)}
                    >
                      <td>
                        <div className="primary-cell">{sh.id}</div>
                        <div className="tiny muted">
                          {sh.vessel} · ETA {formatDate(sh.eta)}
                        </div>
                        <div className="tiny muted">
                          {sh.portOfDischarge} → {byId(state.warehouses, sh.destinationWarehouseId)?.name}
                        </div>
                      </td>
                      <td>
                        <div className="mono">{po.id}</div>
                        <div className="tiny muted">{byId(state.suppliers, po.supplierId)?.name}</div>
                        <div className="tiny muted">
                          {po.incoterm} · {po.paymentTerms}
                        </div>
                      </td>
                      <td>
                        <div className="stack" style={{ gap: 3 }}>
                          {docs.map((d) => (
                            <div key={d.id} className="tiny">
                              <span className="mono">{d.reference}</span>{' '}
                              <span className="muted">
                                {d.kind}
                                {d.revision > 1 ? ` · rev ${d.revision}` : ''}
                              </span>
                            </div>
                          ))}
                          {docs.length === 0 ? <span className="tiny muted">None received</span> : null}
                        </div>
                      </td>
                      <td className="r">
                        {totals ? (
                          <>
                            <div>{formatEGP(totals.orderValueEgp)}</div>
                            <div className="tiny muted">{formatUSD(totals.orderValueUsd)}</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="r">
                        {totals ? (
                          <>
                            <div className={totals.varianceUsd !== 0 ? 'cmp-val bad' : undefined}>
                              {formatEGP(totals.documentValueEgp)}
                            </div>
                            <div className="tiny muted">
                              {totals.varianceUsd === 0
                                ? 'Matches the order'
                                : `${totals.varianceUsd > 0 ? '+' : ''}${formatUSD(totals.varianceUsd)} vs order`}
                            </div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <Pill tone={tone}>{readiness.state}</Pill>
                        {readiness.blockingCount > 0 ? (
                          <div className="tiny muted" style={{ marginTop: 4 }}>
                            {readiness.blockingCount} blocking
                            {readiness.advisoryCount ? `, ${readiness.advisoryCount} advisory` : ''}
                          </div>
                        ) : readiness.advisoryCount ? (
                          <div className="tiny muted" style={{ marginTop: 4 }}>
                            {readiness.advisoryCount} advisory note
                            {readiness.advisoryCount === 1 ? '' : 's'}
                          </div>
                        ) : null}
                        {relatedCase ? (
                          <div className="tiny muted" style={{ marginTop: 3 }}>
                            Case {relatedCase.id}: {relatedCase.status}
                          </div>
                        ) : null}
                      </td>
                      <td className="r">
                        {pi ? (
                          <Link className="btn sm" href={`/operations/documents/${pi.id}`}>
                            Open <Icon name="arrow" size={13} />
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        {state.cases.length > 0 ? (
          <Card className="flush">
            <CardHead title="Discrepancy cases" hint="Raised from a document that disagrees with its purchase order." />
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Document</th>
                    <th>Status</th>
                    <th>Owner</th>
                    <th>Opened</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.cases.map((c) => {
                    const doc = byId(state.documents, c.documentId);
                    const tone =
                      c.status === 'Resolved' ? 'good' : c.status === 'Overridden' ? 'warn' : 'bad';
                    return (
                      <tr key={c.id}>
                        <td className="primary-cell mono">{c.id}</td>
                        <td>
                          <span className="mono">{doc?.reference}</span>
                          <div className="tiny muted">{c.purchaseOrderId}</div>
                        </td>
                        <td>
                          <Pill tone={tone}>{c.status}</Pill>
                          {c.overrideReason ? (
                            <div className="tiny muted" style={{ marginTop: 4, maxWidth: '40ch' }}>
                              Override by {c.overrideBy}: {c.overrideReason}
                            </div>
                          ) : null}
                        </td>
                        <td className="tiny">{byId(state.users, c.ownerId)?.name}</td>
                        <td className="tiny muted">{formatDate(c.openedOn.slice(0, 10))}</td>
                        <td className="r">
                          {doc ? (
                            <Link className="btn sm" href={`/operations/documents/${doc.id}`}>
                              Open
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Card>
            <Empty title="No discrepancy cases yet">
              Open the held shipment above, review the mismatches, and raise a case to start the
              supplier clarification workflow.
            </Empty>
          </Card>
        )}
      </div>
    </div>
  );
}
