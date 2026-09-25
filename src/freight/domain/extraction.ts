/**
 * Turning an inbound message into a quotation record.
 *
 * ORDER OF PREFERENCE
 * -------------------
 * A spreadsheet attachment beats a PDF, which beats the email body: a labelled
 * cell is the most reliable source available, and the body is often just
 * "please find attached". Whichever source is used is recorded on the quote, and
 * every field carries the exact cell or line it came from.
 *
 * REVISIONS
 * ---------
 * A second quotation from the same provider on the same RFQ becomes version 2
 * and marks version 1 `superseded`. Nothing is overwritten or deleted, so the
 * earlier offer stays auditable and visible in the quote's history.
 */

import type {
  ContainerType,
  Extracted,
  Id,
  InboundMessage,
  Instant,
  Quote,
  Rfq,
  SourceKind,
  Surcharge,
} from '../types';
import { extractFromText, looksLikeDecline, missing, type TextSource } from '../parsers/text';
import { extractFromCells, readCells, UnreadableFile } from '../parsers/excel';
import { extractPdfText } from '../parsers/pdf';
import { aiExtracted, resolveAi, type AiCall } from '../adapters/ai';
import { readFile, extensionOf } from '../files';

export interface ExtractionOutcome {
  quote: Omit<Quote, 'id' | 'companyId' | 'rfqId' | 'companyProviderId' | 'version' | 'supersedesQuoteId' | 'createdAt'>;
  /** Observability: which parser ran, and any AI call it made. */
  aiCall: AiCall | null;
}

const EMPTY_LIST = (note: string): Extracted<string[]> => missing<string[]>(note);

/** Builds the quote body from whichever source could be read. */
export async function extractQuote(args: {
  message: InboundMessage;
  at: Instant;
}): Promise<ExtractionOutcome> {
  const { message, at } = args;

  if (looksLikeDecline(message.bodyText) && message.attachments.length === 0) {
    return {
      quote: blank({
        status: 'declined',
        sourceKind: 'email_body',
        sourceMessageId: message.id,
        sourceAttachment: null,
        unreadableReason: null,
        extractorId: 'deterministic/decline@1',
        extractedAt: at,
      }),
      aiCall: null,
    };
  }

  // Prefer a spreadsheet, then a PDF, then the body.
  const spreadsheet = message.attachments.find((a) =>
    ['.xlsx', '.xls', '.csv'].includes(extensionOf(a.filename)),
  );
  const pdf = message.attachments.find((a) => extensionOf(a.filename) === '.pdf');

  if (spreadsheet) {
    try {
      const cells = await readCells(readFile(spreadsheet.storageKey), spreadsheet.filename);
      const f = extractFromCells(cells, spreadsheet.filename);
      return {
        quote: blank({
          status: 'needs_review',
          sourceKind: 'excel',
          sourceMessageId: message.id,
          sourceAttachment: spreadsheet.filename,
          unreadableReason: null,
          extractorId: 'deterministic/excel@1',
          extractedAt: at,
          ...f,
          containerBasis: f.containerBasis as Extracted<ContainerType>,
        }),
        aiCall: null,
      };
    } catch (err) {
      if (err instanceof UnreadableFile) {
        return { quote: unreadable(message, spreadsheet.filename, 'excel', err.message, at), aiCall: null };
      }
      throw err;
    }
  }

  if (pdf) {
    try {
      const { text } = await extractPdfText(readFile(pdf.storageKey), pdf.filename);
      const source: TextSource = { label: pdf.filename, text };
      const f = extractFromText(source);
      const withAi = await maybeAssist(f, text, 'pdf_text');
      return {
        quote: blank({
          status: 'needs_review',
          sourceKind: 'pdf_text',
          sourceMessageId: message.id,
          sourceAttachment: pdf.filename,
          unreadableReason: null,
          extractorId: withAi.extractorId,
          extractedAt: at,
          ...withAi.fields,
          originPort: missing<string>('Not stated separately in the PDF.'),
          destinationPort: missing<string>('Not stated separately in the PDF.'),
        }),
        aiCall: withAi.aiCall,
      };
    } catch (err) {
      if (err instanceof UnreadableFile) {
        return { quote: unreadable(message, pdf.filename, 'pdf_text', err.message, at), aiCall: null };
      }
      throw err;
    }
  }

  // An unsupported attachment with no readable alternative must be reported,
  // not quietly ignored in favour of an empty body parse.
  const unsupported = message.attachments.find(
    (a) => !['.xlsx', '.xls', '.csv', '.pdf', '.txt'].includes(extensionOf(a.filename)),
  );
  if (unsupported && message.bodyText.trim().length < 80) {
    return {
      quote: unreadable(
        message,
        unsupported.filename,
        'email_body',
        `${unsupported.filename} is not a supported quotation format, and the email body does not contain the figures. Open the attachment and enter the quotation by hand.`,
        at,
      ),
      aiCall: null,
    };
  }

  const source: TextSource = { label: 'email body', text: message.bodyText };
  const f = extractFromText(source);
  const withAi = await maybeAssist(f, message.bodyText, 'email_body');
  return {
    quote: blank({
      status: 'needs_review',
      sourceKind: 'email_body',
      sourceMessageId: message.id,
      sourceAttachment: null,
      unreadableReason: null,
      extractorId: withAi.extractorId,
      extractedAt: at,
      ...withAi.fields,
      originPort: missing<string>('Not stated separately in the email.'),
      destinationPort: missing<string>('Not stated separately in the email.'),
    }),
    aiCall: withAi.aiCall,
  };
}

