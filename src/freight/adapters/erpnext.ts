/**
 * ERPNext recording boundary for freight comparison outcomes.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not invent a DocType. ERPNext has no native "freight comparison"
 * document, and the right destination depends on what is actually installed on
 * the client's site - a custom DocType, a Supplier Quotation per offer, or a
 * Request for Quotation with custom fields. Guessing would mean either writing
 * to the wrong place or failing at runtime against a schema we never saw.
 *
 * So the live adapter refuses to write until `ERPNEXT_DOCTYPE` names a DocType
 * that it has verified exists on the target instance, and it reports the
 * discovery steps as setup requirements in the UI instead. See
 * docs/FREIGHT_ERPNEXT.md for the proposed mapping and the open questions.
 *
 * IDEMPOTENCY
 * -----------
 * Every sync carries a stable key derived from the comparison id. The live
 * adapter looks for an existing document with that key before inserting, so a
 * retry after a timeout updates the existing record rather than creating a
 * second one.
 *
 * NOT VERIFIED LIVE: no ERPNext instance was reachable from this environment.
 * The live path is written and its error handling is exercised by tests against
 * a stub server, but it has not been run against a real Frappe site.
 */

import type { Comparison, Rfq } from '../types';
import {
  quotationPayload,
  quotationFieldNames,
  QUOTATION_CHARGE_FIELDS,
  type QuotationRecordInput,
} from './erpquotation';
import { getSetting } from '../db';

export interface ErpRecordInput {
  idempotencyKey: string;
  company: { code: string; name: string };
  rfq: Rfq;
  comparison: Comparison;
  /** Names resolved for display, so the adapter does no lookups of its own. */
  providerNames: Record<string, string>;
  workbook: { filename: string; content: Buffer } | null;
  comparisonDate: string;
  /**
   * Which attempt this is, counting from 1, taken from the persisted sync row.
   * The simulated adapter keys its one scripted failure off this rather than a
   * process-local counter, so a restart cannot make it fail twice.
   */
  attempt: number;
}

export interface ErpResult {
  doctype: string;
  remoteName: string;
  remoteUrl: string | null;
  /** True when nothing was written to a real ERPNext instance. */
  simulated: boolean;
  /** True when an existing record was updated rather than a new one created. */
  updatedExisting: boolean;
}

export class ErpFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly setupRequirements: string[] = [],
  ) {
    super(message);
    this.name = 'ErpFailure';
  }
}

export interface ErpStatus {
  label: string;
  kind: 'simulated' | 'live';
  connected: boolean;
  detail: string;
  setupRequirements: string[];
  version?: string;
  lastProbedAt?: string;
}

export interface ErpAdapter {
  status(): ErpStatus;
  probe(): Promise<ErpStatus>;
  /** The comparison outcome. Still available; no longer the primary destination. */
  record(input: ErpRecordInput): Promise<ErpResult>;
  /** One raw quotation. The destination the customer chose. */
  recordQuotation(input: QuotationRecordInput): Promise<ErpResult>;
}

/* ------------------------------- Simulated ---------------------------------- */

/**
 * Records the outcome locally so the whole workflow can be exercised.
 *
 * Its results are always marked `simulated: true` and the UI renders them as
 * "Recorded locally (simulated)" - never as a successful ERPNext write.
 *
 * When `failFirstAttempt` is on (the demonstration dataset turns it on), the
 * first attempt for each comparison fails with a timeout and the retry
 * succeeds. That makes the recoverable-failure path in the demo a real failure
 * and a real retry against real state, rather than a scripted animation.
 */
export class SimulatedErp implements ErpAdapter {
  constructor(private readonly failFirstAttempt = false) {}

  /**
   * Kept for callers that used to clear a process-local counter. The attempt
   * number now comes from the database, so there is nothing to reset.
   */
  static reset(): void {
    /* intentionally empty */
  }

