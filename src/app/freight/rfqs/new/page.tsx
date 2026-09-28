'use client';

/**
 * Capturing a shipping requirement.
 *
 * The form is the working path. The Excel template sits next to it: download
 * it, fill it in, and import it back - the import only fills this form, so a
 * spreadsheet is checked by a person and validated exactly like typed input.
 * Email intake (RFQ_EMAIL_INTAKE) reads the same template.
 */

import React from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHead, Field, Notice } from '@/components/ui';
import { useFreight } from '@/freight/ui/FreightProvider';
import { CONTAINER_TYPES, INCOTERMS, type ContainerType, type Incoterm } from '@/freight/types';
import type { Rfq } from '@/freight/types';
import type { RequestedRfq } from '@/freight/parsers/rfqRequest';

interface Line {
  type: ContainerType;
  quantity: number;
  grossWeightKg: string;
  commodity: string;
}

/** An ISO instant as the value a datetime-local input expects, in local time. */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoDay(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export default function NewRfqPage() {
  const { state, run, busy, companyId, notify } = useFreight();
  const router = useRouter();

  const companies = state?.companies ?? [];
  const [company, setCompany] = React.useState(companyId ?? '');
  const [title, setTitle] = React.useState('');
  const [origin, setOrigin] = React.useState('');
  const [destination, setDestination] = React.useState('');
  const [incoterm, setIncoterm] = React.useState<Incoterm>('FOB');
  const [currency, setCurrency] = React.useState('USD');
  const [from, setFrom] = React.useState(isoDay(14));
  const [to, setTo] = React.useState(isoDay(28));
  const [deadline, setDeadline] = React.useState(`${isoDay(5)}T17:00`);
  const [cargoNotes, setCargoNotes] = React.useState('');
  const [instructions, setInstructions] = React.useState(
    'Please quote all-in and state every surcharge separately, including what each one is charged on.',
  );
  const [lines, setLines] = React.useState<Line[]>([
    { type: '40HC', quantity: 1, grossWeightKg: '', commodity: '' },
  ]);

  React.useEffect(() => {
    if (!company && companies.length === 1) setCompany(companies[0].id);
  }, [companies, company]);

  const [imported, setImported] = React.useState<RequestedRfq[]>([]);
  const [importProblems, setImportProblems] = React.useState<string[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);

  function load(r: RequestedRfq) {
    setTitle(r.title);
    setOrigin(r.originPort);
    setDestination(r.destinationPort);
    if ((INCOTERMS as string[]).includes(r.incoterm)) setIncoterm(r.incoterm as Incoterm);
    setCurrency(r.requestedCurrency);
    setFrom(r.targetShipFrom);
    setTo(r.targetShipTo);
    setDeadline(localDateTime(r.responseDeadline));
    setCargoNotes(r.cargoNotes ?? '');
    if (r.instructions) setInstructions(r.instructions);
    setLines(
      r.containers.map((c) => ({
        type: ((CONTAINER_TYPES as string[]).includes(c.type) ? c.type : '40HC') as ContainerType,
        quantity: c.quantity,
        grossWeightKg: c.grossWeightKg === null ? '' : String(c.grossWeightKg),
        commodity: c.commodity,
      })),
    );
    notify('info', `Loaded "${r.title}" from the spreadsheet. Check it, then create the RFQ.`);
  }

  async function importFile(file: File) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/freight/import-rfq', { method: 'POST', body: form });
    const payload = (await res.json()) as { ok?: boolean; error?: string; requests?: RequestedRfq[]; problems?: string[] };
    if (fileRef.current) fileRef.current.value = '';
    if (!res.ok || !payload.ok) {
      notify('bad', payload.error ?? 'That file could not be read.');
      return;
    }
    setImportProblems(payload.problems ?? []);
    setImported(payload.requests ?? []);
    if (payload.requests?.length === 1) load(payload.requests[0]);
  }

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const result = await run<Rfq>({
      type: 'rfq.create',
      companyId: company,
      title,
      originPort: origin,
      destinationPort: destination,
      incoterm,
      containers: lines.map((l) => ({
        type: l.type,
        quantity: Number(l.quantity),
        grossWeightKg: l.grossWeightKg.trim() === '' ? null : Number(l.grossWeightKg),
        commodity: l.commodity,
      })),
      cargoNotes: cargoNotes.trim() || null,
      targetShipFrom: from,
      targetShipTo: to,
      responseDeadline: new Date(deadline).toISOString(),
      instructions: instructions.trim() || null,
      requestedCurrency: currency.toUpperCase(),
    });
    // Straight into choosing providers: that is always the next thing to do.
    if (result?.data?.id) router.push(`/freight/rfqs/${result.data.id}?tab=recipients`);
  }

  if (companies.length === 0) {
    return (
      <div className="page">
        <Notice tone="warn" title="No company yet. ">
          Add a company in Providers before creating a shipping requirement, so the request can carry a
          reference.
        </Notice>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="fr-head">
        <div>
          <h1>New shipping requirement</h1>
          <div className="sub">
            This becomes the request providers are asked to quote against. You choose who receives it on
            the next screen.
          </div>
        </div>
        <div className="fr-head-actions">
          <a className="btn" href="/api/freight/template/rfq">
            Prefer a spreadsheet?
          </a>
          <label className="btn">
            Import a filled-in template
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
              }}
            />
          </label>
        </div>
      </div>

      {importProblems.length > 0 ? (
        <Notice tone="warn" title="The spreadsheet could not be read in full. ">
          Nothing was loaded. Fix these in the file and import it again:
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            {importProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {imported.length > 1 ? (
        <Notice tone="info" title={`The spreadsheet holds ${imported.length} requirements. `}>
          Load one, create it, then load the next.
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {imported.map((r, i) => (
              <button key={i} type="button" className="btn sm" onClick={() => load(r)}>
                {r.title}
              </button>
            ))}
          </div>
        </Notice>
      ) : null}

      <form onSubmit={submit}>
        <div className="fr-grid two">
          <div className="stack">
            <Card>
              <CardHead title="The shipment" />
              <div className="card-body stack">
                <div className="g2">
                  <Field label="Company">
                    <select className="input" value={company} onChange={(e) => setCompany(e.target.value)} required>
                      <option value="">Choose a company</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Title" help="How the team will recognise this request in a list.">
                    <input
                      className="input"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Tyre import, North China to Alexandria"
                      required
                    />
                  </Field>
                </div>

                <div className="g3">
                  <Field label="Origin port" help="UN/LOCODE where you have it, e.g. CNSHA.">
                    <input
                      className="input mono"
                      value={origin}
                      onChange={(e) => setOrigin(e.target.value.toUpperCase())}
                      placeholder="CNSHA"
                      required
                    />
                  </Field>
                  <Field label="Destination port">
                    <input
                      className="input mono"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value.toUpperCase())}
                      placeholder="EGALY"
                      required
                    />
                  </Field>
                  <Field label="Incoterm">
                    <select className="input" value={incoterm} onChange={(e) => setIncoterm(e.target.value as Incoterm)}>
                      {INCOTERMS.map((i) => (
                        <option key={i} value={i}>
                          {i}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field label="Cargo notes" help="Stowage, hazardous classification, temperature, documentation.">
                  <textarea
                    className="input"
                    rows={2}
                    value={cargoNotes}
                    onChange={(e) => setCargoNotes(e.target.value)}
                    placeholder="Stackable, palletised, no hazardous classification."
                  />
                </Field>
              </div>
            </Card>

            <Card>
              <CardHead
                title="Equipment"
                hint="Providers quote per container, so the type and count decide how the totals are worked out."
                right={
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      setLines((l) => [...l, { type: '40HC', quantity: 1, grossWeightKg: '', commodity: '' }])
                    }
                  >
                    Add a line
                  </button>
                }
              />
              <div className="card-body stack">
                {lines.map((l, i) => (
                  <div key={i} className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Field label="Type">
                      <select
                        className="input"
                        style={{ width: 110 }}
                        value={l.type}
                        onChange={(e) => setLine(i, { type: e.target.value as ContainerType })}
                      >
                        {CONTAINER_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Quantity">
                      <input
                        className="input"
                        style={{ width: 92 }}
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) => setLine(i, { quantity: Number(e.target.value) })}
                        required
                      />
                    </Field>
                    <Field label="Gross weight each (kg)">
                      <input
                        className="input"
                        style={{ width: 150 }}
                        type="number"
                        min={1}
                        value={l.grossWeightKg}
                        onChange={(e) => setLine(i, { grossWeightKg: e.target.value })}
                        placeholder="optional"
                      />
                    </Field>
                    <Field label="Commodity">
                      <input
                        className="input"
                        style={{ minWidth: 190 }}
                        value={l.commodity}
                        onChange={(e) => setLine(i, { commodity: e.target.value })}
                        placeholder="Passenger car tyres"
                        required
                      />
                    </Field>
                    {lines.length > 1 ? (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))}
                        aria-label={`Remove container line ${i + 1}`}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <div className="stack">
            <Card>
              <CardHead title="Timing" />
              <div className="card-body stack">
                <div className="g2">
                  <Field label="Ship from">
                    <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
                  </Field>
                  <Field label="Ship to">
                    <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} required />
                  </Field>
                </div>
                <Field
                  label="Response deadline"
                  help="Providers are asked to reply by this time. Collection is closed by you, not automatically."
                >
                  <input
                    className="input"
                    type="datetime-local"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Quote currency" help="Offers in another currency are flagged rather than converted silently.">
                  <input
                    className="input mono"
                    style={{ width: 96 }}
                    value={currency}
                    maxLength={3}
                    onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                    required
                  />
                </Field>
              </div>
            </Card>

            <Card>
              <CardHead title="Instructions to providers" hint="Added to the bottom of every RFQ email." />
              <div className="card-body">
                <textarea
                  className="input"
                  rows={5}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  aria-label="Instructions to providers"
                />
              </div>
            </Card>

            <Card>
              <div className="card-body">
                <button className="btn primary block" type="submit" disabled={busy || !company}>
                  {busy ? 'Creating…' : 'Create and choose providers'}
                </button>
                <p className="fr-foot-note">
                  Creating a request sends nothing. You select providers, review each email and approve it
                  before anything goes out.
                </p>
              </div>
            </Card>
          </div>
        </div>
      </form>
    </div>
  );
}
