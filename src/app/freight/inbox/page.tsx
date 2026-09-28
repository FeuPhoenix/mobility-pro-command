'use client';

/**
 * Replies that could not be attached to a request automatically.
 *
 * Nothing here is guessed. The matcher says exactly why it stopped, offers the
 * candidates it considered, and a person decides. Getting this wrong would
 * attach one provider's prices to another company's request.
 */

import React from 'react';
import Link from 'next/link';
import { Card, CardHead, Empty, Field, Notice, Pill } from '@/components/ui';
import { RfqRequestsCard } from '@/freight/ui/RfqRequestsCard';
import { useFreight } from '@/freight/ui/FreightProvider';
import { formatWhen, truncate } from '@/freight/ui/bits';
import { useSearchParams } from 'next/navigation';
import type { InboundMessage } from '@/freight/types';

export default function InboxPage() {
  const { state, run, busy } = useFreight();
  const search = useSearchParams();
  const [open, setOpen] = React.useState<string | null>(search.get('message'));
  const [showMatched, setShowMatched] = React.useState(false);

  const all = state?.inbox ?? [];
  const unmatched = all.filter((m) => m.matchStatus !== 'matched');
  const shown = showMatched ? all : unmatched;
  const current = shown.find((m) => m.id === open) ?? shown[0] ?? null;

  return (
    <div className="page">
      <div className="fr-head">
        <div>
          <h1>Replies</h1>
          <div className="sub">
            Replies that quote their reference are attached automatically. Anything ambiguous waits here
            rather than being guessed.
          </div>
        </div>
        <div className="fr-head-actions">
          <ImportEmlButton />
          <label className="row" style={{ gap: 7, fontSize: 13 }}>
            <input type="checkbox" checked={showMatched} onChange={(e) => setShowMatched(e.target.checked)} />
            Show replies already matched
          </label>
          {state?.user?.role !== 'viewer' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void run({ type: 'mailbox.collect' })}>
              Collect now
            </button>
          ) : null}
        </div>
      </div>

      <RfqRequestsCard />

      {unmatched.length === 0 && !showMatched ? (
        <Card>
          <div className="card-body">
            <Empty title="Every reply has been matched">
              When a provider replies without quoting the reference, or from an address we do not
              recognise, it appears here for you to attach.
            </Empty>
          </div>
        </Card>
      ) : (
        <div className="fr-grid two">
          <Card className="flush">
            <CardHead title={showMatched ? 'All replies' : 'Needs a person'} />
            <div>
              {shown.map((m) => (
                <button
                  key={m.id}
                  className="fr-row"
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    background: current?.id === m.id ? '#f6f8fa' : undefined,
                    border: 0,
                    borderBottom: '1px solid var(--line, #e3e6ea)',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                  onClick={() => setOpen(m.id)}
                >
                  <div className="main">
                    <div className="t">{m.fromEmail}</div>
                    <div className="m">{truncate(m.subject, 64)}</div>
                    <div className="m">{formatWhen(m.receivedAt)}</div>
                  </div>
                  <div className="side">
                    <Pill tone={m.matchStatus === 'matched' ? 'good' : m.matchStatus === 'ambiguous' ? 'warn' : 'bad'}>
                      {m.matchStatus === 'matched' ? 'Matched' : m.matchStatus === 'ambiguous' ? 'Ambiguous' : 'Unknown sender'}
                    </Pill>
                  </div>
                </button>
              ))}
            </div>
          </Card>

          {current ? <MessagePanel message={current} /> : null}
        </div>
      )}
    </div>
  );
}

