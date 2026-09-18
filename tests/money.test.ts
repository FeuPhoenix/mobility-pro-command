import { describe, expect, it } from 'vitest';
import {
  DEMO_CURRENCY,
  DEMO_USD_EGP,
  addDays,
  daysBetween,
  formatEGP,
  round2,
  usdToEgp,
} from '@/domain/money';

describe('currency handling', () => {
  it('is denominated in EGP', () => {
    expect(DEMO_CURRENCY).toBe('EGP');
    expect(formatEGP(1234567)).toBe('EGP 1,234,567');
    expect(formatEGP(1234.5, { cents: true })).toBe('EGP 1,234.50');
  });

  it('rounds half-up at the cent boundary without float drift', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('converts USD to EGP at the fixed demo rate', () => {
    expect(usdToEgp(100)).toBe(round2(100 * DEMO_USD_EGP));
    expect(usdToEgp(10_720)).toBe(519_920);
  });
});

describe('dates', () => {
  it('counts whole days between ISO dates', () => {
    expect(daysBetween('2026-02-14', '2026-09-17')).toBe(215);
    expect(daysBetween('2026-07-27', '2026-09-17')).toBe(52);
    expect(daysBetween('2026-08-31', '2026-09-17')).toBe(17);
  });

  it('adds days across month boundaries', () => {
    expect(addDays('2026-09-17', 90)).toBe('2026-12-16');
    expect(addDays('2026-12-16', 12)).toBe('2026-12-28');
  });
});
