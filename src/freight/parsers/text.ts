/**
 * Deterministic extraction from quotation text (email bodies and PDF text).
 *
 * WHY DETERMINISTIC FIRST
 * -----------------------
 * Freight quotations are repetitive: a labelled line, a currency, a number. A
 * regex over a labelled line is exactly reproducible, cheap, and auditable - it
 * can point at the character range it read. An LLM is only worth reaching for
 * when the text is genuinely unstructured prose, and even then it sits behind
 * the boundary in `adapters/ai.ts` and can never overwrite a value this module
 * read with high confidence.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It never guesses a number that is not written down. A label present with no
 * amount produces a value of `null` with confidence `missing`, which the
 * comparison then treats as blocking rather than as zero.
 */

import type { ChargeBasis, Confidence, ContainerType, Extracted, Surcharge } from '../types';

export interface TextSource {
  /** e.g. "email body" or "Quotation.pdf, page 1". Used in every sourceRef. */
  label: string;
  text: string;
}

/** A value plus the line it was read from. */
interface Hit {
  raw: string;
  line: string;
  lineNumber: number;
}

const CURRENCIES = ['USD', 'EUR', 'EGP', 'GBP', 'CNY', 'AED', 'SAR'];

export function normaliseLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** Finds the first line matching `pattern` and returns capture group 1. */
function findLine(lines: string[], pattern: RegExp): Hit | null {
  for (let i = 0; i < lines.length; i++) {
    const m = pattern.exec(lines[i]);
    if (m) return { raw: m[1] ?? m[0], line: lines[i].trim(), lineNumber: i + 1 };
  }
  return null;
}

function make<T>(
  value: T | null,
  confidence: Confidence,
  source: TextSource,
  hit: Hit | null,
  note: string | null = null,
): Extracted<T> {
  return {
    value,
    confidence,
    sourceRef: hit ? `${source.label}, line ${hit.lineNumber}` : null,
    sourceText: hit ? hit.line : null,
    correctedBy: null,
    correctedAt: null,
    note,
  };
}

export function missing<T>(note: string): Extracted<T> {
  return {
    value: null,
    confidence: 'missing',
    sourceRef: null,
    sourceText: null,
    correctedBy: null,
    correctedAt: null,
    note,
  };
}

/**
 * Parses a money amount out of a fragment.
 *
 * Handles "USD 1,250.00", "1250 USD", "$1,250" and bare "1,250". Returns null
 * for a fragment with no digits at all - notably for "TBA", "on request" and
 * "at cost", which are common in quotations and must not become zero.
 */
export function parseAmount(fragment: string): { amount: number | null; currency: string | null } {
  const upper = fragment.toUpperCase();
  let currency: string | null = CURRENCIES.find((c) => upper.includes(c)) ?? null;
  if (!currency && /\$/.test(fragment)) currency = 'USD';
  if (!currency && /€/.test(fragment)) currency = 'EUR';

  // Strip the currency words and the equipment codes first, so neither "USD"
  // nor the "40" of "40HC" can be mistaken for the amount.
  const stripped = upper
    .replace(/(?:20|40|45)\s?(?:GP|HC|RF)/g, ' ')
    .replace(/[A-Z]{3}/g, ' ')
    .replace(/[$€£]/g, ' ');

  // One pattern, not an alternation: an alternation whose first branch caps the
  // integer part at three digits matches "120" out of "1200.00".
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(stripped);
  if (!m) return { amount: null, currency };
  const amount = Number.parseFloat(m[0].replace(/,/g, ''));
  return { amount: Number.isFinite(amount) ? amount : null, currency };
}

const CONTAINER_PATTERN = /\b(20\s?GP|40\s?GP|40\s?HC|45\s?HC|20\s?RF|40\s?RF|LCL|BREAKBULK)\b/i;