function MessagePanel({ message }: { message: InboundMessage }) {
  const { state, run, busy } = useFreight();
  const rfqs = state?.overview?.rfqs ?? [];

  const [rfqId, setRfqId] = React.useState(message.candidates[0]?.rfqId ?? message.rfqId ?? '');
  const [providerId, setProviderId] = React.useState(message.candidates[0]?.companyProviderId ?? '');

  React.useEffect(() => {
    setRfqId(message.candidates[0]?.rfqId ?? message.rfqId ?? '');
    setProviderId(message.candidates[0]?.companyProviderId ?? '');
  }, [message.id, message.rfqId, message.candidates]);

  const matched = message.matchStatus === 'matched';

  return (
    <div className="stack">
      <Card>
        <CardHead
          title={matched ? 'Attached to a request' : 'Which request is this?'}
          hint={message.matchBasis}
        />
        <div className="card-body stack">
          {!matched ? (
            <>
              {message.candidates.length > 0 ? (
                <div>
                  <h3 style={{ fontSize: 13, marginBottom: 8 }}>Candidates the matcher considered</h3>
                  <div className="stack" style={{ gap: 6 }}>
                    {message.candidates.map((c) => (
                      <label
                        key={`${c.rfqId}:${c.companyProviderId}`}
                        className="row"
                        style={{
                          gap: 10,
                          padding: '9px 12px',
                          border: '1px solid var(--line, #e3e6ea)',
                          borderRadius: 10,
                          alignItems: 'flex-start',
                          cursor: 'pointer',
                          background:
                            rfqId === c.rfqId && providerId === c.companyProviderId ? '#f4f8fc' : undefined,
                        }}
                      >
                        <input
                          type="radio"
                          name="candidate"
                          checked={rfqId === c.rfqId && providerId === c.companyProviderId}
                          onChange={() => {
                            setRfqId(c.rfqId);
                            setProviderId(c.companyProviderId);
                          }}
                        />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 13.5, fontWeight: 550 }}>
                            {c.providerName}
                          </span>
                          <span className="fr-ref">{c.rfqReference}</span>
                          <span className="m" style={{ display: 'block', fontSize: 12.5, color: '#6b7480' }}>
                            {c.reason}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : (
                <Notice tone="warn" title="No candidate could be suggested. ">
                  This address is not a registered contact for any provider. Add it to a provider in the
                  Providers screen, then come back, or choose the request by hand below.
                </Notice>
              )}

              <div className="g2">
                <Field label="Request">
                  <select className="input" value={rfqId} onChange={(e) => setRfqId(e.target.value)}>
                    <option value="">Choose a request</option>
                    {rfqs.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.reference} — {r.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Provider" help="Only providers that were sent this request can be chosen.">
                  <ProviderPicker rfqId={rfqId} value={providerId} onChange={setProviderId} />
                </Field>
              </div>

              <div>
                <button
                  className="btn primary"
                  disabled={busy || !rfqId || !providerId}
                  onClick={() =>
                    void run({
                      type: 'inbox.assign',
                      messageId: message.id,
                      rfqId,
                      companyProviderId: providerId,
                    })
                  }
                >
                  Attach and read the quotation
                </button>
                <p className="fr-foot-note">
                  Attaching it extracts the quotation with the same parsers used for an automatic match.
                  The figures still need checking before they can be compared.
                </p>
              </div>
            </>
          ) : (
            <p className="small">
              {message.rfqId ? (
                <Link className="btn sm" href={`/freight/rfqs/${message.rfqId}?tab=quotes`}>
                  Open the request
                </Link>
              ) : null}
            </p>
          )}
        </div>
      </Card>

      <Card className="flush">
        <CardHead title="The reply" hint={`From ${message.fromEmail} · ${formatWhen(message.receivedAt)}`} />
        <div className="card-body">
          <div className="mail-field" style={{ marginBottom: 10 }}>
            <span className="k">Subject</span>
            <span>{message.subject}</span>
          </div>
          {message.attachments.length > 0 ? (
            <div className="mail-field" style={{ marginBottom: 10 }}>
              <span className="k">Attached</span>
              <span>
                {message.attachments.map((a) => (
                  <a
                    key={a.storageKey}
                    className="ref-chip"
                    href={`/api/freight/file/${encodeURIComponent(a.storageKey)}`}
                    style={{ marginRight: 6 }}
                  >
                    {a.filename}
                  </a>
                ))}
              </span>
            </div>
          ) : null}
          <pre className="source-text">{message.bodyText}</pre>
        </div>
      </Card>
    </div>
  );
}

/** Providers actually on the chosen request, fetched when one is picked. */
function ProviderPicker({
  rfqId,
  value,
  onChange,
}: {
  rfqId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [options, setOptions] = React.useState<{ id: string; name: string }[]>([]);

  React.useEffect(() => {
    if (!rfqId) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/freight/rfq/${encodeURIComponent(rfqId)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as {
        detail: { recipients: { recipient: { companyProviderId: string }; providerName: string }[] };
      };
      if (cancelled) return;
      setOptions(
        data.detail.recipients.map((r) => ({ id: r.recipient.companyProviderId, name: r.providerName })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [rfqId]);

  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)} disabled={!rfqId}>
      <option value="">{rfqId ? 'Choose a provider' : 'Choose a request first'}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Loads `.eml` files as though they had arrived in the mailbox.
 *
 * This is how a real provider quotation gets in front of the extractor before
 * any mailbox is connected: export the reply from Outlook, drop it here, and it
 * goes through the same matching and extraction as a live one.
 */
function ImportEmlButton() {
  const { refresh, notify } = useFreight();
  const input = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);

  async function upload(files: FileList) {
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('file', f);
      const res = await fetch('/api/freight/inbox/import', { method: 'POST', body: form });
      const payload = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        data?: { results: { filename: string; ok: boolean; error?: string; warnings?: string[] }[] };
      };
      if (!res.ok && !payload.data) {
        notify('bad', payload.error ?? 'Those files could not be loaded.');
        return;
      }
      notify(payload.ok ? 'ok' : 'info', payload.message ?? 'Done.');
      for (const r of payload.data?.results ?? []) {
        if (!r.ok) notify('bad', `${r.filename}: ${r.error}`);
        else for (const w of r.warnings ?? []) notify('info', `${r.filename}: ${w}`);
      }
      await refresh();
    } catch {
      notify('bad', 'Those files could not be loaded.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".eml"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files);
        }}
      />
      <button className="btn" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Loading…' : 'Load .eml files'}
      </button>
    </>
  );
}
