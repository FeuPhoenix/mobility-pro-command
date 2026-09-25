/**
 * Excel outputs.
 *
 * Three workbooks are produced:
 *   - the side-by-side comparison that goes to the manager,
 *   - the provider-list import template,
 *   - the shipping-requirement import template.
 *
 * The comparison sheet follows the same rule as the screen: confirmed values,
 * missing values and assumptions are visually distinct, and an offer that could
 * not be compared is listed with the reason rather than dropped or zero-filled.
 */

import ExcelJS from 'exceljs';
import type { Comparison, Company, Quote, Rfq } from '../types';
import { CHARGE_BASIS_LABEL } from '../types';
import { describeIssue } from '../domain/comparison';

const INK = 'FF14181F';
const MUTED = 'FF6B7480';
const LINE = 'FFE3E6EA';
const HEAD_FILL = 'FFF4F6F8';
const GOOD_FILL = 'FFEAF5EE';
const WARN_FILL = 'FFFDF4E6';
const BAD_FILL = 'FFFBEDED';

function titleRow(sheet: ExcelJS.Worksheet, text: string, span: number): void {
  const row = sheet.addRow([text]);
  row.font = { bold: true, size: 14, color: { argb: INK } };
  row.height = 22;
  sheet.mergeCells(row.number, 1, row.number, Math.max(span, 2));
}

function labelRow(sheet: ExcelJS.Worksheet, label: string, value: string): void {
  const row = sheet.addRow([label, value]);
  row.getCell(1).font = { color: { argb: MUTED }, size: 10 };
  row.getCell(2).font = { color: { argb: INK }, size: 10 };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const side: ExcelJS.Border = { style: 'thin', color: { argb: LINE } };
  return { top: side, left: side, bottom: side, right: side };
}

export interface ComparisonWorkbookInput {
  company: Company;
  rfq: Rfq;
  comparison: Comparison;
  quotes: Quote[];
  generatedAt: string;
  generatedBy: string;
  /** True when the data came from the demonstration dataset. */
  demo: boolean;
}

