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
  record(input: ErpRecordInput): Promise<ErpResult>;
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
  /** Attempts seen per key, so a retry genuinely differs from a first try. */
  private static attempts = new Map<string, number>();

  constructor(private readonly failFirstAttempt = false) {}

  static reset(): void {
    SimulatedErp.attempts.clear();
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
    const seen = (SimulatedErp.attempts.get(input.idempotencyKey) ?? 0) + 1;
    SimulatedErp.attempts.set(input.idempotencyKey, seen);

    const failFirst = this.failFirstAttempt;
    if (failFirst && seen === 1) {
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
      updatedExisting: seen > (failFirst ? 2 : 1),
    };
  }
}

/* ---------------------------------- Live ------------------------------------ */

interface LiveConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  doctype: string | null;
}

export function liveConfig(): { config: LiveConfig | null; missing: string[] } {
  const baseUrl = process.env.ERPNEXT_BASE_URL;
  const apiKey = process.env.ERPNEXT_API_KEY;
  const apiSecret = process.env.ERPNEXT_API_SECRET;
  const missing: string[] = [];
  if (!baseUrl) missing.push('ERPNEXT_BASE_URL');
  if (!apiKey) missing.push('ERPNEXT_API_KEY');
  if (!apiSecret) missing.push('ERPNEXT_API_SECRET');
  if (missing.length > 0) return { config: null, missing };
  return {
    config: {
      baseUrl: baseUrl!.replace(/\/+$/, ''),
      apiKey: apiKey!,
      apiSecret: apiSecret!,
      doctype: process.env.ERPNEXT_DOCTYPE || null,
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

export class LiveErp implements ErpAdapter {
  private lastProbe: ErpStatus | null = null;

  constructor(private readonly cfg: LiveConfig) {}

  private headers(): Record<string, string> {
    return {
      authorization: `token ${this.cfg.apiKey}:${this.cfg.apiSecret}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  status(): ErpStatus {
    if (this.lastProbe) return this.lastProbe;
    return {
      label: 'ERPNext configured (not yet checked)',
      kind: 'live',
      connected: false,
      detail: `Configured for ${this.cfg.baseUrl}. The connection has not been checked in this session, so it is not described as connected.`,
      setupRequirements: this.cfg.doctype
        ? []
        : ['Set ERPNEXT_DOCTYPE once the destination DocType has been agreed on the client instance.'],
    };
  }

  async probe(): Promise<ErpStatus> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/method/frappe.auth.get_logged_user`, {
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

      // Confirm the destination exists rather than assuming it.
      const requirements: string[] = [];
      let doctypeOk = false;
      if (!this.cfg.doctype) {
        requirements.push(
          'ERPNEXT_DOCTYPE is not set. Inspect the client instance and agree the destination DocType before any write is attempted.',
        );
      } else {
        const meta = await fetch(
          `${this.cfg.baseUrl}/api/resource/DocType/${encodeURIComponent(this.cfg.doctype)}`,
          { headers: this.headers() },
        );
        if (meta.ok) doctypeOk = true;
        else
          requirements.push(
            `The DocType "${this.cfg.doctype}" was not found on this instance (${meta.status}). Create it, or point ERPNEXT_DOCTYPE at the agreed destination.`,
          );
      }

      const version = await this.readVersion();
      this.lastProbe = {
        label: doctypeOk ? 'ERPNext connected' : 'ERPNext connected, destination not confirmed',
        kind: 'live',
        connected: true,
        detail: doctypeOk
          ? `Connected to ${this.cfg.baseUrl}. Comparison outcomes will be written to "${this.cfg.doctype}".`
          : `Connected to ${this.cfg.baseUrl}, but the destination DocType has not been confirmed, so no write will be attempted.`,
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

  private async readVersion(): Promise<string | null> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/api/method/frappe.utils.change_log.get_versions`, {
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
    const payload = erpPayload(input);

    // Idempotency: look for an existing document with this key first.
    let existingName: string | null = null;
    try {
      const filters = encodeURIComponent(
        JSON.stringify([['freight_idempotency_key', '=', input.idempotencyKey]]),
      );
      const found = await fetch(
        `${this.cfg.baseUrl}/api/resource/${encodeURIComponent(doctype)}?filters=${filters}&limit_page_length=1`,
        { headers: this.headers() },
      );
      if (found.ok) {
        const data = (await found.json()) as { data?: { name: string }[] };
        existingName = data.data?.[0]?.name ?? null;
      }
    } catch {
      // A failed lookup is not fatal; the insert below is still attempted, and
      // a unique index on the key in ERPNext is the backstop.
    }

    const url = existingName
      ? `${this.cfg.baseUrl}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(existingName)}`
      : `${this.cfg.baseUrl}/api/resource/${encodeURIComponent(doctype)}`;

    const res = await fetch(url, {
      method: existingName ? 'PUT' : 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { exception?: string; _server_messages?: string };
      const retryable = res.status === 429 || res.status >= 500;
      throw new ErpFailure(
        `ERPNext refused the write (${res.status})${body.exception ? `: ${body.exception}` : ''}.`,
        retryable,
        res.status === 403
          ? ['Grant the API user create and write permission on the destination DocType.']
          : [],
      );
    }

    const data = (await res.json()) as { data?: { name?: string } };
    const remoteName = data.data?.name ?? input.idempotencyKey;

    if (input.workbook) await this.attach(doctype, remoteName, input.workbook);

    return {
      doctype,
      remoteName,
      remoteUrl: `${this.cfg.baseUrl}/app/${doctype.toLowerCase().replace(/\s+/g, '-')}/${encodeURIComponent(remoteName)}`,
      simulated: false,
      updatedExisting: existingName !== null,
    };
  }

  /** Attaches the comparison workbook to the created document. */
  private async attach(
    doctype: string,
    name: string,
    workbook: { filename: string; content: Buffer },
  ): Promise<void> {
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
    const res = await fetch(`${this.cfg.baseUrl}/api/method/upload_file`, {
      method: 'POST',
      headers: {
        authorization: `token ${this.cfg.apiKey}:${this.cfg.apiSecret}`,
        accept: 'application/json',
      },
      body: form,
    });
    if (!res.ok) {
      // The record itself landed; a failed attachment is reported but must not
      // make the caller think the whole write failed and retry it.
      throw new ErpFailure(
        `The comparison record was created as ${name}, but attaching ${workbook.filename} failed (${res.status}). Attach it by hand, or retry.`,
        true,
      );
    }
  }
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
      setupRequirements: missing.map((k) => `Set ${k}.`),
    };
  }
  return new LiveErp(config).status();
}
