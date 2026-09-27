/**
 * Reading a shipping requirement someone sent in, rather than typed into the
 * form: either the downloadable Excel template, or labelled lines in an email.
 *
 * Deterministic, like the quotation parsers. Anything it cannot read is
 * reported as a problem, in plain language, and never guessed. Nothing here
 * writes; the result goes through the same validation as the form.
 *
 * Email format (labels are case-insensitive; each on its own line):
 *
 *   Company: MPD                        (needed only for people with several companies)
 *   Title: Tyre import, North China to Alexandria
 *   Origin port: CNSHA
 *   Destination port: EGALY
 *   Incoterm: FOB
 *   Containers: 6 x 40HC, Passenger car tyres, 21500 kg     (one line per container type)
 *   Ship from: 2026-11-10
 *   Ship to: 2026-11-24
 *   Reply by: 2026-10-06
 *   Currency: USD
 *   Cargo notes: ...                    (optional)
 *   Instructions: ...                   (optional)
 */

import type { SheetCell } from './excel';
import { RFQ_IMPORT_COLUMNS } from '../excel/workbook';

export interface RequestedRfq {
  title: string;
  originPort: string;
  destinationPort: string;
  incoterm: string;
  containers: { type: string; quantity: number; grossWeightKg: number | null; commodity: string }[];
  cargoNotes: string | null;
  targetShipFrom: string;
  targetShipTo: string;
  /** ISO instant. A bare date means 15:00 UTC that day (end of the working day in Cairo). */
  responseDeadline: string;
  instructions: string | null;
  requestedCurrency: string;
}

