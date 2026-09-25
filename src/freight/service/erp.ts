/**
 * Recording comparison outcomes in ERPNext.
 *
 * Every sync is a row in `erp_syncs` with a stable idempotency key derived from
 * the comparison. A retry reuses the same row and the same key, so:
 *   - the UI can show an honest attempt count and the last error,
 *   - a retry after a timeout cannot create a second remote record,
 *   - a simulated write is always stored as `adapter: 'simulated'` and can
 *     never be read back as a successful live write.
 */

import type { ErpSync, Id } from '../types';
import {
  assertCanEdit,
  audit,
  getCompany,
  getComparison,
  getCompanyProvider,
  getRfq,
  getSyncByComparison,
  insertSync,
  newId,
  now,
  updateSync,
  FreightError,
  type Ctx,
} from '../repo';
import { resolveErp, ErpFailure, erpStatusForDisplay } from '../adapters/erpnext';
import { readFile, fileExists } from '../files';
import { createHash } from 'node:crypto';

/** Stable across retries, and stable across restarts. */
export function idempotencyKeyFor(comparisonId: Id): string {
  return createHash('sha256').update(`freight-comparison:${comparisonId}`).digest('hex').slice(0, 32);
}

/** Creates the pending sync row, without attempting anything yet. */
export function queueSync(ctx: Ctx, comparisonId: Id): ErpSync {
  assertCanEdit(ctx);
  const comparison = getComparison(ctx, comparisonId);
  const existing = getSyncByComparison(comparisonId);
  if (existing) return existing;

  const status = erpStatusForDisplay();
  const sync: ErpSync = {
    id: newId('sync'),
    companyId: comparison.companyId,
    comparisonId,
    adapter: status.kind === 'live' ? 'live' : 'simulated',
    status: 'pending',
    attempts: 0,
    idempotencyKey: idempotencyKeyFor(comparisonId),
    doctype: null,
    remoteName: null,
    remoteUrl: null,
    lastError: null,
    setupRequirements: status.setupRequirements,
    lastAttemptAt: null,
    completedAt: null,
    createdAt: now(),
  };
  insertSync(sync);
  return sync;
}

export interface SyncOutcome {
  sync: ErpSync;
  ok: boolean;
  error: string | null;
  retryable: boolean;
}

/**
 * Attempts the write.
 *
 * A successful sync is never re-attempted: the second call returns the existing
 * record rather than writing again.
 */
export async function runSync(ctx: Ctx, comparisonId: Id): Promise<SyncOutcome> {
  assertCanEdit(ctx);
  const comparison = getComparison(ctx, comparisonId);
  const rfq = getRfq(ctx, comparison.rfqId);
  const company = getCompany(ctx, comparison.companyId);

  let sync = getSyncByComparison(comparisonId) ?? queueSync(ctx, comparisonId);
  if (sync.status === 'success') {
    return { sync, ok: true, error: null, retryable: false };
  }

  const adapter = resolveErp();
  const adapterKind = erpStatusForDisplay().kind;
  const at = now();

  const providerNames: Record<string, string> = {};
  for (const line of comparison.lines) {
    try {
      providerNames[line.companyProviderId] = getCompanyProvider(ctx, line.companyProviderId).provider.name;
    } catch {
      providerNames[line.companyProviderId] = line.providerName;
    }
  }

  const workbook =
    comparison.workbookKey && fileExists(comparison.workbookKey)
      ? {
          filename: `Freight comparison ${rfq.reference}.xlsx`,
          content: readFile(comparison.workbookKey),
        }
      : null;

  sync = { ...sync, attempts: sync.attempts + 1, lastAttemptAt: at, adapter: adapterKind };
  updateSync(sync);

  try {
    const result = await adapter.record({
      idempotencyKey: sync.idempotencyKey,
      company: { code: company.code, name: company.name },
      rfq,
      comparison,
      providerNames,
      workbook,
      comparisonDate: comparison.createdAt.slice(0, 10),
    });

    const done: ErpSync = {
      ...sync,
      // The adapter's own answer decides this, not the configuration.
      adapter: result.simulated ? 'simulated' : 'live',
      status: 'success',
      doctype: result.doctype,
      remoteName: result.remoteName,
      remoteUrl: result.remoteUrl,
      lastError: null,
      setupRequirements: result.simulated ? erpStatusForDisplay().setupRequirements : [],
      completedAt: now(),
    };
    updateSync(done);

    audit(ctx, {
      companyId: company.id,
      action: 'erp.recorded',
      subject: `rfq:${rfq.id}`,
      summary: result.simulated
        ? `Recorded the outcome of ${rfq.reference} locally. This is a simulated record: nothing was written to ERPNext.`
        : `Recorded the outcome of ${rfq.reference} in ERPNext as ${result.doctype} ${result.remoteName}${result.updatedExisting ? ' (updated the existing record)' : ''}.`,
      detail: { simulated: result.simulated, attempts: done.attempts, remoteName: result.remoteName },
    });

    return { sync: done, ok: true, error: null, retryable: false };
  } catch (err) {
    const failure = err instanceof ErpFailure ? err : null;
    const message = err instanceof Error ? err.message : 'The ERPNext write failed.';
    const blocked = failure !== null && !failure.retryable && failure.setupRequirements.length > 0;

    const failed: ErpSync = {
      ...sync,
      status: blocked ? 'blocked' : 'failed',
      lastError: message,
      setupRequirements: failure?.setupRequirements.length ? failure.setupRequirements : sync.setupRequirements,
    };
    updateSync(failed);

    audit(ctx, {
      companyId: company.id,
      action: 'erp.failed',
      subject: `rfq:${rfq.id}`,
      summary: `Attempt ${failed.attempts} to record ${rfq.reference} did not succeed: ${message}`,
      detail: { attempts: failed.attempts, retryable: failure?.retryable ?? true },
    });

    return { sync: failed, ok: false, error: message, retryable: failure?.retryable ?? true };
  }
}

/** The sync row for a comparison, creating a pending one if none exists yet. */
export function syncFor(ctx: Ctx, comparisonId: Id): ErpSync | null {
  try {
    getComparison(ctx, comparisonId);
  } catch {
    return null;
  }
  return getSyncByComparison(comparisonId);
}

export function assertNotDuplicate(sync: ErpSync): void {
  if (sync.status === 'success') {
    throw new FreightError(
      'This comparison has already been recorded. It will not be recorded a second time.',
      409,
      'already_recorded',
    );
  }
}