  status(): ErpStatus {
    return {
      label: 'ERPNext simulated',
      kind: 'simulated',
      connected: false,
      detail:
        'Comparison outcomes are recorded in this application only. No ERPNext instance is configured and no request is sent. Nothing here has been written to ERPNext.',
      setupRequirements: [
        'Set ERPNEXT_ADAPTER=live with ERPNEXT_BASE_URL, ERPNEXT_API_KEY and ERPNEXT_API_SECRET.',
        'Confirm the destination DocType on the client instance and set ERPNEXT_DOCTYPE.',
      ],
    };
  }

  async probe(): Promise<ErpStatus> {
    return { ...this.status(), lastProbedAt: new Date().toISOString() };
  }

  async record(input: ErpRecordInput): Promise<ErpResult> {
    const seen = input.attempt;

    if (this.failFirstAttempt && seen === 1) {
      throw new ErpFailure(
        'The ERPNext request timed out after 30 seconds (simulated). Nothing was written. This can be retried safely: the record carries an idempotency key, so a retry will not create a duplicate.',
        true,
      );
    }

    return {
      doctype: 'Freight Comparison (simulated)',
      remoteName: `SIM-${input.rfq.reference}`,
      remoteUrl: null,
      simulated: true,
      updatedExisting: seen > (this.failFirstAttempt ? 2 : 1),
    };
  }

  async recordQuotation(input: QuotationRecordInput): Promise<ErpResult> {
    if (this.failFirstAttempt && input.attempt === 1) {
      throw new ErpFailure(
        'The ERPNext request timed out after 30 seconds (simulated). Nothing was written. This can be retried safely: the record carries an idempotency key, so a retry will not create a duplicate.',
        true,
      );
    }
    return {
      doctype: 'Freight Quotation (simulated)',
      remoteName: `SIM-FQ-${input.rfq.reference}-${input.providerName}-v${input.quote.version}`.replace(/\s+/g, '-'),
      remoteUrl: null,
      simulated: true,
      updatedExisting: input.attempt > (this.failFirstAttempt ? 2 : 1),
    };
  }
}

/* ---------------------------------- Live ------------------------------------ */

interface LiveConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  doctype: string | null;
  /** Where raw quotations go. The destination the customer chose. */
  quotationDoctype: string | null;
  /** Company code here -> exact Company name in ERPNext. Missing codes use the name. */
  companyMap: Record<string, string>;
}

/** ERPNEXT_COMPANY_MAP, e.g. {"MPD":"Mobility Pro Distribution S.A.E."}. */
export function companyMap(): { map: Record<string, string>; error: string | null } {
  const raw = process.env.ERPNEXT_COMPANY_MAP;
  if (!raw) return { map: {}, error: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.values(parsed).every((v) => typeof v === 'string')) {
      return { map: parsed as Record<string, string>, error: null };
    }
  } catch {
    /* reported below */
  }
  return { map: {}, error: 'ERPNEXT_COMPANY_MAP is not a JSON object of company code to ERPNext Company name.' };
}

export function liveConfig(): { config: LiveConfig | null; missing: string[] } {
  const baseUrl = process.env.ERPNEXT_BASE_URL;
  const apiKey = process.env.ERPNEXT_API_KEY;
  const apiSecret = process.env.ERPNEXT_API_SECRET;
  const missing: string[] = [];
  if (!baseUrl) missing.push('ERPNEXT_BASE_URL');
  if (!apiKey) missing.push('ERPNEXT_API_KEY');
  if (!apiSecret) missing.push('ERPNEXT_API_SECRET');
  const companies = companyMap();
  if (companies.error) missing.push(companies.error);
  if (missing.length > 0) return { config: null, missing };
  return {
    config: {
      baseUrl: baseUrl!.replace(/\/+$/, ''),
      apiKey: apiKey!,
      apiSecret: apiSecret!,
      doctype: process.env.ERPNEXT_DOCTYPE || null,
      quotationDoctype: process.env.ERPNEXT_QUOTATION_DOCTYPE || null,
      companyMap: companies.map,
    },
    missing: [],
  };
}

