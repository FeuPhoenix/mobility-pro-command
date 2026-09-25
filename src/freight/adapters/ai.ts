/**
 * AI assistance boundary for quote extraction.
 *
 * WHERE AI IS AND IS NOT USED
 * ---------------------------
 * Deterministic parsing does the work. This boundary exists for one narrow job:
 * a quotation written as free prose ("we can offer you twelve hundred dollars
 * all in on the forty foot, sailing the third week of November"), where a regex
 * over labelled lines finds nothing.
 *
 * It is bounded deliberately:
 *   - It is only consulted when the deterministic pass came back sparse.
 *   - It may only fill fields that are still empty. It can never overwrite a
 *     value read from a labelled line or a spreadsheet cell.
 *   - Everything it returns is marked `low` confidence, so the value always
 *     lands in the review queue in front of a human before it can be compared.
 *   - It is off by default. With AI_ADAPTER unset, the app is fully functional
 *     and no text leaves the machine.
 *   - Every call is logged with its model, token usage and latency.
 *
 * NOT VERIFIED LIVE: the Anthropic path is written but was not exercised
 * against the API from this environment - no API key was available, and the
 * brief forbids incurring paid usage without authorisation.
 */

import type { Confidence, Extracted } from '../types';

export interface AiFields {
  shippingLine?: string | null;
  currency?: string | null;
  containerBasis?: string | null;
  baseFreight?: number | null;
  totalQuoted?: number | null;
  transitDays?: number | null;
  freeDaysDestination?: number | null;
  validUntil?: string | null;
  sailingDate?: string | null;
  paymentTerms?: string | null;
}

export interface AiCall {
  adapter: string;
  model: string | null;
  promptChars: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
  error: string | null;
}

export interface AiResult {
  fields: AiFields;
  call: AiCall;
}

export interface AiStatus {
  label: string;
  enabled: boolean;
  detail: string;
  setupRequirements: string[];
}

export interface AiAssist {
  status(): AiStatus;
  /** Returns only the fields it could read. Absent keys mean "did not find". */
  readQuote(text: string): Promise<AiResult>;
}

/** The default. Does nothing, and says so. */
export class DisabledAi implements AiAssist {
  status(): AiStatus {
    return {
      label: 'AI assistance off',
      enabled: false,
      detail:
        'Quotations are read by the deterministic parsers only. No quotation text leaves this machine. Anything the parsers cannot read is flagged for manual entry rather than guessed.',
      setupRequirements: ['Set AI_ADAPTER=anthropic and ANTHROPIC_API_KEY to enable prose fallback.'],
    };
  }

  async readQuote(text: string): Promise<AiResult> {
    return {
      fields: {},
      call: {
        adapter: 'disabled',
        model: null,
        promptChars: text.length,
        latencyMs: 0,
        inputTokens: null,
        outputTokens: null,
        ok: true,
        error: null,
      },
    };
  }
}

const SYSTEM_PROMPT = `You read freight quotations and return structured data.

Rules you must follow exactly:
- Only report a value that is explicitly stated in the text. Never estimate, never infer a market rate, never complete a partial figure.
- If a field is not stated, omit the key entirely. Do not use 0, "unknown" or null as a placeholder for a value you did not find.
- Amounts must be plain numbers with no currency symbol, thousands separator or unit.
- Dates must be YYYY-MM-DD. Only report a date if the year is unambiguous.
- containerBasis must be one of 20GP, 40GP, 40HC, 45HC, 20RF, 40RF, LCL.
- transitDays and freeDaysDestination are whole numbers of days. For a range, report the longer figure.

Return only a JSON object with the keys you found, and nothing else.`;

/** Live Anthropic implementation. Bounded, logged, and low-confidence by design. */
export class AnthropicAi implements AiAssist {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  status(): AiStatus {
    return {
      label: `AI assistance on (${this.model})`,
      enabled: true,
      detail:
        'Quotations that the deterministic parsers cannot read are also sent to the model. Anything it returns is marked low confidence and must be checked by a person before it can be compared. It can never overwrite a value read from a labelled line or a spreadsheet cell.',
      setupRequirements: [],
    };
  }

