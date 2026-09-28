/**
 * Building the comparison, its workbook and the completion email.
 *
 * The comparison is recomputed from the current quotes every time it is built,
 * so a correction made during extraction review always flows through. A stored
 * comparison is a snapshot of a decision moment, not a cache.
 */

import type { Comparison, EmailDraft, FxRate, Id, RankingCriteria } from '../types';
import { DEFAULT_CRITERIA } from '../types';
import {
  assertCanEdit,
  audit,
  getCompany,
  getCompanyProvider,
  getRfq,
  insertComparison,
  insertEmail,
  latestComparison,
  listComparisons,
  listQuotes,
  newId,
  now,
  setComparisonWorkbook,
  updateRfq,
  FreightError,
  type Ctx,
} from '../repo';
import { buildComparison, currentQuotes } from '../domain/comparison';
import { buildComparisonWorkbook } from '../excel/workbook';
import { comparisonBody, comparisonSubject, contentHash } from '../domain/email';
import { storeFile } from '../files';
import { getSetting } from '../db';

export interface BuildOptions {
  criteria?: Partial<RankingCriteria>;
  fxRates?: FxRate[];
}

function resolveCriteria(over?: Partial<RankingCriteria>): RankingCriteria {
  const stored = getSetting<RankingCriteria>('ranking.criteria', DEFAULT_CRITERIA);
  const merged = { ...DEFAULT_CRITERIA, ...stored, ...over };
  const total = merged.weightCost + merged.weightTransit + merged.weightFreeDays;
  if (total <= 0) {
    throw new FreightError('The ranking weights add up to zero, so nothing could be ranked.');
  }
  // Normalise so the weights always describe proportions of a whole.
  return {
    ...merged,
    weightCost: merged.weightCost / total,
    weightTransit: merged.weightTransit / total,
    weightFreeDays: merged.weightFreeDays / total,
  };
}

/** Builds a comparison and stores it with its workbook. */
export async function createComparison(ctx: Ctx, rfqId: Id, options: BuildOptions = {}): Promise<Comparison> {
  assertCanEdit(ctx);
  const rfq = getRfq(ctx, rfqId);
  const company = getCompany(ctx, rfq.companyId);
  const quotes = listQuotes(ctx, rfq.id);

  if (currentQuotes(quotes).length === 0) {
    throw new FreightError(
      `No quotations have been received for ${rfq.reference} yet, so there is nothing to compare.`,
    );
  }

  const criteria = resolveCriteria(options.criteria);
  const fxRates = options.fxRates ?? getSetting<FxRate[]>('fx.rates', []);
  const at = now();

  const comparison = buildComparison({
    id: newId('cmp'),
    rfq,
    quotes,
    criteria,
    fxRates,
    providerName: (id) => {
      try {
        return getCompanyProvider(ctx, id).provider.name;
      } catch {
        return 'Unknown provider';
      }
    },
    createdBy: ctx.user.id,
    createdAt: at,
  });

  insertComparison(comparison);

  const workbook = await buildComparisonWorkbook({
    company,
    rfq,
    comparison,
    quotes,
    generatedAt: at,
    generatedBy: ctx.user.name,
    demo: getSetting<boolean>('demo.mode', false),
  });
  const filename = `Freight comparison ${rfq.reference}.xlsx`;
  const key = storeFile(filename, workbook);
  setComparisonWorkbook(comparison.id, key);
  comparison.workbookKey = key;

  if (rfq.status !== 'completed') {
    updateRfq({ ...rfq, status: 'comparison_ready' });
  }

  const comparableCount = comparison.lines.filter((l) => l.comparable).length;
  audit(ctx, {
    companyId: rfq.companyId,
    action: 'comparison.built',
    subject: `rfq:${rfq.id}`,
    summary: `Built the comparison for ${rfq.reference}: ${comparison.lines.length} offer${comparison.lines.length === 1 ? '' : 's'}, ${comparableCount} comparable.${
      comparison.recommendedQuoteId
        ? ` Recommended ${comparison.lines.find((l) => l.quoteId === comparison.recommendedQuoteId)?.providerName}.`
        : ' No offer could be recommended.'
    }`,
    detail: { criteria, offers: comparison.lines.length, comparable: comparableCount },
  });

  return comparison;
}

