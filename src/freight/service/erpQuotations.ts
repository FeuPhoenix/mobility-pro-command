/**
 * Writing confirmed quotations to ERPNext.
 *
 * This is the destination the customer chose: the raw quotations, so their team
 * can build the analysis in ERPNext rather than receiving our conclusion.
 *
 * One row per quotation *version*, with a stable idempotency key derived from
 * the quote id, so:
 *   - a retry after a timeout updates rather than duplicating,
 *   - a revision is a separate record rather than overwriting the first offer,
 *   - the screen can show an honest attempt count and the last error.
 *
 * Only a quotation a person has checked is ever sent. `quotationBlockedReason`
 * is the single place that decides, and it returns the reason in words so the
 * screen can explain a record's absence instead of leaving a silent gap.
 */

import { createHash } from 'node:crypto';
import type { ErpSync, Id, Quote } from '../types';
import {
  assertCanEdit,
  audit,
  getCompany,
  getCompanyProvider,
  getQuote,
  getRfq,
  listQuotes,
  newId,
  now,
  FreightError,
  type Ctx,
} from '../repo';
import { db, str, json } from '../db';
import { resolveErp, ErpFailure, erpStatusForDisplay } from '../adapters/erpnext';
import { quotationBlockedReason } from '../adapters/erpquotation';

/** Stable across retries and restarts, and distinct per quotation version. */
export function quoteKey(quoteId: Id): string {
  return createHash('sha256').update(`freight-quotation:${quoteId}`).digest('hex').slice(0, 32);
}

export interface QuoteSync extends Omit<ErpSync, 'comparisonId'> {
  quoteId: Id;
}

function rowTo(r: Record<string, unknown>): QuoteSync {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    quoteId: r.quote_id as string,
    adapter: r.adapter as QuoteSync['adapter'],
    status: r.status as QuoteSync['status'],
    attempts: Number(r.attempts ?? 0),
    idempotencyKey: r.idempotency_key as string,
    doctype: str(r.doctype),
    remoteName: str(r.remote_name),
    remoteUrl: str(r.remote_url),
    lastError: str(r.last_error),
    setupRequirements: json<string[]>(r.setup_requirements, []),
    lastAttemptAt: str(r.last_attempt_at),
    completedAt: str(r.completed_at),
    createdAt: r.created_at as string,
  };
}

