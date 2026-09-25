/**
 * Excel quotation reading.
 *
 * Providers do not share one template, so this does not assume a fixed layout.
 * It walks every cell looking for a recognised label and reads the nearest
 * value to its right (or below, when the sheet is laid out vertically). Each
 * value carries the exact cell it came from - "Quote.xlsx!Sheet1!C7" - so a
 * reviewer can check it without opening the file.
 *
 * A charge row whose amount cell is blank, or says TBA, yields `null`. It is
 * never read as zero.
 */

import ExcelJS from 'exceljs';
import type { ChargeBasis, Confidence, ContainerType, Extracted, Surcharge } from '../types';
import { parseAmount, parseContainerType, parseDate, parseDays } from './text';

export interface SheetCell {
  sheet: string;
  row: number;
  col: number;
  text: string;
  /** The typed value when ExcelJS gave us a number or date rather than text. */
  numeric: number | null;
  date: Date | null;
}

export class UnreadableFile extends Error {}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: string; result?: unknown; formula?: string };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (typeof v.text === 'string') return v.text;
    if (v.result !== undefined && v.result !== null) return String(v.result);
  }
  return '';
}

export async function readCells(buffer: Buffer, filename: string): Promise<SheetCell[]> {
  const wb = new ExcelJS.Workbook();
  try {
    if (filename.toLowerCase().endsWith('.csv')) {
      // ExcelJS reads CSV from a stream; a Buffer is wrapped for it.
      const { Readable } = await import('node:stream');
      await wb.csv.read(Readable.from(buffer.toString('utf8')));
    } else {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    }
  } catch (err) {
    throw new UnreadableFile(
      `${filename} could not be opened as a spreadsheet${err instanceof Error && err.message ? ` (${err.message})` : ''}. If it is a scanned or password-protected file, the figures have to be entered by hand.`,
    );
  }

  const cells: SheetCell[] = [];
  wb.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const text = cellText(cell.value).trim();
        if (!text) return;
        cells.push({
          sheet: sheet.name,
          row: rowNumber,
          col: colNumber,
          text,
          numeric: typeof cell.value === 'number' ? cell.value : null,
          date: cell.value instanceof Date ? cell.value : null,
        });
      });
    });
  });
  if (cells.length === 0) {
    throw new UnreadableFile(`${filename} contains no readable cells.`);
  }
  return cells;
}

export function cellRef(filename: string, c: SheetCell): string {
  return `${filename}!${c.sheet}!${columnLetter(c.col)}${c.row}`;
}

