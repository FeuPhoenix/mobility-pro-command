/**
 * Supplier document control.
 *
 * Compares the extracted fields of a supplier document against the purchase
 * order it references, under the Import document control SOP (POL-PROC v1.9).
 *
 * The extraction itself is SIMULATED for this demo: the sample documents ship
 * with pre-extracted fields. Nothing here claims to have read a PDF.
 */

import { round2, usdToEgp } from './money';
import type { DemoState, Discrepancy, Id, PurchaseOrder, SupplierDocument } from './types';

export const DOC_RULES = {
  SPEC: { id: 'PR-2.1', text: 'Size, ply rating or pattern mismatch is blocking.' },
  QTY: { id: 'PR-2.2', text: 'Quantity variance above 2% of ordered quantity is blocking.' },
  PRICE: { id: 'PR-2.3', text: 'Unit price variance above 0.5% of ordered price is blocking.' },
  TERMS: { id: 'PR-2.4', text: 'A change in payment terms is blocking and must be confirmed by Finance.' },
  FORMAT: { id: 'PR-1.2', text: 'Descriptive field differs in wording only; recorded as advisory.' },
} as const;

/** Supplier documents print dates like "24 Jun 2026". */
function formatDocDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const QTY_TOLERANCE = 0.02;
export const PRICE_TOLERANCE = 0.005;

function norm(v: string): string {
  return v.trim().replace(/\s+/g, ' ').toUpperCase();
}

function num(v: string): number {
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** Strip a trailing parenthetical suffix, e.g. "Hauler SD-7 (HD)" -> "Hauler SD-7". */
function baseName(v: string): string {
  return norm(v.replace(/\s*\([^)]*\)\s*$/, ''));
}

function fieldValue(doc: SupplierDocument, key: string): string | undefined {
  return doc.extraction.find((f) => f.key === key)?.value;
}

function fieldMeta(doc: SupplierDocument, key: string) {
  const f = doc.extraction.find((x) => x.key === key);
  return { page: f?.page ?? 1, anchor: f?.anchor ?? '', label: f?.label ?? key, group: f?.group ?? '' };
}

/**
 * Validate a document against its purchase order.
 * Pure: returns a fresh discrepancy list, deterministically keyed off the
 * document id so re-running replaces rather than duplicates.
 */
export function validateDocument(
  state: DemoState,
  doc: SupplierDocument,
  po: PurchaseOrder,
): Discrepancy[] {
  const out: Discrepancy[] = [];
  const push = (
    key: string,
    documentValue: string,
    orderValue: string,
    severity: 'blocking' | 'advisory',
    rule: { id: string; text: string },
    impactEgp?: number,
  ) => {
    const m = fieldMeta(doc, key);
    out.push({
      id: `DSC-${doc.id}-${key.replace(/\./g, '-')}`,
      fieldKey: key,
      label: m.label,
      group: m.group,
      documentValue,
      orderValue,
      severity,
      rule: rule.text,
      ruleId: rule.id,
      impactEgp,
      page: m.page,
      anchor: m.anchor,
      resolved: false,
    });
  };

  // ---- Header: payment terms (only checked on pro forma invoices) ----------
  if (doc.kind === 'Pro forma invoice') {
    const terms = fieldValue(doc, 'header.paymentTerms');
    if (terms !== undefined && norm(terms) !== norm(po.paymentTerms)) {
      push('header.paymentTerms', terms, po.paymentTerms, 'blocking', DOC_RULES.TERMS);
    }
  }

  // ---- Lines ---------------------------------------------------------------
  for (const line of po.lines) {
    const p = `line.${line.lineNo}`;

    const size = fieldValue(doc, `${p}.size`);
    if (size !== undefined && norm(size) !== norm(line.size)) {
      push(`${p}.size`, size, line.size, 'blocking', DOC_RULES.SPEC);
    }

    const ply = fieldValue(doc, `${p}.ply`);
    if (ply !== undefined && norm(ply) !== norm(line.ply)) {
      push(`${p}.ply`, ply, line.ply, 'blocking', DOC_RULES.SPEC);
    }

    const pattern = fieldValue(doc, `${p}.pattern`);
    if (pattern !== undefined && norm(pattern) !== norm(line.pattern)) {
      // Same product, different wording -> advisory. Different product -> blocking.
      const sameBase = baseName(pattern) === baseName(line.pattern);
      push(
        `${p}.pattern`,
        pattern,
        line.pattern,
        sameBase ? 'advisory' : 'blocking',
        sameBase ? DOC_RULES.FORMAT : DOC_RULES.SPEC,
      );
    }

    const qtyRaw = fieldValue(doc, `${p}.qty`);
    if (qtyRaw !== undefined) {
      const qty = num(qtyRaw);
      if (!Number.isNaN(qty) && qty !== line.qty) {
        const variance = Math.abs(qty - line.qty) / line.qty;
        const blocking = variance > QTY_TOLERANCE;
        const impact = usdToEgp((line.qty - qty) * line.unitPriceUsd, po.fxRate);
        push(
          `${p}.qty`,
          String(qty),
          String(line.qty),
          blocking ? 'blocking' : 'advisory',
          DOC_RULES.QTY,
          round2(impact),
        );
      }
    }

    const priceRaw = fieldValue(doc, `${p}.unitPrice`);
    if (priceRaw !== undefined) {
      const price = num(priceRaw);
      if (!Number.isNaN(price) && round2(price) !== round2(line.unitPriceUsd)) {
        const variance = Math.abs(price - line.unitPriceUsd) / line.unitPriceUsd;
        const blocking = variance > PRICE_TOLERANCE;
        const docQty = num(fieldValue(doc, `${p}.qty`) ?? String(line.qty));
        const qtyForImpact = Number.isNaN(docQty) ? line.qty : docQty;
        const impact = usdToEgp((price - line.unitPriceUsd) * qtyForImpact, po.fxRate);
        push(
          `${p}.unitPrice`,
          price.toFixed(2),
          line.unitPriceUsd.toFixed(2),
          blocking ? 'blocking' : 'advisory',
          DOC_RULES.PRICE,
          round2(impact),
        );
      }
    }
  }

  void state;
  return out;
}