  async readQuote(text: string): Promise<AiResult> {
    // Bound the prompt so a pathological attachment cannot run up a large call.
    const prompt = text.slice(0, 12_000);
    const started = Date.now();
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return {
          fields: {},
          call: {
            adapter: 'anthropic',
            model: this.model,
            promptChars: prompt.length,
            latencyMs,
            inputTokens: null,
            outputTokens: null,
            ok: false,
            error: `The model API returned ${res.status}.`,
          },
        };
      }
      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const body = (data.content ?? []).find((c) => c.type === 'text')?.text ?? '';
      return {
        fields: safeParseFields(body),
        call: {
          adapter: 'anthropic',
          model: this.model,
          promptChars: prompt.length,
          latencyMs,
          inputTokens: data.usage?.input_tokens ?? null,
          outputTokens: data.usage?.output_tokens ?? null,
          ok: true,
          error: null,
        },
      };
    } catch (err) {
      return {
        fields: {},
        call: {
          adapter: 'anthropic',
          model: this.model,
          promptChars: prompt.length,
          latencyMs: Date.now() - started,
          inputTokens: null,
          outputTokens: null,
          ok: false,
          error: err instanceof Error ? err.message : 'The model call failed.',
        },
      };
    }
  }
}

/** Parses the model's reply defensively: a bad reply yields no fields, not a crash. */
export function safeParseFields(body: string): AiFields {
  const match = /\{[\s\S]*\}/.exec(body);
  if (!match) return {};
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
  const out: AiFields = {};
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
  const date = (v: unknown): string | undefined =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined;

  if (text(raw.shippingLine)) out.shippingLine = text(raw.shippingLine);
  if (text(raw.currency)) out.currency = text(raw.currency)!.toUpperCase().slice(0, 3);
  if (text(raw.containerBasis)) out.containerBasis = text(raw.containerBasis)!.toUpperCase().replace(/\s+/g, '');
  if (num(raw.baseFreight) !== undefined) out.baseFreight = num(raw.baseFreight);
  if (num(raw.totalQuoted) !== undefined) out.totalQuoted = num(raw.totalQuoted);
  if (num(raw.transitDays) !== undefined) out.transitDays = Math.round(num(raw.transitDays)!);
  if (num(raw.freeDaysDestination) !== undefined)
    out.freeDaysDestination = Math.round(num(raw.freeDaysDestination)!);
  if (date(raw.validUntil)) out.validUntil = date(raw.validUntil);
  if (date(raw.sailingDate)) out.sailingDate = date(raw.sailingDate);
  if (text(raw.paymentTerms)) out.paymentTerms = text(raw.paymentTerms);
  return out;
}

export function resolveAi(): AiAssist {
  if ((process.env.AI_ADAPTER ?? 'heuristic') !== 'anthropic') return new DisabledAi();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return new DisabledAi();
  return new AnthropicAi(key, process.env.AI_MODEL ?? 'claude-sonnet-5');
}

export function aiStatusForDisplay(): AiStatus {
  const requested = process.env.AI_ADAPTER ?? 'heuristic';
  if (requested !== 'anthropic') return new DisabledAi().status();
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      label: 'AI assistance off (requested but no key)',
      enabled: false,
      detail:
        'AI_ADAPTER is set to anthropic but ANTHROPIC_API_KEY is not set, so the deterministic parsers are being used on their own.',
      setupRequirements: ['Set ANTHROPIC_API_KEY.'],
    };
  }
  return new AnthropicAi(process.env.ANTHROPIC_API_KEY, process.env.AI_MODEL ?? 'claude-sonnet-5').status();
}

/** Wraps an AI-sourced value with the provenance the reviewer needs to see. */
export function aiExtracted<T>(value: T, model: string | null): Extracted<T> {
  const confidence: Confidence = 'low';
  return {
    value,
    confidence,
    sourceRef: `AI assist${model ? ` (${model})` : ''}`,
    sourceText: null,
    correctedBy: null,
    correctedAt: null,
    note: 'Read from prose by the AI assistant, not from a labelled line. Check it against the original before relying on it.',
  };
}
