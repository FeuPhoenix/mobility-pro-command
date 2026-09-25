/**
 * Comparison and recommendation.
 *
 * THE RULES THAT MATTER
 * ---------------------
 * 1. A missing charge is never treated as zero. If a provider did not state a
 *    surcharge amount, the offer is marked not comparable and the UI says which
 *    figure is needed. Quietly summing what we happen to have would make the
 *    incomplete offer look like the cheapest one.
 * 2. Offers in different currencies are not ranked against each other unless an
 *    FX rate with a recorded source and date has been supplied for that pair.
 * 3. Offers quoted on a different container basis than the RFQ asks for are not
 *    ranked against it.
 * 4. Nothing is invented. There is no provider-reliability score, no assumed
 *    surcharge, no default transit time.
 * 5. The cheapest comparable offer and the recommended offer are computed
 *    separately and always both shown. The recommendation is advisory: this
 *    module never selects, negotiates or books.
 */

import type {
  ComparabilityIssue,
  Comparison,
  ComparisonLine,
  ContainerType,
  FxRate,
  Id,
  Quote,
  RankingCriteria,
  Rfq,
} from '../types';
import { CHARGE_BASIS_LABEL } from '../types';

export interface ProviderNameLookup {
  (companyProviderId: Id): string;
}

/** Round to 2dp half-up, avoiding binary float drift on .005 boundaries. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Selects the quotes that belong in a comparison: the newest version from each
 * provider. Earlier versions stay in the database and remain visible in the
 * quote's history, but only the current one is ranked.
 */
export function currentQuotes(quotes: Quote[]): Quote[] {
  const byProvider = new Map<Id, Quote>();
  for (const q of quotes) {
    if (q.status === 'superseded' || q.status === 'declined') continue;
    const existing = byProvider.get(q.companyProviderId);
    if (!existing || q.version > existing.version) byProvider.set(q.companyProviderId, q);
  }
  return [...byProvider.values()];
}

/** Total containers of a given type on the RFQ. */
function containersOfType(rfq: Rfq, type: ContainerType): number {
  return rfq.containers.filter((c) => c.type === type).reduce((n, c) => n + c.quantity, 0);
}

function findFx(rates: FxRate[], from: string, to: string): FxRate | null {
  return rates.find((r) => r.from === from && r.to === to) ?? null;
}

/**
 * Costs one offer out.
 *
 * Returns the total in the quote's own currency, or null with the issues that
 * prevented a total from being computed.
 */
export function costOffer(
  quote: Quote,
  rfq: Rfq,
  criteria: RankingCriteria,
  fxRates: FxRate[],
): Pick<
  ComparisonLine,
  | 'comparable'
  | 'issues'
  | 'totalInQuoteCurrency'
  | 'quoteCurrency'
  | 'totalInBaseCurrency'
  | 'fxApplied'
  | 'totalDiscrepancy'
  | 'transitDays'
  | 'freeDays'
  | 'validUntil'
