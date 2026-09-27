'use client';

/**
 * Shipping requirements colleagues emailed in (RFQ_EMAIL_INTAKE=on).
 *
 * A request that was read in full links to the draft it created. One that was
 * not says exactly why, so the sender can fix the email or a person can use
 * the form instead, then dismiss it here.
 */

import Link from 'next/link';
import { Card, CardHead, Pill } from '@/components/ui';
import { useFreight } from './FreightProvider';

export function RfqRequestsCard() {
  const { state, run, busy } = useFreight();
  const intake = state?.rfqRequests;
  if (!intake || (!intake.enabled && intake.items.length === 0)) return null;

  const open = intake.items.filter((r) => r.status !== 'dismissed').slice(0, 10);
  const reference = (id: string) => state?.overview?.rfqs.find((r) => r.id === id)?.reference ?? 'the draft';

  return (
    <Card>
      <CardHead
        title="RFQ requests by email"
        hint='Colleagues can email the freight mailbox with "New RFQ" in the subject. Each readable request becomes a draft; providers are still chosen, and email approved, by a person.'
      />
      <div className="card-body stack">
        {open.length === 0 ? (
          <p className="small muted">None yet.</p>
        ) : (
          open.map((r) => (
            <div key={r.id} className="stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 8, justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 13.5 }}>{r.subject}</strong>
                  <div className="small muted">
                    {r.fromEmail} · {new Date(r.receivedAt).toLocaleString('en-GB')}
                  </div>
                </div>
                <Pill tone={r.status === 'created' ? 'good' : 'neutral'}>
                  {r.status === 'created' ? 'Draft created' : 'Needs attention'}
                </Pill>
              </div>
              {r.status === 'created' ? (
                <div className="row small" style={{ gap: 10, flexWrap: 'wrap' }}>
                  {r.rfqIds.map((id) => (
                    <Link key={id} href={`/freight/rfqs/${id}`}>
                      Open {reference(id)}
                    </Link>
                  ))}
                </div>
              ) : (
                <>
                  <ul className="small" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.55 }}>
                    {r.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  <div className="row" style={{ gap: 8 }}>
                    <Link className="btn sm" href="/freight/rfqs/new">
                      Use the form instead
                    </Link>
                    <button
                      className="btn sm ghost"
                      disabled={busy}
                      onClick={() => void run({ type: 'rfqRequest.dismiss', requestId: r.id })}
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