function columnLetter(col: number): string {
  let n = col;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The cell immediately right of `c` on the same row, skipping blanks. */
function rightOf(cells: SheetCell[], c: SheetCell): SheetCell | null {
  return (
    cells
      .filter((x) => x.sheet === c.sheet && x.row === c.row && x.col > c.col)
      .sort((a, b) => a.col - b.col)[0] ?? null
  );
}

/** The cell immediately below `c`, used for sheets laid out in columns. */
function below(cells: SheetCell[], c: SheetCell): SheetCell | null {
  return (
    cells
      .filter((x) => x.sheet === c.sheet && x.col === c.col && x.row > c.row)
      .sort((a, b) => a.row - b.row)[0] ?? null
  );
}

function findLabel(cells: SheetCell[], pattern: RegExp): SheetCell | null {
  return cells.find((c) => pattern.test(c.text)) ?? null;
}

/** Label cell plus the value cell next to it. */
function labelled(
  cells: SheetCell[],
  pattern: RegExp,
): { label: SheetCell; value: SheetCell } | null {
  const label = findLabel(cells, pattern);
  if (!label) return null;
  // A label cell can also carry its own value ("Transit time: 21 days").
  const inline = label.text.replace(pattern, '').replace(/^[\s:=-]+/, '').trim();
  if (inline.length > 0) return { label, value: { ...label, text: inline } };
  const value = rightOf(cells, label) ?? below(cells, label);
  return value ? { label, value } : null;
}

function make<T>(
  value: T | null,
  confidence: Confidence,
  filename: string,
  cell: SheetCell | null,
  note: string | null = null,
): Extracted<T> {
  return {
    value,
    confidence,
    sourceRef: cell ? cellRef(filename, cell) : null,
    sourceText: cell ? cell.text : null,
    correctedBy: null,
    correctedAt: null,
    note,
  };
}

function absent<T>(note: string): Extracted<T> {
  return { value: null, confidence: 'missing', sourceRef: null, sourceText: null, correctedBy: null, correctedAt: null, note };
}

const SURCHARGE_LABELS: { code: string; label: string; pattern: RegExp; basis: ChargeBasis }[] = [
  { code: 'BAF', label: 'Bunker adjustment factor', pattern: /^\s*(BAF|bunker)/i, basis: 'per_container' },
  { code: 'CAF', label: 'Currency adjustment factor', pattern: /^\s*(CAF|currency adjust)/i, basis: 'per_container' },
  { code: 'THC-ORIGIN', label: 'Terminal handling (origin)', pattern: /(origin.*THC|THC.*origin|OTHC)/i, basis: 'per_container' },
  { code: 'THC-DEST', label: 'Terminal handling (destination)', pattern: /(destination.*THC|THC.*destination|DTHC)/i, basis: 'per_container' },
  { code: 'THC', label: 'Terminal handling', pattern: /^\s*THC\b/i, basis: 'per_container' },
  { code: 'ISPS', label: 'Security (ISPS)', pattern: /^\s*(ISPS|security)/i, basis: 'per_container' },
  { code: 'DOC', label: 'Documentation', pattern: /(documentation|doc fee|b\/?l fee)/i, basis: 'per_bl' },
  { code: 'SEAL', label: 'Seal fee', pattern: /seal/i, basis: 'per_container' },
  { code: 'CUSTOMS', label: 'Customs clearance', pattern: /(customs|clearance)/i, basis: 'per_shipment' },
  { code: 'PSS', label: 'Peak season surcharge', pattern: /^\s*(PSS|peak season)/i, basis: 'per_container' },
  { code: 'WAR', label: 'War risk / transit disruption', pattern: /(war risk|transit disruption|red sea|contingency)/i, basis: 'per_container' },
];

const NO_AMOUNT = /^\s*(TBA|TBC|to be advised|on request|at cost|-|n\/?a)\s*$/i;

function basisFrom(text: string): ChargeBasis | null {
  if (/per\s*(container|ctr|box|unit|20|40|45)/i.test(text)) return 'per_container';
  if (/per\s*(shipment|booking)/i.test(text)) return 'per_shipment';
  if (/per\s*(b\/?l|bill of lading|set)/i.test(text)) return 'per_bl';
  if (/per\s*cbm/i.test(text)) return 'per_cbm';
  if (/per\s*(tonne|ton|mt)\b/i.test(text)) return 'per_tonne';
  return null;
}

export interface ExcelExtraction {
  shippingLine: Extracted<string>;
  originPort: Extracted<string>;
  destinationPort: Extracted<string>;
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
}

export function extractFromCells(cells: SheetCell[], filename: string): ExcelExtraction {
  const num = (c: SheetCell): number | null =>
    c.numeric !== null ? c.numeric : parseAmount(c.text).amount;

  const lineHit = labelled(cells, /^\s*(shipping line|carrier|ocean carrier|line)\s*:?\s*$/i);
  const originHit = labelled(cells, /^\s*(origin|port of loading|pol|from)\s*:?\s*$/i);
  const destHit = labelled(cells, /^\s*(destination|port of discharge|pod|to)\s*:?\s*$/i);
  const freightHit = labelled(cells, /^\s*(base (ocean )?freight|ocean freight|basic freight|freight)\s*:?\s*$/i);
  const totalHit = labelled(cells, /^\s*(total|all[- ]in|grand total|total cost)\s*:?\s*$/i);
  const transitHit = labelled(cells, /^\s*(transit(\s*time)?|t\/?t)\s*:?\s*$/i);
  const freeHit = labelled(cells, /^\s*(free days|free time|detention free)\s*:?\s*$/i);
  const validHit = labelled(cells, /^\s*(valid(ity)?( until| to)?|rate valid|expiry)\s*:?\s*$/i);
  const sailHit = labelled(cells, /^\s*(sailing( date)?|etd|departure)\s*:?\s*$/i);
  const payHit = labelled(cells, /^\s*(payment( terms)?)\s*:?\s*$/i);
  const currencyHit = labelled(cells, /^\s*(currency|ccy)\s*:?\s*$/i);
  const basisHit = labelled(cells, /^\s*(container|equipment|rate basis|basis|per)\s*:?\s*$/i);
  const incHit = labelled(cells, /^\s*(inclusions?|includes?|included)\s*:?\s*$/i);
  const excHit = labelled(cells, /^\s*(exclusions?|excludes?|excluded)\s*:?\s*$/i);
  const condHit = labelled(cells, /^\s*(conditions?|remarks?|notes?)\s*:?\s*$/i);

  const freightAmount = freightHit ? num(freightHit.value) : null;
  const freightCurrency = freightHit ? parseAmount(freightHit.value.text).currency : null;

  const currencyValue =
    (currencyHit ? currencyHit.value.text.trim().toUpperCase().slice(0, 3) : null) ?? freightCurrency;

  const basisText = basisHit ? basisHit.value.text : (freightHit?.label.text ?? '');
  const basisValue = parseContainerType(basisText) ?? (freightHit ? parseContainerType(freightHit.label.text) : null);

  // Surcharge rows: a recognised label anywhere in column A-ish, amount to its right.
  const surcharges: Surcharge[] = [];
  const seen = new Set<string>();
  for (const c of cells) {
    for (const p of SURCHARGE_LABELS) {
      if (!p.pattern.test(c.text) || seen.has(p.code)) continue;
      // Skip the header row of a charges table.
      if (/^\s*(charge|description|item)\s*$/i.test(c.text)) continue;
      seen.add(p.code);
      const valueCell = rightOf(cells, c);
      const blank = !valueCell || NO_AMOUNT.test(valueCell.text);
      const amount = blank ? null : (valueCell.numeric ?? parseAmount(valueCell.text).amount);
      const currency = blank ? null : (parseAmount(valueCell.text).currency ?? currencyValue);
      surcharges.push({
        code: p.code,
        label: p.label,
        amount,
        currency: amount === null ? null : currency,
        basis: basisFrom(c.text) ?? basisFrom(valueCell?.text ?? '') ?? p.basis,
        sourceRef: cellRef(filename, valueCell ?? c),
        confidence: amount === null ? 'missing' : 'high',
      });
    }
  }

  const splitList = (s: string) =>
    s.split(/[,;\n]/).map((x) => x.trim()).filter((x) => x.length > 1);

  return {
    shippingLine: lineHit
      ? make(lineHit.value.text, 'high', filename, lineHit.value)
      : absent('No shipping line cell was found.'),
    originPort: originHit
      ? make(originHit.value.text, 'high', filename, originHit.value)
      : absent('No origin port cell was found.'),
    destinationPort: destHit
      ? make(destHit.value.text, 'high', filename, destHit.value)
      : absent('No destination port cell was found.'),
    currency: currencyValue
      ? make(currencyValue, currencyHit ? 'high' : 'medium', filename, currencyHit?.value ?? freightHit?.value ?? null,
          currencyHit ? null : 'Read from the freight amount rather than a currency cell.')
      : absent('No currency was stated.'),
    containerBasis: basisValue
      ? make(basisValue, 'high', filename, basisHit?.value ?? freightHit?.label ?? null)
      : absent('The sheet does not say which container type the rate applies to.'),
    baseFreight:
      freightAmount !== null
        ? make(freightAmount, 'high', filename, freightHit!.value)
        : absent('No base freight amount was found.'),
    totalQuoted:
      totalHit && num(totalHit.value) !== null
        ? make(num(totalHit.value), 'high', filename, totalHit.value)
        : absent('The sheet does not state a total.'),
    transitDays:
      transitHit && (transitHit.value.numeric ?? parseDays(transitHit.value.text)) !== null
        ? make(transitHit.value.numeric ?? parseDays(transitHit.value.text), 'high', filename, transitHit.value)
        : absent('No transit time was found.'),
    freeDaysDestination:
      freeHit && (freeHit.value.numeric ?? parseDays(freeHit.value.text)) !== null
        ? make(freeHit.value.numeric ?? parseDays(freeHit.value.text), 'high', filename, freeHit.value)
        : absent('No free days were found.'),
    validUntil:
      validHit && (validHit.value.date ?? parseDate(validHit.value.text))
        ? make(
            validHit.value.date ? validHit.value.date.toISOString().slice(0, 10) : parseDate(validHit.value.text),
            'high',
            filename,
            validHit.value,
          )
        : absent('No validity date was found.'),
    sailingDate:
      sailHit && (sailHit.value.date ?? parseDate(sailHit.value.text))
        ? make(
            sailHit.value.date ? sailHit.value.date.toISOString().slice(0, 10) : parseDate(sailHit.value.text),
            'high',
            filename,
            sailHit.value,
          )
        : absent('No sailing date was found.'),
    paymentTerms: payHit
      ? make(payHit.value.text, 'high', filename, payHit.value)
      : absent('No payment terms were found.'),
    inclusions: incHit
      ? make(splitList(incHit.value.text), 'medium', filename, incHit.value)
      : absent('Nothing was listed as included.'),
    exclusions: excHit
      ? make(splitList(excHit.value.text), 'medium', filename, excHit.value)
      : absent('Nothing was listed as excluded.'),
    conditions: condHit
      ? make(splitList(condHit.value.text), 'medium', filename, condHit.value)
      : absent('No conditions were listed.'),
    surcharges,
  };
}
