import { beforeEach, describe, expect, it } from 'vitest';
import { buildSeedState } from '@/domain/seed';
import {
  buildCorrectedDocument,
  documentTotals,
  receivingReadiness,
  validateDocument,
} from '@/domain/documentRules';
import { applyAction, ensureValidated } from '@/server/actions';
import type { DemoState } from '@/domain/types';

function fresh(): DemoState {
  const s = buildSeedState('test');
  ensureValidated(s);
  return s;
}

const PI = 'DOC-PI-0418-R1';
const PO = 'PO-2026-0418';
const SHIP = 'SHP-2026-0088';

describe('supplier document validation', () => {
  let state: DemoState;
  beforeEach(() => {
    state = fresh();
  });

  it('raises exactly the four blocking mismatches and one advisory on the seeded PI', () => {
    const mine = state.discrepancies.filter((d) => d.id.startsWith(`DSC-${PI}-`));
    expect(mine.filter((d) => d.severity === 'blocking')).toHaveLength(4);
    expect(mine.filter((d) => d.severity === 'advisory')).toHaveLength(1);

    const keys = mine.map((d) => d.fieldKey).sort();
    expect(keys).toEqual([
      'header.paymentTerms',
      'line.1.ply',
      'line.1.qty',
      'line.2.unitPrice',
      'line.3.pattern',
    ]);
  });

  it('treats a wording-only pattern difference as advisory, not blocking', () => {
    const d = state.discrepancies.find((x) => x.fieldKey === 'line.3.pattern')!;
    expect(d.severity).toBe('advisory');
    expect(d.ruleId).toBe('PR-1.2');
  });

  it('prices the quantity and unit-price variances in EGP', () => {
    const qty = state.discrepancies.find((x) => x.fieldKey === 'line.1.qty')!;
    // 40 pcs short at USD 268, at 48.50 EGP/USD
    expect(qty.impactEgp).toBe(519_920);

    const price = state.discrepancies.find((x) => x.fieldKey === 'line.2.unitPrice')!;
    // 320 pcs overcharged by USD 4.50
    expect(price.impactEgp).toBe(69_840);
  });

  it('applies the 2% quantity tolerance rather than flagging any difference as blocking', () => {
    const po = state.purchaseOrders.find((p) => p.id === PO)!;
    const doc = structuredClone(state.documents.find((d) => d.id === PI)!);
    // 634 against 640 ordered = 0.94% variance, inside tolerance.
    doc.extraction.find((f) => f.key === 'line.1.qty')!.value = '634';
    const result = validateDocument(state, doc, po);
    const qty = result.find((d) => d.fieldKey === 'line.1.qty')!;
    expect(qty.severity).toBe('advisory');
  });

  it('applies the 0.5% unit-price tolerance', () => {
    const po = state.purchaseOrders.find((p) => p.id === PO)!;
    const doc = structuredClone(state.documents.find((d) => d.id === PI)!);
    doc.extraction.find((f) => f.key === 'line.2.unitPrice')!.value = '285.50'; // 0.35%
    const result = validateDocument(state, doc, po);
    expect(result.find((d) => d.fieldKey === 'line.2.unitPrice')!.severity).toBe('advisory');
  });

  it('reports no mismatch on the clean supplier document', () => {
    expect(state.discrepancies.filter((d) => d.id.startsWith('DSC-DOC-PI-0431-'))).toHaveLength(0);
  });

  it('finds the packing list agrees with the order, isolating the fault to the PI', () => {
    expect(state.discrepancies.filter((d) => d.id.startsWith('DSC-DOC-PL-0418-'))).toHaveLength(0);
  });

  it('computes document totals against the order', () => {
    const doc = state.documents.find((d) => d.id === PI)!;
    const po = state.purchaseOrders.find((p) => p.id === PO)!;
    const t = documentTotals(doc, po);
    expect(t.orderQty).toBe(1140);
    expect(t.documentQty).toBe(1100);
    expect(t.orderValueUsd).toBe(320_340);
    expect(t.documentValueUsd).toBe(311_060);
    expect(t.varianceUsd).toBe(-9280);
  });
});

describe('receiving readiness', () => {
  it('holds the shipment while a blocking mismatch is open', () => {
    const state = fresh();
    const r = receivingReadiness(state, SHIP);
    expect(r.state).toBe('Held - document control');
    expect(r.blockingCount).toBe(4);
  });

  it('reports a shipment still at sea as not yet arrived, not as blocked', () => {
    const state = fresh();
    const r = receivingReadiness(state, 'SHP-2026-0093');
    expect(r.state).toBe('Not yet arrived');
  });

  it('releases readiness once the blocking mismatches are gone, keeping the advisory', () => {
    const state = fresh();
    applyAction(state, { type: 'case.create', documentId: PI });
    const caseId = state.cases[0].id;
    applyAction(state, { type: 'case.generateDraft', caseId });
    applyAction(state, { type: 'case.markSent', caseId });
    applyAction(state, { type: 'case.simulateCorrected', caseId });
    applyAction(state, { type: 'case.revalidate', caseId });

    const r = receivingReadiness(state, SHIP);
    expect(r.state).toBe('Ready for receiving');
    expect(r.blockingCount).toBe(0);
    expect(r.advisoryCount).toBe(1);
    expect(state.cases[0].status).toBe('Resolved');
    // Resolution must not imply arrival or payment.
    expect(state.shipments.find((s) => s.id === SHIP)!.status).toBe('Arrived');
    expect(r.reasons.join(' ')).toMatch(/have not been counted/i);
  });

  it('releases readiness on an override, and records that the mismatches remain', () => {
    const state = fresh();
    applyAction(state, { type: 'case.create', documentId: PI });
    const caseId = state.cases[0].id;
    applyAction(state, { type: 'demo.setRole', userId: 'U-OMAR' });
    applyAction(state, {
      type: 'case.override',
      caseId,
      reason: 'Supplier confirmed the 18PR casing is an approved upgrade at no cost.',
    });
    const r = receivingReadiness(state, SHIP);
    expect(r.state).toBe('Ready for receiving');
    expect(r.overridden).toBe(true);
    expect(state.discrepancies.filter((d) => d.severity === 'blocking' && !d.resolved).length).toBeGreaterThan(0);
  });
});

describe('corrected document', () => {
  it('answers the blocking points but leaves the wording-only difference alone', () => {
    const state = fresh();
    const doc = state.documents.find((d) => d.id === PI)!;
    const po = state.purchaseOrders.find((p) => p.id === PO)!;
    const revised = buildCorrectedDocument(doc, po, '2026-09-17');

    expect(revised.revision).toBe(2);
    expect(revised.supersedesId).toBe(PI);
    expect(revised.extraction.find((f) => f.key === 'line.1.ply')!.value).toBe('16PR');
    expect(revised.extraction.find((f) => f.key === 'line.1.qty')!.value).toBe('640');
    expect(revised.extraction.find((f) => f.key === 'line.2.unitPrice')!.value).toBe('284.50');
    expect(revised.extraction.find((f) => f.key === 'header.paymentTerms')!.value).toBe(po.paymentTerms);
    expect(revised.extraction.find((f) => f.key === 'line.3.pattern')!.value).toBe('Hauler SD-7 (HD)');

    const result = validateDocument(state, revised, po);
    expect(result.filter((d) => d.severity === 'blocking')).toHaveLength(0);
    expect(result.filter((d) => d.severity === 'advisory')).toHaveLength(1);
  });
});