> {
  const issues: ComparabilityIssue[] = [];

  if (quote.status === 'unreadable') {
    issues.push({
      kind: 'unreadable_source',
      reason: quote.unreadableReason ?? 'The quotation could not be read.',
    });
  }
  if (quote.status === 'needs_review') {
    issues.push({ kind: 'not_reviewed' });
  }

  const currency = quote.currency.value;
  const basis = quote.containerBasis.value;
  const base = quote.baseFreight.value;

  if (base === null) issues.push({ kind: 'missing_base_freight' });

  // How many containers the per-container charges apply to.
  let unitCount: number | null = null;
  if (basis === null) {
    issues.push({
      kind: 'container_basis_mismatch',
      basis: 'not stated',
      expected: rfq.containers.map((c) => c.type).join(', '),
    });
  } else {
    const count = containersOfType(rfq, basis);
    if (count === 0) {
      issues.push({
        kind: 'container_basis_mismatch',
        basis,
        expected: rfq.containers.map((c) => c.type).join(', '),
      });
    } else {
      unitCount = count;
    }
  }

  // Sum the parts. Any surcharge without an amount, without a currency that
  // matches, or without a stated basis blocks the total outright.
  let total: number | null = null;
  if (base !== null && unitCount !== null && currency !== null) {
    let sum = base * unitCount;
    let blocked = false;
    for (const s of quote.surcharges) {
      if (s.amount === null) {
        issues.push({ kind: 'missing_surcharge', label: s.label });
        blocked = true;
        continue;
      }
      if (s.currency && s.currency !== currency) {
        issues.push({ kind: 'currency_mismatch', currency: s.currency, base: currency });
        blocked = true;
        continue;
      }
      switch (s.basis) {
        case 'per_container':
          sum += s.amount * unitCount;
          break;
        case 'per_shipment':
        case 'per_bl':
          sum += s.amount;
          break;
        case 'per_cbm':
        case 'per_tonne':
        case 'unknown':
          issues.push({ kind: 'unknown_charge_basis', label: s.label });
          blocked = true;
          break;
      }
    }
    if (!blocked) total = round2(sum);
  }
  if (currency === null) {
    issues.push({ kind: 'currency_mismatch', currency: 'not stated', base: criteria.baseCurrency });
  }

  // Convert into the base currency, but only with a recorded rate.
  let totalInBase: number | null = null;
  let fxApplied: FxRate | null = null;
  if (total !== null && currency !== null) {
    if (currency === criteria.baseCurrency) {
      totalInBase = total;
    } else {
      const fx = findFx(fxRates, currency, criteria.baseCurrency);
      if (fx) {
        fxApplied = fx;
        totalInBase = round2(total * fx.rate);
      } else {
        issues.push({ kind: 'no_fx_rate', currency, base: criteria.baseCurrency });
      }
    }
  }

  // The provider's own stated total against the sum of the parts.
  let discrepancy: ComparisonLine['totalDiscrepancy'] = null;
  if (total !== null && quote.totalQuoted.value !== null) {
    const stated = quote.totalQuoted.value;
    if (Math.abs(stated - total) > 0.5) discrepancy = { stated, computed: total };
  }

  const transit = quote.transitDays.value;
  if (transit === null) issues.push({ kind: 'missing_transit' });

  const validUntil = quote.validUntil.value;
  if (validUntil) {
    const expiresAt = Date.parse(`${validUntil}T23:59:59Z`);
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      issues.push({ kind: 'expired_validity', validUntil });
    }
  }

  const comparable = issues.length === 0 && totalInBase !== null && transit !== null;

  return {
    comparable,
    issues,
    totalInQuoteCurrency: total,
    quoteCurrency: currency,
    totalInBaseCurrency: totalInBase,
    fxApplied,
    totalDiscrepancy: discrepancy,
    transitDays: transit,
    freeDays: quote.freeDaysDestination.value,
    validUntil,
  };
}

/** Min-max normalisation; 1 is always "best". Returns 1 when all values tie. */
function normalise(value: number, min: number, max: number, lowerIsBetter: boolean): number {
  if (max === min) return 1;
  const t = (value - min) / (max - min);
  return lowerIsBetter ? 1 - t : t;
}