export function quoteSyncFor(quoteId: Id): QuoteSync | null {
  const row = db().prepare('SELECT * FROM erp_quote_syncs WHERE quote_id = ?').get(quoteId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowTo(row) : null;
}

export function listQuoteSyncs(ctx: Ctx): QuoteSync[] {
  return (db().prepare('SELECT * FROM erp_quote_syncs ORDER BY created_at DESC').all() as Record<string, unknown>[])
    .map(rowTo)
    .filter((s) => ctx.user.companyIds.includes(s.companyId));
}

function insert(s: QuoteSync): void {
  db()
    .prepare(
      'INSERT INTO erp_quote_syncs (id, company_id, quote_id, adapter, status, attempts, idempotency_key, doctype, remote_name, remote_url, last_error, setup_requirements, last_attempt_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      s.id, s.companyId, s.quoteId, s.adapter, s.status, s.attempts, s.idempotencyKey,
      s.doctype, s.remoteName, s.remoteUrl, s.lastError, JSON.stringify(s.setupRequirements),
      s.lastAttemptAt, s.completedAt, s.createdAt,
    );
}

function update(s: QuoteSync): void {
  db()
    .prepare(
      'UPDATE erp_quote_syncs SET adapter=?, status=?, attempts=?, doctype=?, remote_name=?, remote_url=?, last_error=?, setup_requirements=?, last_attempt_at=?, completed_at=? WHERE id=?',
    )
    .run(
      s.adapter, s.status, s.attempts, s.doctype, s.remoteName, s.remoteUrl, s.lastError,
      JSON.stringify(s.setupRequirements), s.lastAttemptAt, s.completedAt, s.id,
    );
}

function queue(ctx: Ctx, quote: Quote): QuoteSync {
  const existing = quoteSyncFor(quote.id);
  if (existing) return existing;
  const status = erpStatusForDisplay();
  const row: QuoteSync = {
    id: newId('qsync'),
    companyId: quote.companyId,
    quoteId: quote.id,
    adapter: status.kind === 'live' ? 'live' : 'simulated',
    status: 'pending',
    attempts: 0,
    idempotencyKey: quoteKey(quote.id),
    doctype: null,
    remoteName: null,
    remoteUrl: null,
    lastError: null,
    setupRequirements: status.setupRequirements,
    lastAttemptAt: null,
    completedAt: null,
    createdAt: now(),
  };
  insert(row);
  return row;
}

export interface QuoteSyncOutcome {
  sync: QuoteSync;
  ok: boolean;
  error: string | null;
  retryable: boolean;
  /** Set when the quotation was not eligible to be written at all. */
  skipped: string | null;
}

/**
 * Writes one quotation.
 *
 * A quotation already written is not written again: the second call returns the
 * existing record rather than re-sending it.
 */
export async function syncQuotation(ctx: Ctx, quoteId: Id): Promise<QuoteSyncOutcome> {
  assertCanEdit(ctx);
  const quote = getQuote(ctx, quoteId);

  const blocked = quotationBlockedReason(quote);
  if (blocked) {
    return {
      sync: quoteSyncFor(quote.id) ?? queue(ctx, quote),
      ok: false,
      error: null,
      retryable: false,
      skipped: blocked,
    };
  }

  let sync = quoteSyncFor(quote.id) ?? queue(ctx, quote);
  if (sync.status === 'success') {
    return { sync, ok: true, error: null, retryable: false, skipped: null };
  }

  const rfq = getRfq(ctx, quote.rfqId);
  const company = getCompany(ctx, quote.companyId);
  const view = getCompanyProvider(ctx, quote.companyProviderId);
  const adapter = resolveErp();
  const kind = erpStatusForDisplay().kind;

  sync = { ...sync, attempts: sync.attempts + 1, lastAttemptAt: now(), adapter: kind };
  update(sync);

  try {
    const result = await adapter.recordQuotation({
      idempotencyKey: sync.idempotencyKey,
      company,
      rfq,
      quote,
      providerName: view.provider.name,
      // Only set once the two systems have been linked; null until then.
      supplierName: null,
      attempt: sync.attempts,
    });

    const done: QuoteSync = {
      ...sync,
      // The adapter's own answer decides this, never the configuration.
      adapter: result.simulated ? 'simulated' : 'live',
      status: 'success',
      doctype: result.doctype,
      remoteName: result.remoteName,
      remoteUrl: result.remoteUrl,
      lastError: null,
      setupRequirements: result.simulated ? erpStatusForDisplay().setupRequirements : [],
      completedAt: now(),
    };
    update(done);

    audit(ctx, {
      companyId: company.id,
      action: 'erp.quotation_recorded',
      subject: `rfq:${rfq.id}`,
      summary: result.simulated
        ? `Recorded the quotation from ${view.provider.name} (version ${quote.version}) locally. This is a simulated record: nothing was written to ERPNext.`
        : `Recorded the quotation from ${view.provider.name} (version ${quote.version}) in ERPNext as ${result.doctype} ${result.remoteName}${result.updatedExisting ? ' (updated the existing record)' : ''}.`,
      detail: { simulated: result.simulated, attempts: done.attempts, remoteName: result.remoteName },
    });

    return { sync: done, ok: true, error: null, retryable: false, skipped: null };
  } catch (err) {
    const failure = err instanceof ErpFailure ? err : null;
    const message = err instanceof Error ? err.message : 'The ERPNext write failed.';
    const setupBlocked = failure !== null && !failure.retryable && failure.setupRequirements.length > 0;

    const failed: QuoteSync = {
      ...sync,
      status: setupBlocked ? 'blocked' : 'failed',
      lastError: message,
      setupRequirements: failure?.setupRequirements.length ? failure.setupRequirements : sync.setupRequirements,
    };
    update(failed);

    audit(ctx, {
      companyId: company.id,
      action: 'erp.quotation_failed',
      subject: `rfq:${rfq.id}`,
      summary: `Attempt ${failed.attempts} to record the quotation from ${view.provider.name} did not succeed: ${message}`,
      detail: { attempts: failed.attempts, retryable: failure?.retryable ?? true },
    });

    return { sync: failed, ok: false, error: message, retryable: failure?.retryable ?? true, skipped: null };
  }
}

export interface RfqSyncSummary {
  recorded: number;
  failed: number;
  skipped: { providerName: string; reason: string }[];
  outcomes: QuoteSyncOutcome[];
}

/**
 * Writes every checked quotation on a request.
 *
 * One at a time, so a single provider that cannot be written does not stop the
 * rest, and each result is reported separately rather than collapsed into one
 * success or failure.
 */
export async function syncRfqQuotations(ctx: Ctx, rfqId: Id): Promise<RfqSyncSummary> {
  assertCanEdit(ctx);
  const rfq = getRfq(ctx, rfqId);
  const quotes = listQuotes(ctx, rfq.id);
  if (quotes.length === 0) {
    throw new FreightError(`No quotations have been received for ${rfq.reference} yet.`);
  }

  const outcomes: QuoteSyncOutcome[] = [];
  const skipped: RfqSyncSummary['skipped'] = [];

  for (const q of quotes) {
    const outcome = await syncQuotation(ctx, q.id);
    outcomes.push(outcome);
    if (outcome.skipped) {
      let providerName = 'Unknown provider';
      try {
        providerName = getCompanyProvider(ctx, q.companyProviderId).provider.name;
      } catch {
        /* keep the fallback rather than failing the whole run */
      }
      skipped.push({ providerName, reason: outcome.skipped });
    }
  }

  return {
    recorded: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok && !o.skipped).length,
    skipped,
    outcomes,
  };
}

export { quotationBlockedReason };
