'use client';

/**
 * Companies and their freight-provider lists.
 *
 * Shared provider details (name, country, head-office mailbox) are held once.
 * The relationship - whether this company may approach them, on which lanes,
 * through which contacts - belongs to the company. A provider marked contracted
 * or excluded cannot be sent an RFQ, and the reason is shown wherever that bites.
 */

import React from 'react';
import { Card, CardHead, Empty, Field, Modal, Notice, Pill } from '@/components/ui';
import { useFreight, type ProviderRow } from '@/freight/ui/FreightProvider';
import type { ImportReport } from '@/freight/service/providers';
import type { RelationshipStatus } from '@/freight/types';

const STATUS_HELP: Record<RelationshipStatus, string> = {
  active: 'Can be sent requests for quotation.',
  contracted: 'Under a running agreement. Outreach is blocked so a spot request cannot cut across it.',
  excluded: 'Deliberately excluded. Outreach is blocked.',
  prospect: 'Known but not onboarded. Outreach is blocked until made active.',
};

export default function ProvidersPage() {
  const { state, companyId, setCompanyId } = useFreight();
  const [query, setQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<'all' | RelationshipStatus>('all');
  const [addOpen, setAddOpen] = React.useState(false);
  const [companyOpen, setCompanyOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

  const companies = state?.companies ?? [];
  const providers = state?.providers ?? [];

  if (companies.length === 0) {
    return (
      <div className="page">
        <div className="fr-head">
          <div>
            <h1>Providers</h1>
            <div className="sub">Freight providers are held per company.</div>
          </div>
        </div>
        <Card>
          <div className="card-body">
            <Empty title="No companies yet">
              Add a company first. Its code becomes part of every RFQ reference.
            </Empty>
            <button className="btn primary" onClick={() => setCompanyOpen(true)}>
              Add a company
            </button>
          </div>
        </Card>
        {companyOpen ? <CompanyModal onClose={() => setCompanyOpen(false)} /> : null}
      </div>
    );
  }

  if (!companyId) {
    return (
      <div className="page">
        <div className="fr-head">
          <div>
            <h1>Providers</h1>
            <div className="sub">Choose a company to see and maintain its freight-provider list.</div>
          </div>
          <div className="fr-head-actions">
            <button className="btn" onClick={() => setCompanyOpen(true)}>
              Add a company
            </button>
          </div>
        </div>
        <Card className="flush">
          <div>
            {companies.map((c) => (
              <button
                key={c.id}
                className="fr-row"
                style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--line, #e3e6ea)', cursor: 'pointer', font: 'inherit', background: 'none' }}
                onClick={() => setCompanyId(c.id)}
              >
                <div className="main">
                  <div className="t">{c.name}</div>
                  <div className="m">
                    <span className="fr-ref">{c.code}</span> · {c.country}
                  </div>
                </div>
                <div className="side">
                  <Pill tone="neutral">Open</Pill>
                </div>
              </button>
            ))}
          </div>
        </Card>
        {companyOpen ? <CompanyModal onClose={() => setCompanyOpen(false)} /> : null}
      </div>
    );
  }

  const company = companies.find((c) => c.id === companyId);
  const needle = query.trim().toLowerCase();
  const shown = providers
    .filter((p) => (statusFilter === 'all' ? true : p.status === statusFilter))
    .filter((p) =>
      needle
        ? [p.name, p.country, p.kind, ...p.lanes.map((l) => `${l.originPort} ${l.destinationPort}`), ...p.contacts.map((c) => c.email)]
            .join(' ')
            .toLowerCase()
            .includes(needle)
        : true,
    );

  const blockedCount = providers.filter((p) => p.status !== 'active').length;

  return (
    <div className="page">
      <div className="fr-head">
        <div>
          <h1>{company?.name ?? 'Providers'}</h1>
          <div className="sub">
            {providers.length} provider{providers.length === 1 ? '' : 's'} on this company&rsquo;s list
            {blockedCount > 0 ? `, ${blockedCount} of which cannot be contacted` : ''}.
          </div>
        </div>
        <div className="fr-head-actions">
          <a className="btn" href={`/api/freight/template/providers?companyId=${encodeURIComponent(companyId)}`}>
            Download template
          </a>
          <button className="btn" onClick={() => setImportOpen(true)}>
            Import a list
          </button>
          <button className="btn primary" onClick={() => setAddOpen(true)}>
            Add a provider
          </button>
        </div>
      </div>

      <div className="fr-bar">
        <div className="seg" role="radiogroup" aria-label="Filter providers by relationship">
          {(['all', 'active', 'contracted', 'excluded', 'prospect'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={statusFilter === s}
              data-on={statusFilter === s}
              onClick={() => setStatusFilter(s)}
            >
              {s === 'all' ? 'All' : s === 'contracted' ? 'Under contract' : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <input
          className="input"
          style={{ maxWidth: 280 }}
          type="search"
          placeholder="Search name, lane or email"
          aria-label="Search providers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <Card className="flush">
        {shown.length === 0 ? (
          <div className="card-body">
            <Empty title="No provider matches">
              {providers.length === 0
                ? 'Add a provider, or import the agreed spreadsheet.'
                : 'Try a different filter or search.'}
            </Empty>
          </div>
        ) : (
          <div className="prov-list">
            {shown.map((p) => (
              <ProviderItem key={p.linkId} provider={p} />
            ))}
          </div>
        )}
      </Card>

      {addOpen ? <ProviderModal companyId={companyId} onClose={() => setAddOpen(false)} /> : null}
      {companyOpen ? <CompanyModal onClose={() => setCompanyOpen(false)} /> : null}
      {importOpen ? <ImportModal companyId={companyId} onClose={() => setImportOpen(false)} /> : null}
    </div>
  );
}

function ProviderItem({ provider }: { provider: ProviderRow }) {
  const { run, busy, state } = useFreight();
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<RelationshipStatus>(provider.status);
  const [reason, setReason] = React.useState(provider.restrictionReason ?? '');
  const canEdit = state?.user?.role !== 'viewer';

  const blocked = provider.status !== 'active';

  return (
    <div className="prov-item" data-blocked={blocked}>
      <div className="main" style={{ flex: 1, minWidth: 0 }}>
        <div className="t">
          {provider.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>· {provider.kind}, {provider.country}</span>
        </div>
        <div className="m">
          {provider.contacts.length > 0
            ? provider.contacts.map((c) => `${c.name} <${c.email}>${c.isPrimary ? ' (primary)' : ''}`).join(', ')
            : provider.generalEmail
              ? `${provider.generalEmail} (general mailbox)`
              : 'No email address on file'}
        </div>
        {provider.lanes.length > 0 ? (
          <div className="m" style={{ marginTop: 4 }}>
            {provider.lanes.map((l, i) => (
              <span key={i} className="lane-chip">
                {l.originPort} → {l.destinationPort}
              </span>
            ))}
          </div>
        ) : null}
        {provider.restrictionReason ? (
          <div className="m" style={{ color: '#a3352f', marginTop: 4 }}>
            {provider.restrictionReason}
          </div>
        ) : null}
        {provider.accountRef ? <div className="m">Account {provider.accountRef}</div> : null}

        {open && canEdit ? (
          <div className="stack" style={{ marginTop: 12, maxWidth: 520 }}>
            <Field label="Relationship" help={STATUS_HELP[status]}>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as RelationshipStatus)}>
                <option value="active">Active</option>
                <option value="contracted">Under contract</option>
                <option value="excluded">Excluded</option>
                <option value="prospect">Prospect</option>
              </select>
            </Field>
            {status === 'contracted' || status === 'excluded' ? (
              <Field label="Reason" help="Shown wherever outreach to this provider is blocked.">
                <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            ) : null}
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn primary sm"
                disabled={busy}
                onClick={() =>
                  void run({
                    type: 'provider.setStatus',
                    linkId: provider.linkId,
                    status,
                    reason: reason.trim() || null,
                  }).then(() => setOpen(false))
                }
              >
                Save
              </button>
              <button className="btn sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="side">
        <Pill tone={provider.status === 'active' ? 'good' : provider.status === 'prospect' ? 'neutral' : 'bad'}>
          {provider.statusLabel}
        </Pill>
        {canEdit ? (
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Close' : 'Edit'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CompanyModal({ onClose }: { onClose: () => void }) {
  const { run, busy } = useFreight();
  const [code, setCode] = React.useState('');
  const [name, setName] = React.useState('');
  const [country, setCountry] = React.useState('Egypt');
  const [address, setAddress] = React.useState('');

  return (
    <Modal
      title="Add a company"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !code || !name}
            onClick={() =>
              void run({
                type: 'company.create',
                code,
                name,
                country,
                addressLines: address.split('\n').filter((l) => l.trim()),
              }).then((r) => {
                if (r) onClose();
              })
            }
          >
            Add the company
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Code" help="Two to six letters. It appears in every RFQ reference, e.g. RFQ-MPD-2026-0007.">
          <input className="input mono" value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Country">
          <input className="input" value={country} onChange={(e) => setCountry(e.target.value)} />
        </Field>
        <Field label="Address" help="Appears at the bottom of every RFQ email. One line per row.">
          <textarea className="input" rows={3} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ProviderModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { run, busy } = useFreight();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState('Freight forwarder');
  const [country, setCountry] = React.useState('');
  const [generalEmail, setGeneralEmail] = React.useState('');
  const [status, setStatus] = React.useState<RelationshipStatus>('active');
  const [reason, setReason] = React.useState('');
  const [accountRef, setAccountRef] = React.useState('');
  const [lanes, setLanes] = React.useState('');
  const [contactName, setContactName] = React.useState('');
  const [contactEmail, setContactEmail] = React.useState('');
  const [contactRole, setContactRole] = React.useState('');

  return (
    <Modal
      title="Add a provider"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !name}
            onClick={() =>
              void run({
                type: 'provider.upsert',
                companyId,
                name,
                kind,
                country,
                website: null,
                generalEmail: generalEmail.trim() || null,
                notes: null,
                status,
                restrictionReason: reason.trim() || null,
                accountRef: accountRef.trim() || null,
                lanes: lanes
                  .split(';')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((part) => {
                    const [o, d] = part.split(/[>→-]/).map((x) => x?.trim().toUpperCase() ?? '');
                    return { originPort: o, destinationPort: d };
                  })
                  .filter((l) => l.originPort && l.destinationPort),
                contacts: contactEmail.trim()
                  ? [
                      {
                        name: contactName.trim() || contactEmail.split('@')[0],
                        email: contactEmail.trim(),
                        role: contactRole.trim() || null,
                        isPrimary: true,
                      },
                    ]
                  : [],
              }).then((r) => {
                if (r) onClose();
              })
            }
          >
            Save the provider
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="g2">
          <Field label="Provider name" help="Matched against existing providers so the same one is not created twice.">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <input className="input" value={kind} onChange={(e) => setKind(e.target.value)} />
          </Field>
        </div>
        <div className="g2">
          <Field label="Country">
            <input className="input" value={country} onChange={(e) => setCountry(e.target.value)} />
          </Field>
          <Field label="General email" help="Shared across companies. Used only if no contact is set.">
            <input className="input" type="email" value={generalEmail} onChange={(e) => setGeneralEmail(e.target.value)} />
          </Field>
        </div>
        <Field label="Relationship with this company" help={STATUS_HELP[status]}>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as RelationshipStatus)}>
            <option value="active">Active</option>
            <option value="contracted">Under contract</option>
            <option value="excluded">Excluded</option>
            <option value="prospect">Prospect</option>
          </select>
        </Field>
        {status === 'contracted' || status === 'excluded' ? (
          <Field label="Reason" help="Required, because outreach will be blocked.">
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        ) : null}
        <div className="g2">
          <Field label="Account reference">
            <input className="input" value={accountRef} onChange={(e) => setAccountRef(e.target.value)} />
          </Field>
          <Field label="Lanes" help="Origin>destination, separated by a semicolon. e.g. CNSHA>EGALY; INNSA>EGALY">
            <input className="input mono" value={lanes} onChange={(e) => setLanes(e.target.value)} />
          </Field>
        </div>
        <div className="g3">
          <Field label="Contact name">
            <input className="input" value={contactName} onChange={(e) => setContactName(e.target.value)} />
          </Field>
          <Field label="Contact email">
            <input className="input" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
          </Field>
          <Field label="Role">
            <input className="input" value={contactRole} onChange={(e) => setContactRole(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function ImportModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { run, busy, notify } = useFreight();
  const [report, setReport] = React.useState<ImportReport | null>(null);
  const [filename, setFilename] = React.useState('');
  const [uploading, setUploading] = React.useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append('companyId', companyId);
      form.append('file', file);
      const res = await fetch('/api/freight/import', { method: 'POST', body: form });
      const payload = (await res.json()) as { ok?: boolean; error?: string; report?: ImportReport; filename?: string };
      if (!res.ok || !payload.ok || !payload.report) {
        notify('bad', payload.error ?? 'That file could not be read.');
        return;
      }
      setReport(payload.report);
      setFilename(payload.filename ?? file.name);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal
      title="Import a provider list"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {report && report.valid > 0 ? (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void run({ type: 'provider.commitImport', companyId, report }).then((r) => {
                  if (r) onClose();
                })
              }
            >
              Import {report.valid} valid row{report.valid === 1 ? '' : 's'}
            </button>
          ) : null}
        </>
      }
    >
      {!report ? (
        <div className="stack">
          <p className="small">
            Upload the agreed spreadsheet. Nothing is saved until you have seen what will happen: the file
            is checked in full first, and rows with problems are reported by row number.
          </p>
          <Field label="Spreadsheet" help="An .xlsx or .csv file. Download the template if you need the columns.">
            <input
              className="input"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </Field>
          {uploading ? <p className="small muted">Reading the file…</p> : null}
          <a className="btn sm" href={`/api/freight/template/providers?companyId=${encodeURIComponent(companyId)}`}>
            Download the template
          </a>
        </div>
      ) : (
        <div className="stack">
          {report.fatal ? (
            <Notice tone="bad" title="This file cannot be used. ">
              {report.fatal}
            </Notice>
          ) : (
            <Notice tone={report.invalid > 0 ? 'warn' : 'good'} title={`${filename}: `}>
              {report.valid} row{report.valid === 1 ? '' : 's'} can be imported
              {report.duplicates > 0 ? `, ${report.duplicates} will update an existing provider` : ''}
              {report.invalid > 0 ? `, and ${report.invalid} will be skipped because of errors` : ''}.
            </Notice>
          )}

          <div style={{ maxHeight: 340, overflow: 'auto' }}>
            {report.rows.map((r) => (
              <div
                key={r.rowNumber}
                style={{
                  padding: '9px 0',
                  borderBottom: '1px solid var(--line, #e3e6ea)',
                  fontSize: 13,
                }}
              >
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="muted" style={{ minWidth: 52 }}>
                    Row {r.rowNumber}
                  </span>
                  <span style={{ fontWeight: 550, flex: 1 }}>{r.input?.name ?? '—'}</span>
                  <Pill tone={r.errors.length > 0 ? 'bad' : r.action === 'update' ? 'warn' : 'good'}>
                    {r.errors.length > 0 ? 'Skipped' : r.action === 'update' ? 'Will update' : 'Will add'}
                  </Pill>
                </div>
                {r.errors.map((e, i) => (
                  <div key={i} className="small" style={{ color: '#a3352f', marginTop: 3 }}>
                    {e}
                  </div>
                ))}
                {r.warnings.map((w, i) => (
                  <div key={i} className="small muted" style={{ marginTop: 3 }}>
                    {w}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
