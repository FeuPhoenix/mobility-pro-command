/**
 * How carriers actually write quotations.
 *
 * Every shape here was met in a real provider reply. The figures, names and
 * ports are invented - the customer's quotations are not ours to publish, and
 * this repository is public - but the *shapes* are verbatim, which is the part
 * that matters.
 *
 * Add to this file whenever a new format turns up, before touching a pattern.
 */

import { describe, expect, it } from 'vitest';
import { extractFromText, parseContainerType } from '@/freight/parsers/text';

const read = (text: string) => extractFromText({ label: 'email body', text });

describe('container size, as carriers write it', () => {
  // HQ and HC are the same box. Different lines write it differently, and
  // treating them as different bases would stop two comparable offers being
  // compared at all.
  it.each([
    ['40HQ', '40HC'],
    ["40'HC", '40HC'],
    ['40FT HQ CNTR', '40HC'],
    ['40 HC', '40HC'],
    ["20'GP(USD)", '20GP'],
    ['20GP', '20GP'],
    ['40DC', '40GP'],
    ["45'HQ", '45HC'],
    ['20RF', '20RF'],
    ['LCL', 'LCL'],
  ])('reads %s as %s', (written, expected) => {
    expect(parseContainerType(written)).toBe(expected);
  });

  it('does not read a bare number as a container', () => {
    expect(parseContainerType('40 tyres')).toBeNull();
    expect(parseContainerType('Total 20 pallets')).toBeNull();
  });
});

describe('the rate line, unlabelled', () => {
  it('reads a rate written with no space and a slashed basis', () => {
    // Met as: "My S/R: USD5800/40HQ"
    const q = read('My S/R: USD5800/40HQ');

    expect(q.baseFreight.value).toBe(5800);
    expect(q.currency.value).toBe('USD');
    expect(q.containerBasis.value).toBe('40HC');
  });

  it('reads a rate with the size spelled out after it', () => {
    // Met as: "USD 7650/40FT HQ CNTR"
    const q = read('USD 7650/40FT HQ CNTR');

    expect(q.baseFreight.value).toBe(7650);
    expect(q.containerBasis.value).toBe('40HC');
  });

  it('reads a rate introduced as a selling rate', () => {
    const q = read('Our rate: USD 4,250.00 per 40HQ');
    expect(q.baseFreight.value).toBe(4250);
  });

  it('does not mistake a total for the freight rate', () => {
    const q = read(`Ocean freight: USD 1850.00 per 40HC
Total cost: USD 9,600.00`);

    expect(q.baseFreight.value).toBe(1850);
    expect(q.totalQuoted.value).toBe(9600);
  });

  it('does not take a surcharge as the rate when nothing is labelled', () => {
    // Only surcharge lines carry a box size here, and none of them is the rate.
    const q = read(`THC: USD 120.00 per 40HQ
ISPS: USD 14.00 per 40HQ`);

    expect(q.baseFreight.value).toBeNull();
    expect(q.surcharges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('values that sit in the next line, as tables flatten', () => {
  // Quotations are usually HTML tables. Flattened, the header and its value
  // land on separate lines.
  it('reads a transit time under its header', () => {
    const q = read(`TRANSIT TIME
26 days`);
    expect(q.transitDays.value).toBe(26);
  });

  it('reads a validity date under its header', () => {
    const q = read(`VALIDITY
26 Aug 2026`);
    expect(q.validUntil.value).toBe('2026-08-26');
  });

  it('reads free time under its header', () => {
    const q = read(`FREE TIME
21 days at destination`);
    expect(q.freeDaysDestination.value).toBe(21);
  });

  it('still prefers a value on the label line itself', () => {
    const q = read(`Transit time: 18 days
30 days`);
    expect(q.transitDays.value).toBe(18);
  });

  it('does not let one header borrow another header’s value', () => {
    // Two headers in a row, then one value: the value belongs to the second.
    const q = read(`TRANSIT TIME
VALIDITY
26 Aug 2026`);

    expect(q.validUntil.value).toBe('2026-08-26');
    expect(q.transitDays.value).toBeNull();
  });
});

describe('validity, as carriers word it', () => {
  it.each([
    ['Validity: 26 Aug 2026', '2026-08-26'],
    ['Rate validity: 2026-08-26', '2026-08-26'],
    ['Valid till 26 Aug 2026', '2026-08-26'],
    ['Valid until: 26/08/2026', '2026-08-26'],
  ])('reads %s', (line, expected) => {
    expect(read(line).validUntil.value).toBe(expected);
  });
});
