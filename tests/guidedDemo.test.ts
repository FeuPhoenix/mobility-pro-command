import { describe, expect, it } from 'vitest';
import { GUIDE_STEPS } from '@/components/GuidedDemo';

describe('plain-language guided demo', () => {
  it('takes a presenter through the complete business flow in eight short stops', () => {
    expect(GUIDE_STEPS).toHaveLength(8);
    expect(GUIDE_STEPS.map((step) => step.href)).toEqual([
      '/',
      '/operations/documents/DOC-PI-0418-R1',
      '/operations/inventory/OPP-2026-014',
      '/operations/orders',
      '/operations/orders/SO-2026-0766',
      '/approvals',
      '/automations',
      '/',
    ]);
  });

  it('keeps every stop brief and tells the presenter what to do', () => {
    for (const step of GUIDE_STEPS) {
      expect(step.body.length).toBeLessThanOrEqual(240);
      expect(step.tryThis).toBeTruthy();
      expect(step.look?.length).toBeLessThanOrEqual(2);
    }
  });

  it('explains that the n8n workflows are real exports but the demo is not connected', () => {
    const automationStep = GUIDE_STEPS.find((step) => step.href === '/automations');
    expect(automationStep?.body).toMatch(/not connected/i);
    expect(automationStep?.body).toMatch(/real.*import/i);
  });
});