/* ------------------------------- Totals ----------------------------------- */

export interface DocumentTotals {
  orderQty: number;
  documentQty: number;
  orderValueUsd: number;
  documentValueUsd: number;
  orderValueEgp: number;
  documentValueEgp: number;
  varianceUsd: number;
  varianceEgp: number;
}

export function documentTotals(doc: SupplierDocument, po: PurchaseOrder): DocumentTotals {
  let documentQty = 0;
  let documentValueUsd = 0;
  for (const line of po.lines) {
    const p = `line.${line.lineNo}`;
    const q = num(fieldValue(doc, `${p}.qty`) ?? String(line.qty));
    const u = num(fieldValue(doc, `${p}.unitPrice`) ?? String(line.unitPriceUsd));
    const qty = Number.isNaN(q) ? line.qty : q;
    const unit = Number.isNaN(u) ? line.unitPriceUsd : u;
    documentQty += qty;
    documentValueUsd += qty * unit;
  }
  const orderQty = po.lines.reduce((n, l) => n + l.qty, 0);
  const orderValueUsd = po.lines.reduce((n, l) => n + l.qty * l.unitPriceUsd, 0);
  return {
    orderQty,
    documentQty,
    orderValueUsd: round2(orderValueUsd),
    documentValueUsd: round2(documentValueUsd),
    orderValueEgp: usdToEgp(orderValueUsd, po.fxRate),
    documentValueEgp: usdToEgp(documentValueUsd, po.fxRate),
    varianceUsd: round2(documentValueUsd - orderValueUsd),
    varianceEgp: usdToEgp(documentValueUsd - orderValueUsd, po.fxRate),
  };
}

/* ---------------------------- Receiving readiness -------------------------- */

export type ReadinessState =
  | 'Ready for receiving'
  | 'Held - document control'
  | 'Not yet arrived'
  | 'Goods received';

export interface Readiness {
  state: ReadinessState;
  reasons: string[];
  blockingCount: number;
  advisoryCount: number;
  caseId?: Id;
  overridden: boolean;
}

/**
 * Receiving readiness is DERIVED, never stored.
 *
 * Note the deliberate separation (policy PR-3.1): a resolved document case
 * does not mean the goods arrived, were counted, or that payment is approved.
 */
export function receivingReadiness(state: DemoState, shipmentId: Id): Readiness {
  const shipment = state.shipments.find((s) => s.id === shipmentId);
  if (!shipment) {
    return { state: 'Not yet arrived', reasons: ['Shipment not found.'], blockingCount: 0, advisoryCount: 0, overridden: false };
  }

  const docs = state.documents.filter((d) => d.shipmentId === shipmentId);
  const docIds = new Set(docs.map((d) => d.id));
  const relatedCases = state.cases.filter(
    (c) => docIds.has(c.documentId) || c.shipmentId === shipmentId,
  );

  // Every discrepancy raised against one of this shipment's documents.
  const pool = state.discrepancies.filter((d) =>
    docs.some((doc) => d.id.startsWith(`DSC-${doc.id}-`)),
  );

  const overridden = relatedCases.some((c) => c.status === 'Overridden');
  const unresolvedBlocking = pool.filter((d) => d.severity === 'blocking' && !d.resolved);
  const advisory = pool.filter((d) => d.severity === 'advisory' && !d.resolved);

  const reasons: string[] = [];
  if (shipment.status === 'Received') {
    return {
      state: 'Goods received',
      reasons: ['Goods have been received into stock. Document control is complete for this shipment.'],
      blockingCount: 0,
      advisoryCount: advisory.length,
      caseId: relatedCases[0]?.id,
      overridden,
    };
  }

  if (shipment.status === 'In transit') {
    reasons.push(`Vessel ${shipment.vessel} is still in transit. ETA ${shipment.eta}.`);
    return {
      state: 'Not yet arrived',
      reasons,
      blockingCount: unresolvedBlocking.length,
      advisoryCount: advisory.length,
      caseId: relatedCases[0]?.id,
      overridden,
    };
  }

  if (unresolvedBlocking.length > 0 && !overridden) {
    for (const d of unresolvedBlocking) {
      reasons.push(`${d.group} - ${d.label}: document says "${d.documentValue}", order says "${d.orderValue}" (${d.ruleId}).`);
    }
    return {
      state: 'Held - document control',
      reasons,
      blockingCount: unresolvedBlocking.length,
      advisoryCount: advisory.length,
      caseId: relatedCases[0]?.id,
      overridden,
    };
  }

  if (overridden) {
    reasons.push('Blocking mismatches were explicitly overridden by an authorised role. Reason retained on the case.');
  }
  if (advisory.length > 0) {
    reasons.push(`${advisory.length} advisory difference(s) recorded; these do not block receiving.`);
  }
  reasons.push('Goods have not been counted yet. Receiving readiness is a document-control state only.');

  return {
    state: 'Ready for receiving',
    reasons,
    blockingCount: 0,
    advisoryCount: advisory.length,
    caseId: relatedCases[0]?.id,
    overridden,
  };
}

