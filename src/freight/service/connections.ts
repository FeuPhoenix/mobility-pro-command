/**
 * Checking the live connections, and remembering the answer.
 *
 * The adapters are rebuilt on every request, so a probe result held on an
 * adapter instance is gone by the next page load. That meant Settings could
 * never say "connected", however well configured Graph was. The result of a
 * check is stored here instead, tagged with the configuration it was made
 * against: change the tenant, app or mailbox and the stored answer no longer
 * applies, so the UI goes back to "not yet checked" rather than vouching for a
 * configuration nobody has tested.
 */

import { getSetting, setSetting } from '../db';
import { assertCanEdit, audit, type Ctx } from '../repo';
import { resolveMailTransport, type TransportStatus } from '../adapters/mail';
import { resolveMailbox, type MailboxStatus } from '../adapters/mailbox';
import { resolveErp, type ErpStatus } from '../adapters/erpnext';

export type ConnectionTarget = 'mail' | 'mailbox' | 'erp';

const TARGET_LABEL: Record<ConnectionTarget, string> = {
  mail: 'outgoing email',
  mailbox: 'incoming email',
  erp: 'ERPNext',
};

function fingerprint(target: ConnectionTarget): string {
  if (target === 'erp') {
    return [
      process.env.ERPNEXT_ADAPTER ?? 'simulated',
      process.env.ERPNEXT_BASE_URL,
      process.env.ERPNEXT_API_KEY,
      process.env.ERPNEXT_DOCTYPE,
    ]
      .map((v) => (v ?? '').toLowerCase())
      .join('|');
  }
  const adapter = target === 'mail' ? process.env.MAIL_ADAPTER : process.env.MAILBOX_ADAPTER;
  return [adapter ?? 'simulated', process.env.GRAPH_TENANT_ID, process.env.GRAPH_CLIENT_ID, process.env.GRAPH_MAILBOX]
    .map((v) => (v ?? '').toLowerCase())
    .join('|');
}

interface StoredProbe<T> {
  fingerprint: string;
  status: T;
}

export async function checkConnection(
  ctx: Ctx,
  target: ConnectionTarget,
): Promise<TransportStatus | MailboxStatus | ErpStatus> {
  assertCanEdit(ctx);
  const status =
    target === 'mail'
      ? await resolveMailTransport().probe()
      : target === 'mailbox'
        ? await resolveMailbox().probe()
        : await resolveErp().probe();
  setSetting(`probe.${target}`, { fingerprint: fingerprint(target), status });
  audit(ctx, {
    companyId: null,
    action: 'connection.checked',
    subject: `connection:${target}`,
    summary: `${ctx.user.name} checked the ${TARGET_LABEL[target]} connection: ${status.label}.`,
  });
  return status;
}

/** The displayed status, replaced by a stored check made against the same configuration. */
export function withLastCheck<T extends { kind: string }>(target: ConnectionTarget, displayed: T): T {
  if (displayed.kind === 'simulated') return displayed;
  const stored = getSetting<StoredProbe<T> | null>(`probe.${target}`, null);
  return stored && stored.fingerprint === fingerprint(target) ? stored.status : displayed;
}
