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

describe('a figure that is not a rate is refused, not guessed', () => {
  // These all produced "rates" from the real samples before the plausibility
  // check. A wrong rate is worse than a missing one: it reaches the comparison
  // without anyone looking at it, while a missing one is put in front of a
  // person.
  it('does not read a container count as a rate', () => {
    // Met as: "Import 27 x40HC Arabian Tires"
    const q = read('Confirmed order 12 x 40HC Qingdao to Jeddah, USD');
    expect(q.baseFreight.value).toBeNull();
  });

  it('does not read a reference number as a rate', () => {
    // Met as: "freight rate Req -- EQJ-SIGN-26071683", read as minus 26 million.
    const q = read('RE: freight rate Req -- EQJ-SIGN-26071683 for 40HQ');
    expect(q.baseFreight.value).toBeNull();
  });

  it('does not read a column header as a rate', () => {
    // Met as: "20'GP(USD) 40'HQ(USD)" in a rate table header.
    const q = read("POD CARRIER 20'GP(USD) 40'HQ(USD)");
    expect(q.baseFreight.value).toBeNull();
  });

  it('says why, so the reviewer is not left guessing', () => {
    const q = read('Our rate: USD 30 per 40HQ');
    expect(q.baseFreight.value).toBeNull();
    expect(q.baseFreight.note).toMatch(/too small to be an ocean freight rate/i);
  });

  it('still accepts a real rate', () => {
    expect(read('USD 7650/40FT HQ CNTR').baseFreight.value).toBe(7650);
    expect(read('Ocean freight: USD 1850.00 per 40HC').baseFreight.value).toBe(1850);
  });
});

describe('the first plausible rate wins, not the first match', () => {
  it('looks past a junk line to the real rate below it', () => {
    // Met repeatedly: a reference near the top of the message matched the
    // "rate:" label, and the search stopped there - so the genuine rate further
    // down was never reached.
    const q = read(`RE: freight rate Req -- EQJ-SIGN-26071683

Sea freight charges: USD 9715/40HC
Transit time: 24 days`);

    expect(q.baseFreight.value).toBe(9715);
  });

  it('looks past a container count as well', () => {
    const q = read(`Confirmed order 12 x 40HC Qingdao to Jeddah

O/F: USD 10,550/40HC`);

    expect(q.baseFreight.value).toBe(10550);
  });

  it('reads a rate on a lane-labelled line', () => {
    // Met as: "Qingdao-Jeddah:     USD 9975.00 per 40'HC"
    const q = read("Qingdao-Jeddah:     USD 9975.00 per 40'HC");
    expect(q.baseFreight.value).toBe(9975);
  });

  it('reads a rate with the currency after the number', () => {
    // Met as: "RCL 1450 USD/40'HC T/T 17 Days"
    const q = read("Leam Chabang to Dammam Carrier: RCL 1450 USD/40'HC");
    expect(q.baseFreight.value).toBe(1450);
  });

  it('does not treat a cancellation fee as the rate', () => {
    const q = read("*   Cancellation fee: USD 200 per 40' HC");
    expect(q.baseFreight.value).toBeNull();
  });
});