export async function buildComparisonWorkbook(input: ComparisonWorkbookInput): Promise<Buffer> {
  const { company, rfq, comparison: c } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mobility Pro Command';
  wb.created = new Date(input.generatedAt);

  const quoteById = new Map(input.quotes.map((q) => [q.id, q]));
  const cur = c.criteria.baseCurrency;

  /* ------------------------------- Comparison ------------------------------ */

  const sheet = wb.addWorksheet('Comparison', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 9 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  titleRow(sheet, `Freight comparison ${rfq.reference}`, c.lines.length + 1);
  labelRow(sheet, 'Company', company.name);
  labelRow(sheet, 'Route', `${rfq.originPort} to ${rfq.destinationPort} (${rfq.incoterm})`);
  labelRow(
    sheet,
    'Equipment',
    rfq.containers.map((x) => `${x.quantity} x ${x.type} ${x.commodity}`).join('; '),
  );
  labelRow(sheet, 'Comparison date', input.generatedAt.slice(0, 10));
  labelRow(sheet, 'Prepared by', input.generatedBy);
  labelRow(
    sheet,
    'Ranking criteria',
    `Cost ${Math.round(c.criteria.weightCost * 100)}%, transit ${Math.round(c.criteria.weightTransit * 100)}%, free days ${Math.round(c.criteria.weightFreeDays * 100)}%. All figures in ${cur}.`,
  );
  if (input.demo) {
    const row = sheet.addRow(['Data source', 'Demonstration dataset. These are fictional providers and rates.']);
    row.getCell(1).font = { color: { argb: MUTED }, size: 10 };
    row.getCell(2).font = { italic: true, color: { argb: 'FFA8620A' }, size: 10 };
  } else {
    sheet.addRow([]);
  }
  sheet.addRow([]);

  // Providers across the columns, fields down the rows: the layout a buyer reads.
  const headerRow = sheet.addRow(['', ...c.lines.map((l) => l.providerName)]);
  headerRow.font = { bold: true, color: { argb: INK } };
  headerRow.eachCell((cell, col) => {
    cell.border = thinBorder();
    cell.alignment = { vertical: 'middle', wrapText: true };
    if (col === 1) return;
    const line = c.lines[col - 2];
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: line.quoteId === c.recommendedQuoteId ? GOOD_FILL : HEAD_FILL },
    };
  });

  const addField = (
    label: string,
    pick: (lineIndex: number) => { text: string; tone?: 'good' | 'warn' | 'bad' },
  ) => {
    const row = sheet.addRow([label, ...c.lines.map((_, i) => pick(i).text)]);
    row.getCell(1).font = { color: { argb: MUTED }, size: 10 };
    row.eachCell((cell, col) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: 'top', wrapText: true };
      if (col === 1) return;
      const tone = pick(col - 2).tone;
      if (tone) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: tone === 'good' ? GOOD_FILL : tone === 'warn' ? WARN_FILL : BAD_FILL },
        };
      }
    });
  };

  const money = (n: number | null, currency: string | null) =>
    n === null ? 'not available' : `${currency ?? cur} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

  addField('Status', (i) => {
    const l = c.lines[i];
    if (l.quoteId === c.recommendedQuoteId) return { text: 'Recommended', tone: 'good' };
    if (!l.comparable) return { text: 'Not comparable', tone: 'bad' };
    if (l.quoteId === c.cheapestQuoteId) return { text: 'Cheapest comparable', tone: 'warn' };
    return { text: 'Comparable' };
  });
  addField('Rank', (i) => ({ text: c.lines[i].rank ? `${c.lines[i].rank}` : 'not ranked' }));
  addField('Quotation version', (i) => ({ text: `v${c.lines[i].version}` }));
  addField('Shipping line', (i) => ({
    text: quoteById.get(c.lines[i].quoteId)?.shippingLine.value ?? 'not stated',
  }));
  addField('Rate basis', (i) => ({
    text: quoteById.get(c.lines[i].quoteId)?.containerBasis.value ?? 'not stated',
  }));
  addField('Base freight (per container)', (i) => {
    const q = quoteById.get(c.lines[i].quoteId);
    return q?.baseFreight.value === null || !q
      ? { text: 'not stated', tone: 'bad' as const }
      : { text: money(q.baseFreight.value, q.currency.value) };
  });

  // One row per surcharge that any provider mentioned, so a blank is visible.
  const allCodes = [
    ...new Set(
      c.lines.flatMap((l) => (quoteById.get(l.quoteId)?.surcharges ?? []).map((s) => s.code)),
    ),
  ];
  for (const code of allCodes) {
    const label = c.lines
      .map((l) => quoteById.get(l.quoteId)?.surcharges.find((s) => s.code === code)?.label)
      .find(Boolean);
    addField(`${label ?? code}`, (i) => {
      const q = quoteById.get(c.lines[i].quoteId);
      const s = q?.surcharges.find((x) => x.code === code);
      if (!s) return { text: 'not mentioned' };
      if (s.amount === null)
        return { text: 'listed, amount not given', tone: 'bad' as const };
      return { text: `${money(s.amount, s.currency)} ${CHARGE_BASIS_LABEL[s.basis]}` };
    });
  }

  addField('Total for this shipment', (i) => {
    const l = c.lines[i];
    if (l.totalInQuoteCurrency === null) return { text: 'cannot be totalled', tone: 'bad' };
    return { text: money(l.totalInQuoteCurrency, l.quoteCurrency) };
  });
  addField(`Total in ${cur}`, (i) => {
    const l = c.lines[i];
    if (l.totalInBaseCurrency === null) return { text: 'not comparable', tone: 'bad' };
    const tone = l.quoteId === c.cheapestQuoteId ? ('warn' as const) : undefined;
    return { text: money(l.totalInBaseCurrency, cur), tone };
  });
  addField('Exchange rate applied', (i) => {
    const fx = c.lines[i].fxApplied;
    return { text: fx ? `${fx.rate} ${fx.to}/${fx.from} (${fx.source}, ${fx.asOf})` : 'none needed' };
  });
  addField('Provider stated total', (i) => {
    const l = c.lines[i];
    const q = quoteById.get(l.quoteId);
    if (!q || q.totalQuoted.value === null) return { text: 'not stated' };
    if (l.totalDiscrepancy)
      return {
        text: `${money(q.totalQuoted.value, l.quoteCurrency)} - does not match the sum of the charges`,
        tone: 'warn' as const,
      };
    return { text: money(q.totalQuoted.value, l.quoteCurrency) };
  });
  addField('Transit time', (i) => {
    const d = c.lines[i].transitDays;
    return d === null ? { text: 'not stated', tone: 'bad' as const } : { text: `${d} days` };
  });
  addField('Free days at destination', (i) => {
    const d = c.lines[i].freeDays;
    return d === null ? { text: 'not stated' } : { text: `${d} days` };
  });
  addField('Valid until', (i) => ({ text: c.lines[i].validUntil ?? 'not stated' }));
  addField('Sailing date', (i) => ({
    text: quoteById.get(c.lines[i].quoteId)?.sailingDate.value ?? 'not stated',
  }));
  addField('Payment terms', (i) => ({
    text: quoteById.get(c.lines[i].quoteId)?.paymentTerms.value ?? 'not stated',
  }));
  addField('Included', (i) => ({
    text: quoteById.get(c.lines[i].quoteId)?.inclusions.value?.join(', ') ?? 'not stated',
  }));
  addField('Excluded', (i) => ({
    text: quoteById.get(c.lines[i].quoteId)?.exclusions.value?.join(', ') ?? 'not stated',
  }));
  addField('Conditions', (i) => ({
    text: quoteById.get(c.lines[i].quoteId)?.conditions.value?.join(', ') ?? 'not stated',
  }));
  addField('Weighted score', (i) => ({
    text: c.lines[i].scoreTotal === null ? 'not scored' : (c.lines[i].scoreTotal as number).toFixed(3),
  }));
  addField('Why not comparable', (i) => {
    const l = c.lines[i];
    if (l.comparable) return { text: '' };
    return { text: l.issues.map((x) => describeIssue(x)).join('\n'), tone: 'bad' };
  });

  sheet.getColumn(1).width = 30;
  for (let i = 0; i < c.lines.length; i++) sheet.getColumn(i + 2).width = 34;

  /* ----------------------------- Recommendation ---------------------------- */

  const rec = wb.addWorksheet('Recommendation');
  titleRow(rec, 'Recommendation', 2);
  const recommended = c.lines.find((l) => l.quoteId === c.recommendedQuoteId) ?? null;
  const cheapest = c.lines.find((l) => l.quoteId === c.cheapestQuoteId) ?? null;

  if (recommended) {
    labelRow(rec, 'Recommended offer', recommended.providerName);
    labelRow(rec, 'Total', money(recommended.totalInBaseCurrency, cur));
    labelRow(rec, 'Transit', recommended.transitDays === null ? 'not stated' : `${recommended.transitDays} days`);
  } else {
    labelRow(rec, 'Recommended offer', 'None. No offer could be compared on a like-for-like basis.');
  }
  if (cheapest) {
    labelRow(rec, 'Cheapest comparable offer', cheapest.providerName);
    labelRow(rec, 'Cheapest total', money(cheapest.totalInBaseCurrency, cur));
  }
  rec.addRow([]);

  const bullets = (heading: string, items: string[]) => {
    if (items.length === 0) return;
    const h = rec.addRow([heading]);
    h.font = { bold: true, color: { argb: INK } };
    for (const item of items) {
      const r = rec.addRow(['', item]);
      r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    }
    rec.addRow([]);
  };
  bullets('Why this offer', c.recommendationReasons);
  bullets('Tradeoffs', c.recommendationTradeoffs);
  bullets('Offers not included in the ranking', c.blockedNotes);

  const note = rec.addRow([
    'This is a recommendation to support the decision of the Logistics Operations Manager. No provider has been selected, nothing has been negotiated and no booking has been made.',
  ]);
  note.font = { italic: true, color: { argb: MUTED }, size: 10 };
  note.alignment = { wrapText: true };
  rec.mergeCells(note.number, 1, note.number, 3);
  rec.getColumn(1).width = 28;
  rec.getColumn(2).width = 96;

  /* -------------------------------- Sources -------------------------------- */

  const src = wb.addWorksheet('Sources');
  titleRow(src, 'Where each figure came from', 5);
  const srcHead = src.addRow(['Provider', 'Field', 'Value', 'Confidence', 'Source']);
  srcHead.font = { bold: true };
  srcHead.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    cell.border = thinBorder();
  });

  for (const l of c.lines) {
    const q = quoteById.get(l.quoteId);
    if (!q) continue;
    const rows: [string, unknown, string, string | null][] = [
      ['Shipping line', q.shippingLine.value, q.shippingLine.confidence, q.shippingLine.sourceRef],
      ['Currency', q.currency.value, q.currency.confidence, q.currency.sourceRef],
      ['Rate basis', q.containerBasis.value, q.containerBasis.confidence, q.containerBasis.sourceRef],
      ['Base freight', q.baseFreight.value, q.baseFreight.confidence, q.baseFreight.sourceRef],
      ['Total quoted', q.totalQuoted.value, q.totalQuoted.confidence, q.totalQuoted.sourceRef],
      ['Transit days', q.transitDays.value, q.transitDays.confidence, q.transitDays.sourceRef],
      ['Free days', q.freeDaysDestination.value, q.freeDaysDestination.confidence, q.freeDaysDestination.sourceRef],
      ['Valid until', q.validUntil.value, q.validUntil.confidence, q.validUntil.sourceRef],
      ['Sailing date', q.sailingDate.value, q.sailingDate.confidence, q.sailingDate.sourceRef],
      ['Payment terms', q.paymentTerms.value, q.paymentTerms.confidence, q.paymentTerms.sourceRef],
    ];
    for (const s of q.surcharges) {
      rows.push([`Surcharge: ${s.label}`, s.amount, s.confidence, s.sourceRef]);
    }
    for (const [field, value, confidence, ref] of rows) {
      const r = src.addRow([
        l.providerName,
        field,
        value === null || value === undefined ? 'not stated' : String(value),
        confidence,
        ref ?? 'no source recorded',
      ]);
      r.eachCell((cell) => {
        cell.border = thinBorder();
        cell.alignment = { vertical: 'top', wrapText: true };
      });
      if (confidence === 'missing') {
        r.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAD_FILL } };
      } else if (confidence === 'low' || confidence === 'medium') {
        r.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WARN_FILL } };
      }
    }
  }
  src.getColumn(1).width = 26;
  src.getColumn(2).width = 26;
  src.getColumn(3).width = 30;
  src.getColumn(4).width = 13;
  src.getColumn(5).width = 46;

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/* ------------------------------- Templates ---------------------------------- */

export const PROVIDER_IMPORT_COLUMNS = [
  'Provider name',
  'Type',
  'Country',
  'General email',
  'Relationship status',
  'Restriction reason',
  'Account reference',
  'Lanes',
  'Contact name',
  'Contact email',
  'Contact role',
  'Primary contact',
  'Notes',
] as const;

export async function buildProviderTemplate(companyName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mobility Pro Command';
  const sheet = wb.addWorksheet('Providers');

  const head = sheet.addRow([...PROVIDER_IMPORT_COLUMNS]);
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    cell.border = thinBorder();
  });

  sheet.addRow([
    'Example Shipping Lines',
    'Carrier',
    'Egypt',
    'quotes@example-shipping.test',
    'active',
    '',
    'MP-44821',
    'CNSHA>EGALY; CNNGB>EGALY',
    'Mona Adel',
    'mona.adel@example-shipping.test',
    'Key account manager',
    'yes',
    'Strong on North China.',
  ]);

  const notes = wb.addWorksheet('How to fill this in');
  const lines = [
    [`Provider list import for ${companyName}`, ''],
    ['', ''],
    ['Provider name', 'Required. Matched case-insensitively against existing providers, so the same provider is not created twice.'],
    ['Type', 'Carrier, NVOCC, Freight forwarder, and so on. Free text.'],
    ['Country', 'Where the provider is based.'],
    ['General email', 'The head-office or general mailbox. Shared across all companies.'],
    ['Relationship status', 'One of: active, contracted, excluded, prospect. Only "active" providers can be sent an RFQ.'],
    ['Restriction reason', 'Required when the status is contracted or excluded. Shown wherever outreach is blocked.'],
    ['Account reference', 'How this company is known at the provider.'],
    ['Lanes', 'Origin>destination pairs separated by a semicolon, e.g. CNSHA>EGALY; INNSA>EGALY.'],
    ['Contact name / email / role', 'One contact per row. Repeat the provider name on another row to add a second contact.'],
    ['Primary contact', 'yes or no. Primary contacts are addressed on To:, the rest on Cc:.'],
    ['Notes', 'Anything the team should know.'],
    ['', ''],
    ['Validation', 'Every row is checked before anything is saved. Rows with problems are reported with the row number and nothing is imported until you choose to proceed with the valid rows.'],
  ];
  for (const [a, b] of lines) {
    const r = notes.addRow([a, b]);
    r.getCell(1).font = { bold: true, size: 10 };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }
  notes.getColumn(1).width = 26;
  notes.getColumn(2).width = 100;

  for (let i = 1; i <= PROVIDER_IMPORT_COLUMNS.length; i++) sheet.getColumn(i).width = 24;

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export const RFQ_IMPORT_COLUMNS = [
  'Title',
  'Origin port',
  'Destination port',
  'Incoterm',
  'Container type',
  'Quantity',
  'Commodity',
  'Gross weight per container (kg)',
  'Target ship from',
  'Target ship to',
  'Response deadline',
  'Quote currency',
  'Cargo notes',
  'Instructions',
] as const;

export async function buildRfqTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mobility Pro Command';
  const sheet = wb.addWorksheet('Shipping requirement');
  const head = sheet.addRow([...RFQ_IMPORT_COLUMNS]);
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } };
    cell.border = thinBorder();
  });
  sheet.addRow([
    'Tyre import, North China to Alexandria',
    'CNSHA',
    'EGALY',
    'FOB',
    '40HC',
    6,
    'Passenger car tyres',
    21500,
    '2026-11-10',
    '2026-11-24',
    '2026-10-06',
    'USD',
    'Stackable, no hazardous classification.',
    'Please quote all-in and state every surcharge separately.',
  ]);
  sheet.addRow([
    'Tyre import, North China to Alexandria',
    'CNSHA',
    'EGALY',
    'FOB',
    '20GP',
    2,
    'Truck tyres',
    18000,
    '2026-11-10',
    '2026-11-24',
    '2026-10-06',
    'USD',
    '',
    '',
  ]);

  const notes = wb.addWorksheet('How to fill this in');
  for (const [a, b] of [
    ['One requirement per title', 'Rows sharing the same title, route and dates are combined into a single RFQ with several container lines.'],
    ['Dates', 'YYYY-MM-DD. The response deadline is the date providers must reply by.'],
    ['Incoterm', 'EXW, FOB, FCA, CFR, CIF, DAP or DDP.'],
    ['Container type', '20GP, 40GP, 40HC, 45HC, 20RF, 40RF, LCL or BREAKBULK.'],
    ['Providers', 'Recipients are not set in this file. You choose them in the app after importing, so the restriction rules are applied.'],
  ]) {
    const r = notes.addRow([a, b]);
    r.getCell(1).font = { bold: true, size: 10 };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }
  notes.getColumn(1).width = 28;
  notes.getColumn(2).width = 100;

  for (let i = 1; i <= RFQ_IMPORT_COLUMNS.length; i++) sheet.getColumn(i).width = 24;
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