export function buildComparison(args: {
  id: Id;
  rfq: Rfq;
  quotes: Quote[];
  criteria: RankingCriteria;
  fxRates: FxRate[];
  providerName: ProviderNameLookup;
  createdBy: Id;
  createdAt: string;
}): Comparison {
  const { rfq, criteria, fxRates, providerName } = args;
  const selected = currentQuotes(args.quotes);

  const lines: ComparisonLine[] = selected.map((q) => ({
    quoteId: q.id,
    companyProviderId: q.companyProviderId,
    providerName: providerName(q.companyProviderId),
    version: q.version,
    ...costOffer(q, rfq, criteria, fxRates),
    scoreCost: null,
    scoreTransit: null,
    scoreFreeDays: null,
    scoreTotal: null,
    rank: null,
  }));

  const comparable = lines.filter((l) => l.comparable);

  if (comparable.length > 0) {
    const costs = comparable.map((l) => l.totalInBaseCurrency as number);
    const transits = comparable.map((l) => l.transitDays as number);
    // Free days is optional: an offer that did not state it scores 0 on that
    // axis rather than being excluded, because it is a benefit, not a cost.
    const frees = comparable.map((l) => l.freeDays ?? 0);

    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const minTransit = Math.min(...transits);
    const maxTransit = Math.max(...transits);
    const minFree = Math.min(...frees);
    const maxFree = Math.max(...frees);

    for (const l of comparable) {
      l.scoreCost = normalise(l.totalInBaseCurrency as number, minCost, maxCost, true);
      l.scoreTransit = normalise(l.transitDays as number, minTransit, maxTransit, true);
      l.scoreFreeDays = normalise(l.freeDays ?? 0, minFree, maxFree, false);
      l.scoreTotal = round4(
        l.scoreCost * criteria.weightCost +
          l.scoreTransit * criteria.weightTransit +
          l.scoreFreeDays * criteria.weightFreeDays,
      );
    }

    // Rank by score, breaking ties on cost so the order is deterministic.
    const ordered = [...comparable].sort(
      (a, b) =>
        (b.scoreTotal as number) - (a.scoreTotal as number) ||
        (a.totalInBaseCurrency as number) - (b.totalInBaseCurrency as number) ||
        a.providerName.localeCompare(b.providerName),
    );
    ordered.forEach((l, i) => {
      l.rank = i + 1;
    });
  }

  const cheapest =
    comparable.length > 0
      ? [...comparable].sort(
          (a, b) =>
            (a.totalInBaseCurrency as number) - (b.totalInBaseCurrency as number) ||
            a.providerName.localeCompare(b.providerName),
        )[0]
      : null;

  const recommended = comparable.find((l) => l.rank === 1) ?? null;

  const { reasons, tradeoffs } = explain(recommended, cheapest, comparable, criteria);

  return {
    id: args.id,
    companyId: rfq.companyId,
    rfqId: rfq.id,
    criteria,
    fxRates,
    lines: sortForDisplay(lines),
    cheapestQuoteId: cheapest?.quoteId ?? null,
    recommendedQuoteId: recommended?.quoteId ?? null,
    recommendationReasons: reasons,
    recommendationTradeoffs: tradeoffs,
    blockedNotes: lines.filter((l) => !l.comparable).flatMap(describeBlocked),
    workbookKey: null,
    createdBy: args.createdBy,
    createdAt: args.createdAt,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Ranked offers first in rank order, then the ones that could not be ranked. */
function sortForDisplay(lines: ComparisonLine[]): ComparisonLine[] {
  return [...lines].sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.providerName.localeCompare(b.providerName);
  });
}