/**
 * Prepares the completion email to the manager.
 *
 * Called straight after the comparison is built, so the manager is told an
 * approval is waiting rather than having to go looking. It is prepared, not
 * sent: approval is still required.
 */
export function prepareComparisonEmail(ctx: Ctx, comparisonId: Id): EmailDraft {
  assertCanEdit(ctx);
  const comparison = listComparisons(ctx).find((c) => c.id === comparisonId);
  if (!comparison) throw new FreightError('That comparison was not found.', 404, 'not_found');
  const rfq = getRfq(ctx, comparison.rfqId);
  const company = getCompany(ctx, rfq.companyId);

  const manager = managerFor(ctx);
  const recommended = comparison.lines.find((l) => l.quoteId === comparison.recommendedQuoteId) ?? null;
  const cheapest = comparison.lines.find((l) => l.quoteId === comparison.cheapestQuoteId) ?? null;
  const workbookName = comparison.workbookKey ? `Freight comparison ${rfq.reference}.xlsx` : null;

  const at = now();
  const draft: EmailDraft = {
    id: newId('em'),
    companyId: rfq.companyId,
    rfqId: rfq.id,
    kind: 'comparison',
    companyProviderId: null,
    to: [{ name: manager.name, email: manager.email }],
    cc: [],
    subject: comparisonSubject(rfq),
    bodyText: comparisonBody({
      companyName: company.name,
      managerName: manager.name,
      reference: rfq.reference,
      originPort: rfq.originPort,
      destinationPort: rfq.destinationPort,
      baseCurrency: comparison.criteria.baseCurrency,
      offersReceived: comparison.lines.length,
      offersComparable: comparison.lines.filter((l) => l.comparable).length,
      recommended: recommended
        ? {
            providerName: recommended.providerName,
            total: recommended.totalInBaseCurrency as number,
            transitDays: recommended.transitDays,
          }
        : null,
      cheapest: cheapest
        ? { providerName: cheapest.providerName, total: cheapest.totalInBaseCurrency as number }
        : null,
      reasons: comparison.recommendationReasons,
      tradeoffs: comparison.recommendationTradeoffs,
      blockedNotes: comparison.blockedNotes,
      workbookName,
    }),
    attachments: comparison.workbookKey
      ? [
          {
            filename: workbookName as string,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            storageKey: comparison.workbookKey,
            bytes: 0,
          },
        ]
      : [],
    contentHash: '',
    status: 'awaiting_approval',
    approvedBy: null,
    approvedAt: null,
    approvedHash: null,
    sentAt: null,
    transportMessageId: null,
    simulated: true,
    sentByHand: false,
    sentByHandBy: null,
    failureReason: null,
    idempotencyKey: `comparison:${comparison.id}`,
    createdAt: at,
    updatedAt: at,
  };
  draft.contentHash = contentHash(draft);

  try {
    insertEmail(draft);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new FreightError(
        'The comparison email for this comparison has already been prepared. Open it from the approval queue.',
        409,
        'duplicate',
      );
    }
    throw err;
  }

  audit(ctx, {
    companyId: rfq.companyId,
    action: 'comparison.email_prepared',
    subject: `rfq:${rfq.id}`,
    summary: `The comparison for ${rfq.reference} is ready and the email to ${manager.name} is waiting for approval.`,
  });
  return draft;
}

/** Who the comparison goes to. The acting manager, or the first one configured. */
function managerFor(ctx: Ctx): { name: string; email: string } {
  if (ctx.user.role === 'logistics_manager') return { name: ctx.user.name, email: ctx.user.email };
  const configured = getSetting<{ name: string; email: string } | null>('manager.recipient', null);
  if (configured) return configured;
  return { name: ctx.user.name, email: ctx.user.email };
}

export function comparisonFor(ctx: Ctx, rfqId: Id): Comparison | null {
  return latestComparison(ctx, rfqId);
}