/** The payload written to ERPNext. Kept in one place so the mapping is reviewable. */
export function erpPayload(input: ErpRecordInput): Record<string, unknown> {
  const c = input.comparison;
  const recommended = c.lines.find((l) => l.quoteId === c.recommendedQuoteId) ?? null;
  const cheapest = c.lines.find((l) => l.quoteId === c.cheapestQuoteId) ?? null;

  return {
    // The key the adapter searches on before inserting, so retries are safe.
    freight_idempotency_key: input.idempotencyKey,
    company: input.company.name,
    rfq_reference: input.rfq.reference,
    route: `${input.rfq.originPort} - ${input.rfq.destinationPort}`,
    origin_port: input.rfq.originPort,
    destination_port: input.rfq.destinationPort,
    incoterm: input.rfq.incoterm,
    comparison_date: input.comparisonDate,
    base_currency: c.criteria.baseCurrency,
    offers_received: c.lines.length,
    offers_comparable: c.lines.filter((l) => l.comparable).length,
    // "Recommended" is explicitly not "selected". The team still decides.
    recommendation_status: 'Recommended, not selected',
    recommended_provider: recommended ? input.providerNames[recommended.companyProviderId] ?? null : null,
    recommended_total: recommended?.totalInBaseCurrency ?? null,
    recommended_transit_days: recommended?.transitDays ?? null,
    cheapest_provider: cheapest ? input.providerNames[cheapest.companyProviderId] ?? null : null,
    cheapest_total: cheapest?.totalInBaseCurrency ?? null,
    recommendation_reasons: c.recommendationReasons.join('\n'),
    recommendation_tradeoffs: c.recommendationTradeoffs.join('\n'),
    not_compared_notes: c.blockedNotes.join('\n'),
    ranking_criteria: JSON.stringify(c.criteria),
    fx_rates_applied: JSON.stringify(c.fxRates),
    offers: c.lines.map((l) => ({
      provider: input.providerNames[l.companyProviderId] ?? l.providerName,
      quote_version: l.version,
      comparable: l.comparable ? 1 : 0,
      total_quote_currency: l.totalInQuoteCurrency,
      quote_currency: l.quoteCurrency,
      total_base_currency: l.totalInBaseCurrency,
      transit_days: l.transitDays,
      free_days: l.freeDays,
      valid_until: l.validUntil,
      rank: l.rank,
      score: l.scoreTotal,
    })),
  };
}

/** Fields the child table must have, from the `offers` rows of `erpPayload()`. */
const OFFER_FIELDS = [
  'provider',
  'quote_version',
  'comparable',
  'total_quote_currency',
  'quote_currency',
  'total_base_currency',
  'transit_days',
  'free_days',
  'valid_until',
  'rank',
  'score',
];

interface DocField {
  fieldname: string;
  fieldtype: string;
  options?: string | null;
  unique?: number;
  /** Mandatory. A mandatory charge amount would turn "not stated" into zero. */
  reqd?: number;
}

/**
 * Checks the destination can hold everything `erpPayload()` writes.
 *
 * Frappe silently drops fields a DocType does not have, so without this a
 * write could "succeed" while losing the recommendation or the offers. And the
 * idempotency key must carry a unique index: the lookup-then-write is not
 * atomic, so the index is the real guard against two retries both inserting.
 * Returns the problems found, in plain language; empty means safe to write.
 */
export function destinationProblems(
  doctype: string,
  parentFields: DocField[],
  childFields: DocField[] | null,
  childDoctype: string | null,
): string[] {
  const problems: string[] = [];
  const byName = new Map(parentFields.map((f) => [f.fieldname, f]));

  const key = byName.get('freight_idempotency_key');
  if (!key) {
    problems.push(`"${doctype}" has no freight_idempotency_key field, so a retry could create a duplicate. Add it as a Data field marked Unique.`);
  } else if (!key.unique) {
    problems.push(`freight_idempotency_key on "${doctype}" is not marked Unique. Mark it Unique so ERPNext itself refuses a duplicate.`);
  }

  const payloadFields = Object.keys(erpPayload(EMPTY_INPUT)).filter(
    (k) => k !== 'offers' && k !== 'freight_idempotency_key',
  );
  const missing = payloadFields.filter((k) => !byName.has(k));
  if (missing.length > 0) {
    problems.push(`"${doctype}" is missing ${missing.length} field${missing.length === 1 ? '' : 's'} this application writes, which ERPNext would silently drop: ${missing.join(', ')}.`);
  }

  const offers = byName.get('offers');
  if (!offers || offers.fieldtype !== 'Table') {
    problems.push(`"${doctype}" has no "offers" child table, so the individual offers would be lost.`);
  } else if (!childFields) {
    problems.push(`The child table "${childDoctype ?? offers.options}" behind "offers" could not be read.`);
  } else {
    const childNames = new Set(childFields.map((f) => f.fieldname));
    const childMissing = OFFER_FIELDS.filter((f) => !childNames.has(f));
    if (childMissing.length > 0) {
      problems.push(`The "${childDoctype}" child table is missing: ${childMissing.join(', ')}.`);
    }
  }
  return problems;
}