function money(n: number, currency: string): string {
  return `${currency} ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function explain(
  recommended: ComparisonLine | null,
  cheapest: ComparisonLine | null,
  comparable: ComparisonLine[],
  criteria: RankingCriteria,
): { reasons: string[]; tradeoffs: string[] } {
  const reasons: string[] = [];
  const tradeoffs: string[] = [];
  if (!recommended) {
    return {
      reasons: [],
      tradeoffs: [],
    };
  }

  const cur = criteria.baseCurrency;
  const rTotal = recommended.totalInBaseCurrency as number;

  if (cheapest && cheapest.quoteId === recommended.quoteId) {
    reasons.push(
      `${recommended.providerName} is both the cheapest comparable offer at ${money(rTotal, cur)} and the highest scoring on the current criteria.`,
    );
  } else if (cheapest) {
    const cTotal = cheapest.totalInBaseCurrency as number;
    const premium = round2(rTotal - cTotal);
    const pct = cTotal > 0 ? Math.round((premium / cTotal) * 100) : 0;
    reasons.push(
      `${recommended.providerName} is not the cheapest offer. It costs ${money(premium, cur)} more than ${cheapest.providerName} (${pct}% above ${money(cTotal, cur)}).`,
    );
    if (
      recommended.transitDays !== null &&
      cheapest.transitDays !== null &&
      recommended.transitDays < cheapest.transitDays
    ) {
      reasons.push(
        `It arrives ${cheapest.transitDays - recommended.transitDays} days sooner (${recommended.transitDays} days against ${cheapest.transitDays}).`,
      );
    }
    if ((recommended.freeDays ?? 0) > (cheapest.freeDays ?? 0)) {
      reasons.push(
        `It allows ${recommended.freeDays} free days at destination against ${cheapest.freeDays ?? 0}, which reduces the risk of demurrage.`,
      );
    }
    tradeoffs.push(
      `Choosing ${recommended.providerName} over ${cheapest.providerName} costs ${money(premium, cur)} more on this shipment.`,
    );
  }

  reasons.push(
    `Criteria applied: cost ${Math.round(criteria.weightCost * 100)}%, transit time ${Math.round(criteria.weightTransit * 100)}%, free days ${Math.round(criteria.weightFreeDays * 100)}%.`,
  );

  if (recommended.fxApplied) {
    const fx = recommended.fxApplied;
    tradeoffs.push(
      `This offer was quoted in ${fx.from} and converted at ${fx.rate} ${fx.to}/${fx.from} (${fx.source}, ${fx.asOf}). The final cost moves with the rate.`,
    );
  }
  if (recommended.totalDiscrepancy) {
    tradeoffs.push(
      `The provider's stated total (${money(recommended.totalDiscrepancy.stated, recommended.quoteCurrency ?? cur)}) does not match the sum of the charges they listed (${money(recommended.totalDiscrepancy.computed, recommended.quoteCurrency ?? cur)}). Confirm before booking.`,
    );
  }
  if (comparable.length === 1) {
    tradeoffs.push(
      'Only one offer was comparable, so this is a recommendation by default rather than a ranked choice.',
    );
  }
  return { reasons, tradeoffs };
}

/** Plain-language statement of what is needed to make an offer comparable. */
export function describeBlocked(line: ComparisonLine): string[] {
  return line.issues.map((i) => `${line.providerName}: ${describeIssue(i)}`);
}

export function describeIssue(i: ComparabilityIssue): string {
  switch (i.kind) {
    case 'missing_base_freight':
      return 'no base freight rate was found in the quotation. Ask the provider for the ocean freight rate, or enter it during review.';
    case 'missing_surcharge':
      return `the "${i.label}" surcharge is listed without an amount. It is not counted as zero, so the total cannot be compared until the amount is confirmed.`;
    case 'currency_mismatch':
      return `charges are mixed between ${i.currency} and ${i.base}. A single currency per offer is needed before it can be totalled.`;
    case 'no_fx_rate':
      return `quoted in ${i.currency} while the comparison is in ${i.base}, and no exchange rate has been recorded for that pair. Add a rate with its source and date, or compare it separately.`;
    case 'container_basis_mismatch':
      return `quoted on a ${i.basis} basis, but this RFQ asks for ${i.expected}. Rates on different container types are not ranked against each other.`;
    case 'unknown_charge_basis':
      return `the "${i.label}" charge does not state what it is levied on (${CHARGE_BASIS_LABEL.unknown}). Confirm whether it is per container or per shipment.`;
    case 'expired_validity':
      return `the quotation expired on ${i.validUntil}. Ask the provider to revalidate before it is compared.`;
    case 'missing_transit':
      return 'no transit time was stated, so it cannot be scored on speed.';
    case 'unreadable_source':
      return i.reason;
    case 'not_reviewed':
      return 'the extracted values have not been checked yet. Open the quotation, confirm the figures against the source, and it will join the comparison.';
  }
}