type TextFields = ReturnType<typeof extractFromText>;

/**
 * Consults the AI boundary only when the deterministic pass came back sparse,
 * and only ever fills fields that are still empty.
 */
async function maybeAssist(
  f: TextFields,
  text: string,
  _kind: SourceKind,
): Promise<{ fields: Omit<TextFields, 'sparse'>; extractorId: string; aiCall: AiCall | null }> {
  const { sparse, ...fields } = f;
  const ai = resolveAi();
  if (!sparse || !ai.status().enabled) {
    return { fields, extractorId: 'deterministic/text@1', aiCall: null };
  }

  const result = await ai.readQuote(text);
  const model = result.call.model;
  const merged = { ...fields };

  const fill = <K extends keyof AiFillable>(key: K, value: AiFillable[K]) => {
    if (value === undefined || value === null) return;
    const current = merged[key as keyof typeof merged] as Extracted<unknown> | undefined;
    // Never overwrite something a deterministic parser actually read.
    if (current && current.value !== null) return;
    (merged as Record<string, unknown>)[key as string] = aiExtracted(value, model);
  };

  fill('shippingLine', result.fields.shippingLine ?? undefined);
  fill('currency', result.fields.currency ?? undefined);
  fill('containerBasis', (result.fields.containerBasis as ContainerType | undefined) ?? undefined);
  fill('baseFreight', result.fields.baseFreight ?? undefined);
  fill('totalQuoted', result.fields.totalQuoted ?? undefined);
  fill('transitDays', result.fields.transitDays ?? undefined);
  fill('freeDaysDestination', result.fields.freeDaysDestination ?? undefined);
  fill('validUntil', result.fields.validUntil ?? undefined);
  fill('sailingDate', result.fields.sailingDate ?? undefined);
  fill('paymentTerms', result.fields.paymentTerms ?? undefined);

  return {
    fields: merged,
    extractorId: `deterministic/text@1+ai/${result.call.adapter}`,
    aiCall: result.call,
  };
}

interface AiFillable {
  shippingLine: string;
  currency: string;
  containerBasis: ContainerType;
  baseFreight: number;
  totalQuoted: number;
  transitDays: number;
  freeDaysDestination: number;
  validUntil: string;
  sailingDate: string;
  paymentTerms: string;
}

type QuoteBody = ExtractionOutcome['quote'];

/** A quote with every field empty, overridden by whatever was extracted. */
function blank(over: Partial<QuoteBody>): QuoteBody {
  const base: QuoteBody = {
    status: 'needs_review',
    sourceKind: 'manual',
    sourceMessageId: null,
    sourceAttachment: null,
    unreadableReason: null,
    shippingLine: missing<string>('Not stated.'),
    originPort: missing<string>('Not stated.'),
    destinationPort: missing<string>('Not stated.'),
    currency: missing<string>('Not stated.'),
    containerBasis: missing<ContainerType>('Not stated.'),
    baseFreight: missing<number>('Not stated.'),
    surcharges: [] as Surcharge[],
    totalQuoted: missing<number>('Not stated.'),
    transitDays: missing<number>('Not stated.'),
    freeDaysDestination: missing<number>('Not stated.'),
    validUntil: missing<string>('Not stated.'),
    sailingDate: missing<string>('Not stated.'),
    paymentTerms: missing<string>('Not stated.'),
    inclusions: EMPTY_LIST('Not stated.'),
    exclusions: EMPTY_LIST('Not stated.'),
    conditions: EMPTY_LIST('Not stated.'),
    extractorId: 'none',
    extractedAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
  };
  return { ...base, ...over };
}

function unreadable(
  message: InboundMessage,
  filename: string,
  kind: SourceKind,
  reason: string,
  at: Instant,
): QuoteBody {
  return blank({
    status: 'unreadable',
    sourceKind: kind,
    sourceMessageId: message.id,
    sourceAttachment: filename,
    unreadableReason: reason,
    extractorId: 'deterministic/unreadable@1',
    extractedAt: at,
  });
}

/**
 * Applies a reviewer's correction.
 *
 * The corrected value replaces the machine's reading, is stamped with who
 * changed it and when, and is promoted to high confidence - a person looked at
 * the source. The original machine reading stays in the audit trail.
 */
export function correctField<T>(
  field: Extracted<T>,
  value: T | null,
  userId: Id,
  at: Instant,
): Extracted<T> {
  return {
    ...field,
    value,
    confidence: value === null ? 'missing' : 'high',
    correctedBy: userId,
    correctedAt: at,
    note: value === null ? 'Marked as not stated by a reviewer.' : 'Confirmed by a reviewer against the source.',
  };
}

/** True when anything on the quote still needs a human to look at it. */
export function needsAttention(q: Quote): boolean {
  if (q.status === 'unreadable') return true;
  if (q.status !== 'needs_review') return false;
  return true;
}

/** Fields a reviewer should look at first: missing or low-confidence. */
export function uncertainFields(q: Quote): string[] {
  const out: string[] = [];
  const check = (label: string, f: Extracted<unknown>) => {
    if (f.value === null) out.push(`${label} is not stated`);
    else if (f.confidence === 'low' || f.confidence === 'medium') out.push(`${label} needs checking`);
  };
  check('Base freight', q.baseFreight);
  check('Currency', q.currency);
  check('Rate basis', q.containerBasis);
  check('Transit time', q.transitDays);
  check('Validity', q.validUntil);
  for (const s of q.surcharges) {
    if (s.amount === null) out.push(`${s.label} has no amount`);
  }
  return out;
}

export { UnreadableFile };