/**
 * The same guard, for the quotation destination.
 *
 * Frappe silently drops unknown fields, so a DocType missing a column would
 * lose data while reporting success. Checked on every write, not once at setup.
 */
export function quotationDestinationProblems(
  doctype: string,
  parentFields: DocField[],
  childFields: DocField[] | null,
  childDoctype: string | null,
): string[] {
  const problems: string[] = [];
  const byName = new Map(parentFields.map((f) => [f.fieldname, f]));

  const key = byName.get('freight_idempotency_key');
  if (!key) {
    problems.push(`"${doctype}" has no freight_idempotency_key field, so a retry could create a duplicate. Add it as a Data field marked Unique.`);
  } else if (!key.unique) {
    problems.push(`freight_idempotency_key on "${doctype}" is not marked Unique. Mark it Unique so ERPNext itself refuses a duplicate.`);
  }

  const missing = quotationFieldNames().filter(
    (k) => k !== 'charges' && k !== 'freight_idempotency_key' && !byName.has(k),
  );
  if (missing.length > 0) {
    problems.push(`"${doctype}" is missing ${missing.length} field${missing.length === 1 ? '' : 's'} this application writes, which ERPNext would silently drop: ${missing.join(', ')}.`);
  }

  const charges = byName.get('charges');
  if (!charges || charges.fieldtype !== 'Table') {
    problems.push(`"${doctype}" has no "charges" child table, so every surcharge would be lost.`);
  } else if (!childFields) {
    problems.push(`The child table "${childDoctype ?? charges.options}" behind "charges" could not be read.`);
  } else {
    const childNames = new Set(childFields.map((f) => f.fieldname));
    const childMissing = QUOTATION_CHARGE_FIELDS.filter((f) => !childNames.has(f));
    if (childMissing.length > 0) {
      problems.push(`The "${childDoctype}" child table is missing: ${childMissing.join(', ')}.`);
    }
    const amount = childFields.find((f) => f.fieldname === 'amount');
    // A required or defaulted amount turns "the provider did not say" into zero.
    if (amount?.reqd) {
      problems.push(`"amount" on "${childDoctype}" is mandatory. A provider naming a charge without pricing it must be storable as empty, not zero.`);
    }
  }
  return problems;
}

/** A payload skeleton, used only to read the field names `erpPayload()` writes. */
const EMPTY_INPUT = {
  idempotencyKey: '',
  company: { code: '', name: '' },
  rfq: { reference: '', originPort: '', destinationPort: '', incoterm: '' },
  comparison: {
    lines: [],
    recommendedQuoteId: null,
    cheapestQuoteId: null,
    criteria: { baseCurrency: '' },
    recommendationReasons: [],
    recommendationTradeoffs: [],
    blockedNotes: [],
    fxRates: [],
  },
  providerNames: {},
  workbook: null,
  comparisonDate: '',
} as unknown as ErpRecordInput;

export class LiveErp implements ErpAdapter {
  private lastProbe: ErpStatus | null = null;

  constructor(
    private readonly cfg: LiveConfig,
    /** Injected so tests can fake Frappe without touching the network. */
    private readonly http: typeof fetch = fetch,
  ) {}