/* ------------------------- Corrected document builder ---------------------- */

/**
 * Builds the revised supplier document used by "Simulate corrected document".
 * The supplier is modelled as correcting the blocking issues it caused, while
 * the advisory wording difference stays exactly as it was.
 */
export function buildCorrectedDocument(
  original: SupplierDocument,
  po: PurchaseOrder,
  receivedOn: string,
): SupplierDocument {
  const revision = original.revision + 1;
  const reference = `${original.reference}-R${revision}`;

  const extraction = original.extraction.map((f) => {
    const copy = { ...f };
    const m = /^line\.(\d+)\.(\w+)$/.exec(f.key);
    if (m) {
      const line = po.lines.find((l) => l.lineNo === Number(m[1]));
      if (line) {
        if (m[2] === 'ply') copy.value = line.ply;
        if (m[2] === 'size') copy.value = line.size;
        if (m[2] === 'qty') copy.value = String(line.qty);
        if (m[2] === 'unitPrice') copy.value = line.unitPriceUsd.toFixed(2);
        // pattern intentionally left as-is: the advisory wording difference persists
      }
    }
    if (f.key === 'header.paymentTerms') copy.value = po.paymentTerms;
    if (f.key === 'header.reference') copy.value = reference;
    copy.originalValue = copy.value;
    copy.state = copy.value === f.value ? f.state : 'Needs review';
    return copy;
  });

  const totalQty = po.lines.reduce((n, l) => n + l.qty, 0);
  const totalUsd = po.lines.reduce((n, l) => n + l.qty * l.unitPriceUsd, 0);

  const lineRows = po.lines.map((l) => {
    const patternField = original.extraction.find((f) => f.key === `line.${l.lineNo}.pattern`);
    const patternText = (patternField?.value ?? l.pattern).toUpperCase();
    return {
      anchor: `r${revision}-l${l.lineNo}`,
      cells: [
        `${l.lineNo}  TBR ${l.size} ${l.ply} ${patternText}`,
        l.qty.toLocaleString('en-US'),
        l.unitPriceUsd.toFixed(2),
        (l.qty * l.unitPriceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      ],
    };
  });

  return {
    ...original,
    id: `${original.id.replace(/-R\d+$/, '')}-R${revision}`,
    reference,
    revision,
    supersedesId: original.id,
    issuedOn: receivedOn,
    receivedOn,
    extraction,
    pages: [
      {
        page: 1,
        title: `PRO FORMA INVOICE (REVISED) - ${reference}`,
        rows: [
          { anchor: `r${revision}-h-sup`, cells: ['Seller', 'Orient Rubber Industries Co. Ltd, 88 Rayong Industrial Estate, Thailand'], heading: true },
          { anchor: `r${revision}-h-note`, cells: ['Revision', `Supersedes ${original.reference}. Issued in response to buyer query.`], emphasis: true },
          {
            anchor: `r${revision}-h-po`,
            cells: ['Your Order No.', `${po.id} dated ${formatDocDate(po.orderedOn)}`],
          },
          { anchor: `r${revision}-h-terms`, cells: ['Payment', po.paymentTerms], emphasis: true },
          { anchor: `r${revision}-cols`, cells: ['#  DESCRIPTION', 'QTY', 'UNIT USD', 'AMOUNT USD'], heading: true },
          ...lineRows,
          {
            anchor: `r${revision}-total`,
            cells: [
              'TOTAL CFR ALEXANDRIA',
              totalQty.toLocaleString('en-US'),
              '',
              totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            ],
            heading: true,
          },
        ],
        footer: [
          'Revised at buyer request. Line 1 supplied to contracted 16PR specification.',
          'Bank: Siam Commercial Bank PCL, Rayong Branch - A/C 442-1-88104-3',
        ],
      },
    ],
  };
}