export function parseContainerType(fragment: string): ContainerType | null {
  const m = CONTAINER_PATTERN.exec(fragment);
  if (!m) return null;
  return m[1].toUpperCase().replace(/\s+/g, '') as ContainerType;
}

/** "18 days", "18-20 days" (takes the upper bound), "approx 21 days". */
export function parseDays(fragment: string): number | null {
  const range = /(\d+)\s*[-to]{1,3}\s*(\d+)\s*(?:days?|d\b)/i.exec(fragment);
  if (range) return Number.parseInt(range[2], 10);
  const single = /(\d+)\s*(?:days?|d\b)/i.exec(fragment);
  if (single) return Number.parseInt(single[1], 10);
  const bare = /^\s*(\d+)\s*$/.exec(fragment);
  return bare ? Number.parseInt(bare[1], 10) : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Accepts 2026-11-05, 05/11/2026 (day first) and "5 November 2026". */
export function parseDate(fragment: string): string | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(fragment);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const named = /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/.exec(fragment);
  if (named) {
    const m = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (m) return `${named[3]}-${String(m).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
  }

  const namedFirst = /([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(fragment);
  if (namedFirst) {
    const m = MONTHS[namedFirst[1].slice(0, 3).toLowerCase()];
    if (m) return `${namedFirst[3]}-${String(m).padStart(2, '0')}-${namedFirst[2].padStart(2, '0')}`;
  }

  const slash = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(fragment);
  if (slash) {
    // Day-first: the client and its providers are outside the United States.
    return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  }
  return null;
}

/** Recognised surcharge labels, mapped to a stable code and default basis. */
const SURCHARGE_PATTERNS: { code: string; label: string; pattern: RegExp; basis: ChargeBasis }[] = [
  { code: 'BAF', label: 'Bunker adjustment factor', pattern: /\b(BAF|bunker adjustment|bunker surcharge)\b/i, basis: 'per_container' },
  { code: 'CAF', label: 'Currency adjustment factor', pattern: /\b(CAF|currency adjustment)\b/i, basis: 'per_container' },
  { code: 'THC-ORIGIN', label: 'Terminal handling (origin)', pattern: /\b(origin\s+THC|THC\s+origin|OTHC)\b/i, basis: 'per_container' },
  { code: 'THC-DEST', label: 'Terminal handling (destination)', pattern: /\b(destination\s+THC|THC\s+destination|DTHC)\b/i, basis: 'per_container' },
  { code: 'THC', label: 'Terminal handling', pattern: /\bTHC\b/i, basis: 'per_container' },
  { code: 'ISPS', label: 'Security (ISPS)', pattern: /\b(ISPS|security surcharge)\b/i, basis: 'per_container' },
  { code: 'DOC', label: 'Documentation', pattern: /\b(documentation|doc fee|B\/?L fee|bill of lading fee)\b/i, basis: 'per_bl' },
  { code: 'SEAL', label: 'Seal fee', pattern: /\bseal (fee|charge)\b/i, basis: 'per_container' },
  { code: 'CUSTOMS', label: 'Customs clearance', pattern: /\b(customs clearance|clearance fee)\b/i, basis: 'per_shipment' },
  { code: 'PSS', label: 'Peak season surcharge', pattern: /\b(PSS|peak season)\b/i, basis: 'per_container' },
  { code: 'WAR', label: 'War risk / transit disruption', pattern: /\b(war risk|transit disruption|red sea surcharge|contingency)\b/i, basis: 'per_container' },
];

/** Words that mean "no number here", so the amount stays null, not zero. */
const NO_AMOUNT = /\b(TBA|TBC|to be advised|on request|at cost|as per tariff|not included|excluded)\b/i;

/**
 * Lines that list what an offer covers rather than what it charges.
 *
 * "Excludes: destination terminal handling, customs clearance" names two things
 * the provider is NOT charging for. Reading them as surcharges with no amount
 * would wrongly block the offer from being compared, so these lines are skipped
 * for charge detection entirely.
 */
const NOT_A_CHARGE_LINE =
  /^\s*(includ(es|ed|ing)|exclud(es|ed|ing)|inclusions?|exclusions?|conditions?|remarks?|notes?|subject to)\s*[:-]/i;

/**
 * Pulls surcharges out of a block of text.
 *
 * A recognised label with no readable amount is still returned, with
 * `amount: null`. That is the whole point: the comparison needs to know the
 * charge exists in order to refuse to treat it as zero.
 */
/** A money line the parser could not place. */
export interface UnplacedLine {
  line: number;
  text: string;
}

export interface SurchargeScan {
  surcharges: Surcharge[];
  /**
   * Lines carrying an amount that matched no rule.
   *
   * These are the charges we would otherwise lose in silence. Every provider
   * words their tariff differently, so a line we do not recognise is expected
   * - what is not acceptable is a reviewer never learning it was there.
   */
  unplaced: UnplacedLine[];
}

export function parseSurcharges(source: TextSource): Surcharge[] {
  return scanCharges(source).surcharges;
}

export function scanCharges(source: TextSource): SurchargeScan {
  const lines = normaliseLines(source.text);
  const found: Surcharge[] = [];
  const unplaced: UnplacedLine[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (NOT_A_CHARGE_LINE.test(line)) continue;
    let placed = false;
    for (const p of SURCHARGE_PATTERNS) {
      if (!p.pattern.test(line)) continue;
      // The patterns run most-specific first, so "Origin THC" must not also be
      // picked up by the generic THC rule. One charge per line.
      if (seen.has(p.code)) break;
      // The base freight line often mentions THC in an "includes" phrase; that
      // is an inclusion, not a separate charge.
      if (/\binclud(es|ing|ed)\b/i.test(line) && !/\d/.test(line.split(/includ/i)[1] ?? '')) continue;

      seen.add(p.code);
      const afterLabel = line.replace(p.pattern, ' ');
      const stated = NO_AMOUNT.test(afterLabel);
      const { amount, currency } = stated ? { amount: null, currency: null } : parseAmount(afterLabel);
      const basis = detectBasis(line) ?? p.basis;

      found.push({
        code: p.code,
        label: p.label,
        amount,
        currency,
        basis,
        sourceRef: `${source.label}, line ${i + 1}`,
        confidence: amount === null ? 'missing' : currency ? 'high' : 'medium',
      });
      placed = true;
      break;
    }

    if (!placed && looksLikeACharge(line)) unplaced.push({ line: i + 1, text: line.trim() });
  }
  return { surcharges: found, unplaced };
}

/**
 * Whether an unmatched line looks like it was charging for something.
 *
 * Deliberately narrow. Reporting every line with a number in it would bury the
 * reviewer in dates, container counts and transit times, and a warning nobody
 * reads is worse than none.
 */
function looksLikeACharge(line: string): boolean {
  // An explicit currency list, and a real digit. [A-Z]{3} under /i matched any
  // three letters followed by punctuation, so the greeting "Hala," read as an
  // amount and every quotation reported its own salutation as a charge.
  const money =
    /\b(?:USD|EUR|EGP|GBP|CNY|AED|CHF|JPY|SAR|TRY)\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:USD|EUR|EGP|GBP|CNY|AED|CHF|JPY|SAR|TRY)\b/i;
  if (!money.test(line)) return false;
  // The figures a quotation states about itself, not charges. Whole phrases:
  // "transit time" is a fact about the offer, while "transit levy" is a charge.
  if (/\b(transit (time|days?)|sailing|etd|eta|valid until|free days?|demurrage|\d+\s*days?)\b/i.test(line)) return false;
  if (/\b(ocean freight|base rate|base freight|all[- ]in|total)\b/i.test(line)) return false;
  return true;
}

function detectBasis(line: string): ChargeBasis | null {
  if (/per\s*(container|ctr|box|unit)|\/\s*(container|ctr|cntr)|per\s*(20|40|45)/i.test(line)) return 'per_container';
  if (/per\s*(shipment|booking)/i.test(line)) return 'per_shipment';
  if (/per\s*(b\/?l|bill of lading|set)/i.test(line)) return 'per_bl';
  if (/per\s*cbm/i.test(line)) return 'per_cbm';
  if (/per\s*(tonne|ton|mt)\b/i.test(line)) return 'per_tonne';
  return null;
}

function parseList(fragment: string): string[] {
  return fragment
    .split(/[,;]|\band\b/i)
    .map((s) => s.trim().replace(/^[-*•]\s*/, ''))
    .filter((s) => s.length > 1);
}

export interface TextExtraction {
  shippingLine: Extracted<string>;
  currency: Extracted<string>;
  containerBasis: Extracted<ContainerType>;
  baseFreight: Extracted<number>;
  totalQuoted: Extracted<number>;
  transitDays: Extracted<number>;
  freeDaysDestination: Extracted<number>;
  validUntil: Extracted<string>;
  sailingDate: Extracted<string>;
  paymentTerms: Extracted<string>;
  inclusions: Extracted<string[]>;
  exclusions: Extracted<string[]>;
  conditions: Extracted<string[]>;
  surcharges: Surcharge[];
  /** Money lines that matched no charge rule, so a reviewer can see them. */
  unplacedLines: UnplacedLine[];
  /** True when almost nothing was recognised - the caller may try AI assist. */
  sparse: boolean;
}

export function extractFromText(source: TextSource): TextExtraction {
  const lines = normaliseLines(source.text);

  const lineHit = findLine(lines, /(?:shipping line|carrier|ocean carrier|line)\s*[:\-]\s*(.+)$/i);
  const shippingLine = lineHit
    ? make(lineHit.raw.trim(), 'high', source, lineHit)
    : missing<string>('No shipping line was stated.');

  const freightHit =
    findLine(lines, /(?:base (?:ocean )?freight|ocean freight|basic freight|freight rate)\s*[:\-]?\s*(.+)$/i) ??
    findLine(lines, /^\s*freight\s*[:\-]\s*(.+)$/i);
  const freightParsed = freightHit ? parseAmount(freightHit.raw) : { amount: null, currency: null };
  const baseFreight =
    freightHit && freightParsed.amount !== null
      ? make(freightParsed.amount, freightParsed.currency ? 'high' : 'medium', source, freightHit,
          freightParsed.currency ? null : 'The currency was not on this line; it was taken from elsewhere in the quotation.')
      : missing<number>('No base freight rate was found.');

  // Currency: prefer the freight line, fall back to the first currency anywhere.
  let currency: Extracted<string>;
  if (freightParsed.currency && freightHit) {
    currency = make(freightParsed.currency, 'high', source, freightHit);
  } else {
    const anyHit = findLine(lines, new RegExp(`\\b(${CURRENCIES.join('|')})\\b`));
    currency = anyHit
      ? make(anyHit.raw.toUpperCase(), 'medium', source, anyHit, 'Taken from elsewhere in the quotation, not from the freight line.')
      : missing<string>('No currency was stated.');
  }

  const basisHit =
    findLine(lines, /(?:per|basis|rate per|equipment)\s*[:\-]?\s*.*?(20\s?GP|40\s?GP|40\s?HC|45\s?HC|20\s?RF|40\s?RF|LCL)/i) ??
    (freightHit && parseContainerType(freightHit.line) ? freightHit : null);
  const basisValue = basisHit ? parseContainerType(basisHit.line) : null;
  const containerBasis = basisValue
    ? make(basisValue, 'high', source, basisHit)
    : missing<ContainerType>('The rate does not say which container type it applies to.');

  const totalHit = findLine(lines, /(?:total|all[- ]in|grand total)\s*(?:cost|rate|price)?\s*[:\-]\s*(.+)$/i);
  const totalParsed = totalHit ? parseAmount(totalHit.raw) : { amount: null, currency: null };
  const totalQuoted =
    totalHit && totalParsed.amount !== null
      ? make(totalParsed.amount, 'high', source, totalHit)
      : missing<number>('The provider did not state a total.');

  const transitHit = findLine(lines, /(?:transit(?:\s*time)?|t\/?t)\s*[:\-]?\s*(.+)$/i);
  const transitValue = transitHit ? parseDays(transitHit.raw) : null;
  const transitDays =
    transitValue !== null
      ? make(transitValue, /[-to]/i.test(transitHit?.raw ?? '') ? 'medium' : 'high', source, transitHit,
          /\d+\s*[-to]{1,3}\s*\d+/i.test(transitHit?.raw ?? '')
            ? 'A range was quoted; the longer figure was taken.'
            : null)
      : missing<number>('No transit time was stated.');

  const freeHit = findLine(lines, /free\s*(?:days|time)\s*(?:at\s*destination)?\s*[:\-]?\s*(.+)$/i);
  const freeValue = freeHit ? parseDays(freeHit.raw) : null;
  const freeDaysDestination =
    freeValue !== null
      ? make(freeValue, 'high', source, freeHit)
      : missing<number>('No free days were stated.');

  const validHit = findLine(lines, /(?:valid(?:ity)?(?:\s*until|\s*till|\s*to)?|rate valid|expires?)\s*[:\-]?\s*(.+)$/i);
  const validValue = validHit ? parseDate(validHit.raw) : null;
  const validUntil = validValue
    ? make(validValue, 'high', source, validHit)
    : missing<string>('No validity date was stated.');

  const sailHit = findLine(lines, /(?:sailing|etd|departure|vessel departs?)\s*(?:date)?\s*[:\-]?\s*(.+)$/i);
  const sailValue = sailHit ? parseDate(sailHit.raw) : null;
  const sailingDate = sailValue
    ? make(sailValue, 'high', source, sailHit)
    : missing<string>('No sailing date was stated.');

  const payHit = findLine(lines, /payment\s*(?:terms)?\s*[:\-]\s*(.+)$/i);
  const paymentTerms = payHit
    ? make(payHit.raw.trim(), 'high', source, payHit)
    : missing<string>('No payment terms were stated.');

  const incHit = findLine(lines, /includ(?:es|ed|ing)\s*[:\-]\s*(.+)$/i);
  const inclusions = incHit
    ? make(parseList(incHit.raw), 'medium', source, incHit)
    : missing<string[]>('Nothing was listed as included.');

  const excHit = findLine(lines, /exclud(?:es|ed|ing)\s*[:\-]\s*(.+)$/i);
  const exclusions = excHit
    ? make(parseList(excHit.raw), 'medium', source, excHit)
    : missing<string[]>('Nothing was listed as excluded.');

  const condHit = findLine(lines, /(?:conditions|remarks|notes|subject to)\s*[:\-]\s*(.+)$/i);
  const conditions = condHit
    ? make(parseList(condHit.raw), 'medium', source, condHit)
    : missing<string[]>('No additional conditions were stated.');

  const { surcharges, unplaced } = scanCharges(source);

  const recognised = [baseFreight, transitDays, validUntil, totalQuoted].filter(
    (f) => f.value !== null,
  ).length;

  return {
    shippingLine,
    currency,
    containerBasis,
    baseFreight,
    totalQuoted,
    transitDays,
    freeDaysDestination,
    validUntil,
    sailingDate,
    paymentTerms,
    inclusions,
    exclusions,
    conditions,
    surcharges,
    unplacedLines: unplaced,
    sparse: recognised < 2,
  };
}

/** Detects a provider saying "we cannot quote" so it is not read as an offer. */
export function looksLikeDecline(text: string): boolean {
  return /\b(unable to (quote|offer)|cannot quote|no space|decline to quote|not able to support|we must pass)\b/i.test(
    text,
  );
}