  private headers(json = true): Record<string, string> {
    return {
      authorization: `token ${this.cfg.apiKey}:${this.cfg.apiSecret}`,
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  private resource(doctype: string, name?: string): string {
    return `${this.cfg.baseUrl}/api/resource/${encodeURIComponent(doctype)}${name ? `/${encodeURIComponent(name)}` : ''}`;
  }

  status(): ErpStatus {
    if (this.lastProbe) return this.lastProbe;
    return {
      label: 'ERPNext configured (not yet checked)',
      kind: 'live',
      connected: false,
      detail: `Configured for ${this.cfg.baseUrl}. The connection has not been checked, so it is not described as connected.`,
      setupRequirements: this.cfg.doctype
        ? []
        : ['Set ERPNEXT_DOCTYPE once the destination DocType has been agreed on the client instance.'],
    };
  }

  async probe(): Promise<ErpStatus> {
    try {
      const res = await this.http(`${this.cfg.baseUrl}/api/method/frappe.auth.get_logged_user`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        this.lastProbe = {
          label: 'ERPNext unavailable',
          kind: 'live',
          connected: false,
          detail: `The instance at ${this.cfg.baseUrl} returned ${res.status} for the authentication check.`,
          setupRequirements: [
            'Check the API key and secret belong to a user with permission on the destination DocType.',
          ],
          lastProbedAt: new Date().toISOString(),
        };
        return this.lastProbe;
      }

      // Confirm the destination can hold the record rather than assuming it.
      // Both destinations are checked, and either one being ready is enough.
      // The raw quotations are the agreed destination; an instance that holds
      // them is usable even where the comparison DocType was never created,
      // and reporting it "not ready" for that would be wrong.
      const requirements: string[] = [];
      const destinationsReady: string[] = [];
      let anyReady = false;

      if (this.cfg.quotationDoctype) {
        const problems = await this.checkQuotationDestination(this.cfg.quotationDoctype);
        if (problems.length === 0) {
          anyReady = true;
          destinationsReady.push(`quotations into "${this.cfg.quotationDoctype}"`);
        } else requirements.push(...problems);
      }
      if (this.cfg.doctype) {
        const problems = await this.checkDestination(this.cfg.doctype);
        if (problems.length === 0) {
          anyReady = true;
          destinationsReady.push(`comparison outcomes into "${this.cfg.doctype}"`);
        } else requirements.push(...problems);
      }
      if (!this.cfg.doctype && !this.cfg.quotationDoctype) {
        requirements.push(
          'Neither ERPNEXT_QUOTATION_DOCTYPE nor ERPNEXT_DOCTYPE is set. Agree the destination DocType before any write is attempted.',
        );
      }

      const ready = anyReady;

      const version = await this.readVersion();
      this.lastProbe = {
        label: ready ? 'ERPNext connected' : 'ERPNext connected, destination not ready',
        kind: 'live',
        connected: true,
        detail: ready
          ? `Connected to ${this.cfg.baseUrl}${version ? ` (ERPNext ${version})` : ''}. Writing to ${destinationsReady.join(' and ')}.`
          : `Connected to ${this.cfg.baseUrl}${version ? ` (ERPNext ${version})` : ''}, but no destination is ready, so no write will be attempted.`,
        // A destination that is ready leaves nothing outstanding for it; only
        // what is still missing is reported.
        setupRequirements: requirements,
        version: version ?? undefined,
        lastProbedAt: new Date().toISOString(),
      };
      return this.lastProbe;
    } catch (err) {
      this.lastProbe = {
        label: 'ERPNext unavailable',
        kind: 'live',
        connected: false,
        detail: err instanceof Error ? err.message : 'The connection check failed.',
        setupRequirements: ['Check network access to the ERPNext instance.'],
        lastProbedAt: new Date().toISOString(),
      };
      return this.lastProbe;
    }
  }

  /** Reads the destination's definition and reports what would stop a safe write. */
  private async checkDestination(doctype: string): Promise<string[]> {
    const meta = await this.http(this.resource('DocType', doctype), { headers: this.headers() });
    if (!meta.ok) {
      return [
        `The DocType "${doctype}" was not found on this instance (${meta.status}). Create it (scripts/erpnext-create-doctype.mjs creates the proposed one), or point ERPNEXT_DOCTYPE at the agreed destination.`,
      ];
    }
    const parent = ((await meta.json()) as { data?: { fields?: DocField[] } }).data?.fields ?? [];
    const table = parent.find((f) => f.fieldname === 'offers' && f.fieldtype === 'Table');
    let child: DocField[] | null = null;
    if (table?.options) {
      const childMeta = await this.http(this.resource('DocType', table.options), { headers: this.headers() });
      if (childMeta.ok) child = ((await childMeta.json()) as { data?: { fields?: DocField[] } }).data?.fields ?? [];
    }
    return destinationProblems(doctype, parent, child, table?.options ?? null);
  }

  private async readVersion(): Promise<string | null> {
    try {
      const res = await this.http(`${this.cfg.baseUrl}/api/method/frappe.utils.change_log.get_versions`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { message?: Record<string, { version?: string }> };
      return data.message?.erpnext?.version ?? null;
    } catch {
      return null;
    }
  }

  async record(input: ErpRecordInput): Promise<ErpResult> {
    if (!this.cfg.doctype) {
      throw new ErpFailure(
        'No ERPNext destination has been agreed yet, so nothing was written. The comparison is held here until the destination DocType is confirmed.',
        false,
        [
          'Inspect the client ERPNext instance and agree where freight comparison outcomes belong.',
          'Create or confirm the DocType, then set ERPNEXT_DOCTYPE.',
        ],
      );
    }
    const doctype = this.cfg.doctype;

    // The guard: verify the destination on every write, not just once. A field
    // removed in ERPNext after setup must stop the write, not lose data.
    const problems = await this.guarded('read the destination DocType', () => this.checkDestination(doctype));
    if (problems.length > 0) {
      throw new ErpFailure(
        `The ERPNext destination "${doctype}" is not ready, so nothing was written.`,
        false,
        problems,
      );
    }

    const payload = {
      ...erpPayload(input),
      company: this.cfg.companyMap[input.company.code] ?? input.company.name,
    };
    let existingName = await this.findExisting(doctype, input.idempotencyKey);
    let updatedExisting = existingName !== null;

    let res = await this.guarded('write the record', () =>
      this.http(existingName ? this.resource(doctype, existingName) : this.resource(doctype), {
        method: existingName ? 'PUT' : 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      }),
    );

    // Two retries raced, and the other one inserted first: ERPNext's unique
    // index refused the second insert. Update the record that won instead.
    if (!existingName && (await isDuplicate(res))) {
      existingName = await this.findExisting(doctype, input.idempotencyKey);
      if (!existingName) {
        throw new ErpFailure('ERPNext reported a duplicate, but the existing record could not be found. Retry shortly.', true);
      }
      updatedExisting = true;
      res = await this.guarded('update the existing record', () =>
        this.http(this.resource(doctype, existingName!), {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify(payload),
        }),
      );
    }

    if (!res.ok) throw await refusal(res);

    const data = (await res.json()) as { data?: { name?: string } };
    const remoteName = data.data?.name ?? existingName ?? input.idempotencyKey;

    if (input.workbook) await this.attach(doctype, remoteName, input.workbook);

    return {
      doctype,
      remoteName,
      remoteUrl: `${this.cfg.baseUrl}/app/${doctype.toLowerCase().replace(/\s+/g, '-')}/${encodeURIComponent(remoteName)}`,
      simulated: false,
      updatedExisting,
    };
  }

  async recordQuotation(input: QuotationRecordInput): Promise<ErpResult> {
    const doctype = this.cfg.quotationDoctype;
    if (!doctype) {
      throw new ErpFailure(
        'No ERPNext destination for quotations has been set, so nothing was written.',
        false,
        [
          'Create the Freight Quotation DocType (scripts/erpnext/freight-quotation-doctype.mjs).',
          'Then set ERPNEXT_QUOTATION_DOCTYPE to its name.',
        ],
      );
    }

    // Verified on every write, not once at setup: a field removed in ERPNext
    // afterwards must stop the write rather than quietly lose a column.
    const problems = await this.guarded('read the quotation DocType', () =>
      this.checkQuotationDestination(doctype),
    );
    if (problems.length > 0) {
      throw new ErpFailure(
        `The ERPNext destination "${doctype}" is not ready, so nothing was written.`,
        false,
        problems,
      );
    }

    const payload = {
      ...quotationPayload(input),
      company: this.cfg.companyMap[input.company.code] ?? input.company.name,
    };

    let existingName = await this.findExisting(doctype, input.idempotencyKey);
    let updatedExisting = existingName !== null;

    let res = await this.guarded('write the quotation', () =>
      this.http(existingName ? this.resource(doctype, existingName) : this.resource(doctype), {
        method: existingName ? 'PUT' : 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      }),
    );

    // Two retries raced and the other inserted first; update the winner.
    if (!existingName && (await isDuplicate(res))) {
      existingName = await this.findExisting(doctype, input.idempotencyKey);
      if (!existingName) {
        throw new ErpFailure(
          'ERPNext reported a duplicate, but the existing record could not be found. Retry shortly.',
          true,
        );
      }
      updatedExisting = true;
      res = await this.guarded('update the existing quotation', () =>
        this.http(this.resource(doctype, existingName!), {
          method: 'PUT',
          headers: this.headers(),
          body: JSON.stringify(payload),
        }),
      );
    }

    if (!res.ok) throw await refusal(res);

    const data = (await res.json()) as { data?: { name?: string } };
    const remoteName = data.data?.name ?? existingName ?? input.idempotencyKey;

    return {
      doctype,
      remoteName,
      remoteUrl: `${this.cfg.baseUrl}/app/${doctype.toLowerCase().replace(/\s+/g, '-')}/${encodeURIComponent(remoteName)}`,
      simulated: false,
      updatedExisting,
    };
  }

  /** Reads the quotation DocType and its charges child table. */
  private async checkQuotationDestination(doctype: string): Promise<string[]> {
    const meta = await this.http(this.resource('DocType', doctype), { headers: this.headers() });
    if (!meta.ok) {
      return [
        `The DocType "${doctype}" was not found on this instance (${meta.status}). Create it with scripts/erpnext/freight-quotation-doctype.mjs, or point ERPNEXT_QUOTATION_DOCTYPE at the agreed destination.`,
      ];
    }
    const parent = ((await meta.json()) as { data?: { fields?: DocField[] } }).data?.fields ?? [];
    const table = parent.find((f) => f.fieldname === 'charges' && f.fieldtype === 'Table');
    let child: DocField[] | null = null;
    if (table?.options) {
      const childMeta = await this.http(this.resource('DocType', table.options), { headers: this.headers() });
      if (childMeta.ok) child = ((await childMeta.json()) as { data?: { fields?: DocField[] } }).data?.fields ?? [];
    }
    return quotationDestinationProblems(doctype, parent, child, table?.options ?? null);
  }

  /**
   * The existing record with this key, if any.
   *
   * A failed lookup stops the write. Inserting blind after a failed lookup is
   * exactly how a retry creates a duplicate.
   */
  private async findExisting(doctype: string, key: string): Promise<string | null> {
    const filters = encodeURIComponent(JSON.stringify([['freight_idempotency_key', '=', key]]));
    const found = await this.guarded('check for an existing record', () =>
      this.http(`${this.resource(doctype)}?filters=${filters}&limit_page_length=1`, { headers: this.headers() }),
    );
    if (!found.ok) {
      throw new ErpFailure(
        `Could not check ERPNext for an existing record (${found.status}), so nothing was written, to avoid a duplicate. Retry shortly.`,
        found.status === 429 || found.status >= 500,
      );
    }
    const data = (await found.json()) as { data?: { name: string }[] };
    return data.data?.[0]?.name ?? null;
  }

  /** Attaches the workbook once. A retry that finds it already attached skips it. */
  private async attach(
    doctype: string,
    name: string,
    workbook: { filename: string; content: Buffer },
  ): Promise<void> {
    const filters = encodeURIComponent(
      JSON.stringify([
        ['attached_to_doctype', '=', doctype],
        ['attached_to_name', '=', name],
        ['file_name', '=', workbook.filename],
      ]),
    );
    const existing = await this.http(`${this.resource('File')}?filters=${filters}&limit_page_length=1`, {
      headers: this.headers(),
    }).catch(() => null);
    if (existing?.ok) {
      const data = (await existing.json()) as { data?: unknown[] };
      if ((data.data?.length ?? 0) > 0) return;
    }

    const form = new FormData();
    form.append('doctype', doctype);
    form.append('docname', name);
    form.append('is_private', '1');
    form.append(
      'file',
      new Blob([new Uint8Array(workbook.content)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      workbook.filename,
    );
    const res = await this.http(`${this.cfg.baseUrl}/api/method/upload_file`, {
      method: 'POST',
      headers: this.headers(false),
      body: form,
    }).catch(() => null);
    if (!res?.ok) {
      // The record itself landed. A retry updates it (same key) and attaches
      // the workbook, so retrying is safe.
      throw new ErpFailure(
        `The comparison record was written as ${name}, but attaching ${workbook.filename} failed${res ? ` (${res.status})` : ''}. Retry: the record will be updated, not duplicated, and the workbook attached.`,
        true,
      );
    }
  }

  /** Turns a network failure into a retryable ErpFailure with a plain reason. */
  private async guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ErpFailure) throw err;
      throw new ErpFailure(
        `Could not reach ERPNext to ${what}: ${err instanceof Error ? err.message : 'network error'}. Nothing further was written; retry shortly.`,
        true,
      );
    }
  }
}

/** Frappe answers a unique-index clash with 409 and a DuplicateEntryError. */
async function isDuplicate(res: Response): Promise<boolean> {
  if (res.ok) return false;
  if (res.status === 409) return true;
  const body = (await res.clone().json().catch(() => ({}))) as { exc_type?: string; exception?: string };
  return /DuplicateEntryError/.test(`${body.exc_type ?? ''} ${body.exception ?? ''}`);
}

async function refusal(res: Response): Promise<ErpFailure> {
  const body = (await res.json().catch(() => ({}))) as { exception?: string; exc_type?: string; _server_messages?: string };
  const retryable = res.status === 429 || res.status >= 500;
  const requirements: string[] = [];
  if (res.status === 403) requirements.push('Grant the API user create and write permission on the destination DocType, and create on File.');
  if (/LinkValidationError/.test(`${body.exc_type ?? ''} ${body.exception ?? ''}`)) {
    requirements.push('A linked record does not exist in ERPNext, most likely the Company. Set ERPNEXT_COMPANY_MAP so each company code maps to the exact ERPNext Company name.');
  }
  return new ErpFailure(
    `ERPNext refused the write (${res.status})${body.exception ? `: ${body.exception}` : ''}.`,
    retryable,
    requirements,
  );
}

/* -------------------------------- Resolution -------------------------------- */

export function resolveErp(): ErpAdapter {
  // The demonstration dataset asks for one recoverable failure so the retry
  // path is exercised for real. Outside the demo this is off.
  const failFirst = getSetting<boolean>('demo.erpFailFirst', false);
  if ((process.env.ERPNEXT_ADAPTER ?? 'simulated') !== 'live') return new SimulatedErp(failFirst);
  const { config } = liveConfig();
  if (!config) return new SimulatedErp(failFirst);
  return new LiveErp(config);
}

export function erpStatusForDisplay(): ErpStatus {
  const requested = process.env.ERPNEXT_ADAPTER ?? 'simulated';
  if (requested !== 'live') return new SimulatedErp().status();
  const { config, missing } = liveConfig();
  if (!config) {
    return {
      label: 'ERPNext simulated (live requested but not configured)',
      kind: 'simulated',
      connected: false,
      detail:
        'ERPNEXT_ADAPTER is set to live, but the credentials are incomplete, so nothing is sent. Outcomes continue to be recorded locally and are labelled as simulated.',
      setupRequirements: missing.map((k) => (k.startsWith('ERPNEXT_') && !k.includes(' ') ? `Set ${k}.` : k)),
    };
  }
  return new LiveErp(config).status();
}
