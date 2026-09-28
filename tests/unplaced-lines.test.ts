/**
 * Charges the reader does not recognise.
 *
 * Every provider words their tariff differently, so meeting an unfamiliar
 * charge is expected and will keep happening. Losing it in silence is not: a
 * quotation that quietly drops a USD 300 line looks cheaper than it is, and
 * nobody reviewing it can tell. These lines are reported instead.
 *
 * The filter has to stay narrow. A warning listing every line with a number in
 * it - dates, container counts, transit times - is a warning nobody reads.
 */

import { describe, expect, it } from 'vitest';
import { scanCharges } from '@/freight/parsers/text';
import { uncertainFields } from '@/freight/domain/extraction';
import type { Quote } from '@/freight/types';

const scan = (text: string) => scanCharges({ label: 'email body', text });
const unplaced = (text: string) => scan(text).unplaced.map((u) => u.text);

describe('an unfamiliar charge is reported, not dropped', () => {
  it('reports a charge nobody wrote a rule for', () => {
    const lines = unplaced(`Base ocean freight: USD 1450.00 per 40HC
Low sulphur fuel levy: USD 300.00 per container
Transit time: 28 days`);

    expect(lines).toEqual(['Low sulphur fuel levy: USD 300.00 per container']);
  });

  it('gives the line number, so it can be found in the source', () => {
    const { unplaced: found } = scan(`Quotation
Base ocean freight: USD 1450.00
Equipment imbalance charge: USD 90.00`);

    expect(found).toEqual([{ line: 3, text: 'Equipment imbalance charge: USD 90.00' }]);
  });

  it('reports an amount written after the number', () => {
    expect(unplaced('Panama transit levy: 210.00 USD per container')).toEqual([
      'Panama transit levy: 210.00 USD per container',
    ]);
  });

  it('says nothing about a charge it did recognise', () => {
    const { surcharges, unplaced: found } = scan('BAF: USD 185.00 per container');
    expect(surcharges).toHaveLength(1);
    expect(found).toEqual([]);
  });
});

describe('it stays quiet about lines that are not charges', () => {
  it('ignores the base freight itself', () => {
    expect(unplaced('Base ocean freight: USD 1450.00 per 40HC')).toEqual([]);
  });

  it('ignores a total', () => {
    expect(unplaced('Total all-in: USD 11799.00')).toEqual([]);
  });

  it('ignores the figures a quotation states about itself', () => {
    expect(
      unplaced(`Transit time: 28 days
Free days at destination: 14 days
Valid until: 2099-12-31`),
    ).toEqual([]);
  });

  it('ignores a line with no amount at all', () => {
    expect(unplaced('Subject to space and equipment availability')).toEqual([]);
  });

  it('ignores what an offer excludes, which is not a charge', () => {
    // These name what the provider is NOT charging for.
    expect(unplaced('Excludes: customs clearance USD 150, delivery order')).toEqual([]);
  });
});

describe('it does not mistake prose for money', () => {
  // The first version matched [A-Z]{3} case-insensitively followed by any
  // digits, commas or dots, so "Hala," was an amount and every quotation
  // reported its own greeting as an unrecognised charge.
  it('ignores a greeting', () => {
    expect(unplaced('Hello Hala,')).toEqual([]);
    expect(unplaced('Kind regards,')).toEqual([]);
  });

  it('ignores a sentence that merely names the request', () => {
    expect(unplaced('Our offer for RFQ-MPD-2026-0001 below. Direct service, no transhipment.')).toEqual([]);
  });

  it('still catches a real amount in the same message', () => {
    expect(
      unplaced(`Hello Hala,

Congestion surcharge: USD 75.00 per container

Kind regards,`),
    ).toEqual(['Congestion surcharge: USD 75.00 per container']);
  });
});

describe('the summary does not call it clean', () => {
  const quote = (unplacedLines: { line: number; text: string }[]) =>
    ({
      baseFreight: { value: 1640, confidence: 'high' },
      currency: { value: 'USD', confidence: 'high' },
      containerBasis: { value: '40HC', confidence: 'high' },
      transitDays: { value: 24, confidence: 'high' },
      validUntil: { value: '2099-12-31', confidence: 'high' },
      surcharges: [],
      unplacedLines,
    }) as unknown as Quote;

  it('says so when a line was not recognised', () => {
    // Otherwise the list says "All figures read cleanly" over a quotation that
    // is missing a charge, which is the opposite of what happened.
    expect(uncertainFields(quote([{ line: 11, text: 'Low sulphur fuel levy: USD 95.00' }]))).toEqual([
      '1 line with an amount was not recognised',
    ]);
  });

  it('stays quiet when everything was placed', () => {
    expect(uncertainFields(quote([]))).toEqual([]);
  });
});