export interface ParsedRequest {
  /** A company code given in the request, if any. */
  companyCode: string | null;
  requests: RequestedRfq[];
  /** Why something could not be read. Empty means every request was read in full. */
  problems: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-10-06" -> 15:00 UTC that day; a full ISO date-time is kept as given. */
export function deadlineFrom(value: string): string | null {
  const v = value.trim();
  if (DAY.test(v)) return `${v}T15:00:00.000Z`;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Dates as people write them in a sheet or an email: ISO, or D/M/YYYY. */
export function dayFrom(value: string | Date | null): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (!value) return null;
  const v = value.trim();
  if (DAY.test(v)) return v;
  // Day first, as written in Egypt and most of the world outside the US.
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  if (dmy) {
    const [, d, m, y] = dmy;
    if (Number(m) <= 12 && Number(d) <= 31) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

/* ---------------------------------- Email ------------------------------------ */

const LABELS: Record<string, keyof Fields> = {
  company: 'company',
  'company code': 'company',
  title: 'title',
  requirement: 'title',
  origin: 'origin',
  'origin port': 'origin',
  'port of loading': 'origin',
  pol: 'origin',
  destination: 'destination',
  'destination port': 'destination',
  'port of discharge': 'destination',
  pod: 'destination',
  incoterm: 'incoterm',
  incoterms: 'incoterm',
  container: 'containers',
  containers: 'containers',
  equipment: 'containers',
  'ship from': 'shipFrom',
  'target ship from': 'shipFrom',
  'ship to': 'shipTo',
  'target ship to': 'shipTo',
  'reply by': 'deadline',
  'respond by': 'deadline',
  'response deadline': 'deadline',
  deadline: 'deadline',
  currency: 'currency',
  'quote currency': 'currency',
  'cargo notes': 'cargoNotes',
  cargo: 'cargoNotes',
  instructions: 'instructions',
};

interface Fields {
  company: string;
  title: string;
  origin: string;
  destination: string;
  incoterm: string;
  containers: string[];
  shipFrom: string;
  shipTo: string;
  deadline: string;
  currency: string;
  cargoNotes: string;
  instructions: string;
}

/**
 * One container line: "6 x 40HC, Passenger car tyres, 21500 kg".
 * Accepts "6x40HC", "6 × 40HC" and "40HC x 6"; the weight is optional.
 */
export function parseContainerLine(line: string): RequestedRfq['containers'][number] | string {
  // Commas separate the fields, so a thousands separator ("21,500 kg") must go
  // first, or the weight is split in two and read as 500.
  const parts = line
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const head = parts.shift() ?? '';
  const m =
    /^(\d+)\s*[x×*]\s*([A-Za-z0-9]+)$/i.exec(head) ?? /^([A-Za-z0-9]+)\s*[x×*]\s*(\d+)$/i.exec(head);
  if (!m) return `"${line}" is not a container line. Write it as "6 x 40HC, commodity, weight kg".`;
  const [quantity, type] = /^\d+$/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];

  let grossWeightKg: number | null = null;
  const commodityParts: string[] = [];
  for (const p of parts) {
    // Separators are stripped before reading the number: "21,500 kg" is 21500.
    const w = /^([\d.,\s]+)\s*(kg|kgs|t|tonnes?|mt)$/i.exec(p);
    if (w) {
      const n = Number.parseFloat(w[1].replace(/[,\s]/g, ''));
      grossWeightKg = /^(t|tonnes?|mt)$/i.test(w[2]) ? n * 1000 : n;
    } else {
      commodityParts.push(p);
    }
  }
  return { type: type.toUpperCase(), quantity, grossWeightKg, commodity: commodityParts.join(', ') };
}

export function parseRequestText(text: string): ParsedRequest {
  const f: Partial<Fields> & { containers: string[] } = { containers: [] };
  for (const raw of text.split(/\r?\n/)) {
    // Quoted replies below a forward are not part of the request.
    if (/^\s*>/.test(raw)) continue;
    const m = /^\s*([A-Za-z][A-Za-z ]{1,30}?)\s*[:\-–]\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const key = LABELS[m[1].trim().toLowerCase()];
    if (!key) continue;
    if (key === 'containers') f.containers.push(m[2]);
    else if (f[key] === undefined) (f as unknown as Record<string, string>)[key] = m[2];
  }

  const problems: string[] = [];
  const need = (value: string | undefined, label: string) => {
    if (!value) problems.push(`No "${label}:" line was found.`);
    return value ?? '';
  };

  const containers: RequestedRfq['containers'] = [];
  for (const line of f.containers) {
    const c = parseContainerLine(line);
    if (typeof c === 'string') problems.push(c);
    else containers.push(c);
  }
  if (f.containers.length === 0) problems.push('No "Containers:" line was found, e.g. "Containers: 6 x 40HC, tyres, 21500 kg".');

  const shipFrom = dayFrom(need(f.shipFrom, 'Ship from'));
  const shipTo = dayFrom(need(f.shipTo, 'Ship to'));
  const deadline = deadlineFrom(need(f.deadline, 'Reply by') || 'x');
  if (f.shipFrom && !shipFrom) problems.push(`"Ship from: ${f.shipFrom}" is not a date. Use YYYY-MM-DD.`);
  if (f.shipTo && !shipTo) problems.push(`"Ship to: ${f.shipTo}" is not a date. Use YYYY-MM-DD.`);
  if (f.deadline && !deadline) problems.push(`"Reply by: ${f.deadline}" is not a date. Use YYYY-MM-DD.`);

  const request: RequestedRfq = {
    title: need(f.title, 'Title'),
    originPort: need(f.origin, 'Origin port').toUpperCase(),
    destinationPort: need(f.destination, 'Destination port').toUpperCase(),
    incoterm: need(f.incoterm, 'Incoterm').toUpperCase(),
    containers,
    cargoNotes: f.cargoNotes ?? null,
    targetShipFrom: shipFrom ?? '',
    targetShipTo: shipTo ?? '',
    responseDeadline: deadline ?? '',
    instructions: f.instructions ?? null,
    // The one default: USD is what the form defaults to as well.
    requestedCurrency: (f.currency ?? 'USD').toUpperCase(),
  };

  return {
    companyCode: f.company?.trim().toUpperCase() || null,
    requests: problems.length === 0 ? [request] : [],
    problems,
  };
}

/* ---------------------------------- Sheet ------------------------------------ */

/** Is this the RFQ template? True when its header row carries the template's columns. */
export function looksLikeRfqTemplate(cells: SheetCell[]): boolean {
  const heads = new Set(cells.filter((c) => c.row === 1).map((c) => c.text.trim().toLowerCase()));
  return ['title', 'origin port', 'destination port', 'container type'].every((h) => heads.has(h));
}

/**
 * Reads the Excel template. Rows sharing a title, route and dates become one
 * request with several container lines, as the template's notes promise.
 */
export function parseRequestSheet(cells: SheetCell[], filename: string): ParsedRequest {
  const problems: string[] = [];
  const sheetName = cells.find((c) => c.row === 1 && c.text.trim().toLowerCase() === 'title')?.sheet;
  if (!sheetName) return { companyCode: null, requests: [], problems: [`${filename} is not the RFQ template: no "Title" column was found.`] };

  const inSheet = cells.filter((c) => c.sheet === sheetName);
  const columns = new Map<string, number>();
  for (const c of inSheet.filter((x) => x.row === 1)) columns.set(c.text.trim().toLowerCase(), c.col);
  const missing = RFQ_IMPORT_COLUMNS.filter(
    (h) => !columns.has(h.toLowerCase()) && !['Cargo notes', 'Instructions', 'Gross weight per container (kg)'].includes(h),
  );
  if (missing.length > 0) {
    return { companyCode: null, requests: [], problems: [`${filename} is missing the column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`] };
  }

  const rows = new Map<number, Map<number, SheetCell>>();
  for (const c of inSheet.filter((x) => x.row > 1)) {
    if (!rows.has(c.row)) rows.set(c.row, new Map());
    rows.get(c.row)!.set(c.col, c);
  }
  const get = (row: Map<number, SheetCell>, header: string) => row.get(columns.get(header.toLowerCase()) ?? -1);

  const grouped = new Map<string, RequestedRfq>();
  for (const [rowNumber, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const text = (h: string) => get(row, h)?.text.trim() ?? '';
    const where = `${filename} row ${rowNumber}`;
    const shipFrom = dayFrom(get(row, 'Target ship from')?.date ?? text('Target ship from'));
    const shipTo = dayFrom(get(row, 'Target ship to')?.date ?? text('Target ship to'));
    const deadlineDay = dayFrom(get(row, 'Response deadline')?.date ?? text('Response deadline'));
    const quantityCell = get(row, 'Quantity');
    const quantity = quantityCell?.numeric ?? Number.parseInt(quantityCell?.text ?? '', 10);
    const weightCell = get(row, 'Gross weight per container (kg)');
    const weight = weightCell ? (weightCell.numeric ?? Number.parseFloat(weightCell.text.replace(/[,\s]/g, ''))) : null;

    const rowProblems: string[] = [];
    if (!text('Title')) rowProblems.push(`${where}: no title.`);
    if (!shipFrom || !shipTo) rowProblems.push(`${where}: the shipping dates are not YYYY-MM-DD.`);
    if (!deadlineDay) rowProblems.push(`${where}: the response deadline is not a date.`);
    if (!Number.isFinite(quantity)) rowProblems.push(`${where}: the quantity is not a number.`);
    if (rowProblems.length > 0) {
      problems.push(...rowProblems);
      continue;
    }

    const key = [text('Title'), text('Origin port'), text('Destination port'), shipFrom, shipTo].join('|').toLowerCase();
    const request =
      grouped.get(key) ??
      ({
        title: text('Title'),
        originPort: text('Origin port').toUpperCase(),
        destinationPort: text('Destination port').toUpperCase(),
        incoterm: text('Incoterm').toUpperCase(),
        containers: [],
        cargoNotes: text('Cargo notes') || null,
        targetShipFrom: shipFrom!,
        targetShipTo: shipTo!,
        responseDeadline: deadlineFrom(deadlineDay!)!,
        instructions: text('Instructions') || null,
        requestedCurrency: (text('Quote currency') || 'USD').toUpperCase(),
      } satisfies RequestedRfq);
    request.containers.push({
      type: text('Container type').toUpperCase(),
      quantity,
      grossWeightKg: weight !== null && Number.isFinite(weight) ? weight : null,
      commodity: text('Commodity'),
    });
    grouped.set(key, request);
  }

  if (grouped.size === 0 && problems.length === 0) problems.push(`${filename} has no requirement rows under the header.`);
  return { companyCode: null, requests: problems.length === 0 ? [...grouped.values()] : [], problems };
}
