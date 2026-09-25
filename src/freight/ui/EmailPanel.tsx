'use client';

/**
 * Email review and approval.
 *
 * The reviewer sees exactly what will be sent - every recipient, the subject,
 * the whole body and each attachment - because that is what the approval is
 * bound to. Editing any of it withdraws the approval, and the panel says so
 * plainly rather than letting a stale approval look valid.
 */

import React from 'react';
import { Card, CardHead, Notice } from '@/components/ui';
import { useFreight } from './FreightProvider';
import { ConfirmButton, EmailStatusPill, formatWhen } from './bits';
import type { EmailDraft } from '@/freight/types';

export function EmailPanel({
  email,
  providerLabel,
  onChanged,
}: {
  email: EmailDraft;
  providerLabel: string;
  onChanged: () => void;
}) {
  const { state, run, busy } = useFreight();
  const canApprove = state?.user?.role === 'logistics_manager';
  const isManager = canApprove;

  const [editing, setEditing] = React.useState(false);
  const [subject, setSubject] = React.useState(email.subject);
  const [body, setBody] = React.useState(email.bodyText);
  const [to, setTo] = React.useState(email.to.map((r) => r.email).join(', '));
  const [cc, setCc] = React.useState(email.cc.map((r) => r.email).join(', '));

  React.useEffect(() => {
    setSubject(email.subject);
    setBody(email.bodyText);
    setTo(email.to.map((r) => r.email).join(', '));
    setCc(email.cc.map((r) => r.email).join(', '));
    setEditing(false);
  }, [email.id, email.contentHash, email.subject, email.bodyText, email.to, email.cc]);

  const sent = email.status === 'sent';
  const stale = email.status === 'approval_stale';
  const approved = email.status === 'approved';

  const parseAddresses = (raw: string) =>
    raw
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((address) => ({ name: null, email: address }));

  async function save() {
    const result = await run({
      type: 'email.edit',
      emailId: email.id,
      subject,
      bodyText: body,
      to: parseAddresses(to),
      cc: parseAddresses(cc),
    });
    if (result) {
      setEditing(false);
      onChanged();
    }
  }

  async function act(type: string) {
    const result = await run({ type, emailId: email.id });
    if (result) onChanged();
  }

  return (
    <Card className="flush">
      <CardHead
        title={`${kindTitle(email.kind)} to ${providerLabel}`}
        hint={
          sent
            ? `Sent ${formatWhen(email.sentAt ?? email.updatedAt)}${email.simulated ? ' (simulated - nothing was transmitted)' : ''}.`
            : 'This is exactly what will be sent. Approval is bound to this content.'
        }
        right={<EmailStatusPill status={email.status} simulated={email.simulated} />}
      />

      {stale ? (
        <div style={{ padding: '0 16px', marginTop: 12 }}>
          <Notice tone="bad" title="This changed after it was approved. ">
            The approval no longer applies to what is on screen. Read it again and approve the current
            version before it can be sent.
          </Notice>
        </div>
      ) : null}

      {email.status === 'failed' && email.failureReason ? (
        <div style={{ padding: '0 16px', marginTop: 12 }}>
          <Notice tone="bad" title="This did not send. ">
            {email.failureReason}
          </Notice>
        </div>
      ) : null}

      {approved && email.approvedAt ? (
        <div style={{ padding: '0 16px', marginTop: 12 }}>
          <Notice tone="good" title="Approved. ">
            Approved {formatWhen(email.approvedAt)}. It has not been sent yet.
          </Notice>
        </div>
      ) : null}

      <div className="card-body">
        <div className="mail">
          <div className="mail-head">
            <div className="mail-field">
              <span className="k">To</span>
              {editing ? (
                <input className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
              ) : (
                <span>{email.to.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}</span>
              )}
            </div>
            {editing || email.cc.length > 0 ? (
              <div className="mail-field">
                <span className="k">Cc</span>
                {editing ? (
                  <input className="input" value={cc} onChange={(e) => setCc(e.target.value)} aria-label="Cc" />
                ) : (
                  <span>{email.cc.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}</span>
                )}
              </div>
            ) : null}
            <div className="mail-field">
              <span className="k">Subject</span>
              {editing ? (
                <input
                  className="input"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  aria-label="Subject"
                />
              ) : (
                <span>{email.subject}</span>
              )}
            </div>
            {email.attachments.length > 0 ? (
              <div className="mail-field">
                <span className="k">Attached</span>
                <span>
                  {email.attachments.map((a) => (
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
          </div>

          {editing ? (
            <textarea
              className="mail-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-label="Email body"
            />
          ) : (
            <div className="mail-body">{email.bodyText}</div>
          )}

          <div className="mail-foot">
            {sent ? (
              <span className="small muted">
                Sent emails cannot be edited or sent again. Prepare a new one if something needs to change.
              </span>
            ) : editing ? (
              <>
                <button className="btn primary" disabled={busy} onClick={() => void save()}>
                  Save changes
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setSubject(email.subject);
                    setBody(email.bodyText);
                  }}
                >
                  Cancel
                </button>
                <span className="small muted">
                  Saving a change withdraws any approval already given.
                </span>
              </>
            ) : (
              <>
                <button className="btn" disabled={busy} onClick={() => setEditing(true)}>
                  Edit
                </button>

                {email.status === 'draft' ? (
                  <button className="btn" disabled={busy} onClick={() => void act('email.requestApproval')}>
                    Send for approval
                  </button>
                ) : null}

                {(email.status === 'awaiting_approval' || stale || email.status === 'draft') && isManager ? (
                  <button className="btn primary" disabled={busy} onClick={() => void act('email.approve')}>
                    Approve
                  </button>
                ) : null}

                {approved && isManager ? (
                  <button className="btn" disabled={busy} onClick={() => void act('email.unapprove')}>
                    Withdraw approval
                  </button>
                ) : null}

                {approved || email.status === 'failed' ? (
                  <ConfirmButton
                    className="btn primary"
                    label={email.status === 'failed' ? 'Try sending again' : 'Send now'}
                    confirmLabel={
                      state?.integrations?.mail.connected
                        ? 'Confirm - this will really send'
                        : 'Confirm (simulated send)'
                    }
                    disabled={busy}
                    onConfirm={() => act('email.send')}
                  />
                ) : null}

                {!isManager && (email.status === 'awaiting_approval' || stale) ? (
                  <span className="small muted">
                    Waiting for the Logistics Operations Manager to approve this.
                  </span>
                ) : null}
              </>
            )}
          </div>
        </div>

        {!sent && !state?.integrations?.mail.connected ? (
          <p className="fr-foot-note">
            Mail is running on the simulated transport, so approving and sending records the outcome here
            but transmits nothing. {state?.integrations?.mail.detail}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function kindTitle(kind: EmailDraft['kind']): string {
  switch (kind) {
    case 'rfq':
      return 'Request for quotation';
    case 'reminder':
      return 'Reminder';
    case 'comparison':
      return 'Comparison outcome';
  }
}
