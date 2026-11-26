import { describe, expect, it } from 'vitest';
import {
  addDays, ceilTo, count, DEFAULT_SETTINGS, inr, inr2, instantMs, inWords, lotSize, num, parseEmployeeIdList,
  paymentReference, prettyDate, prettyStamp, round2, round6, settingsFromConfig, toDateKey, windowKey
} from '@/domain';

describe('util', () => {
  it('num tolerates typed money', () => {
    expect(num('₹ 1,25,000.50')).toBe(125000.5);
    expect(num('(250)')).toBe(-250);
    expect(num('Rs 500')).toBe(500);
    // LEGACY BUG kept for fidelity: /\brs\.?\b/ cannot eat the dot before a space,
    // so "Rs. 500" leaves ".500" and reads as 0.5.
    expect(num('Rs. 500')).toBe(0.5);
    expect(num('12%')).toBe(12);
    expect(num('-', 7)).toBe(7);
    expect(num('abc', 3)).toBe(3);
    expect(num(true)).toBe(1);
  });

  it('toDateKey reads the legacy formats and rolls over like new Date(y, m, d)', () => {
    expect(toDateKey('2026-9-8')).toBe('2026-09-08');
    expect(toDateKey('2026-09-08 20:44:02')).toBe('2026-09-08');
    expect(toDateKey('08/09/2026')).toBe('2026-09-08');
    expect(toDateKey('Sep 08, 2026')).toBe('2026-09-08');
    expect(toDateKey('08-Sep-2026')).toBe('2026-09-08');
    expect(toDateKey('2026-02-31')).toBe('2026-03-03');
    expect(toDateKey(46273)).toBe('2026-09-08');
    expect(toDateKey(new Date('2026-09-07T20:00:00Z'))).toBe('2026-09-08'); // 01:30 IST
    for (const blank of ['', '-', '0', 0, null, undefined]) expect(toDateKey(blank)).toBe('');
  });

  it('instantMs treats offset-less stamps as IST', () => {
    expect(instantMs('2026-09-08 05:30:00')).toBe(Date.parse('2026-09-08T00:00:00Z'));
    expect(instantMs('2026-09-08T00:00:00Z')).toBe(Date.parse('2026-09-08T00:00:00Z'));
    expect(instantMs('2026-09-08T10:00:00+05:30')).toBe(Date.parse('2026-09-08T04:30:00Z'));
    expect(instantMs('2026-09-08')).toBe(Date.parse('2026-09-07T18:30:00Z'));
    expect(instantMs('')).toBeNull();
  });

  it('dates and window keys', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(windowKey('2026-9')).toBe('2026-09');
    expect(windowKey('September 2026')).toBe('2026-09');
    expect(prettyDate('2026-09-08')).toBe('08 Sep 2026');
    expect(prettyStamp('2026-09-08T15:14:02Z')).toBe('08 Sep 2026 at 20:44 IST');
  });
});

describe('money', () => {
  it('rounding helpers', () => {
    expect(round2(1.005)).toBe(1); // same float behaviour as the legacy inline expression
    expect(round2(2.675 * 100 / 100)).toBe(Math.round(2.675 * 100) / 100);
    expect(round6(0.1 + 0.2)).toBe(0.3);
    expect(ceilTo(1200001, 10)).toBe(1200010);
    expect(ceilTo(1200010, 10)).toBe(1200010);
    expect(ceilTo(1200010.4, 1)).toBe(1200010);
  });

  it('Indian grouping and words', () => {
    expect(inr(230926)).toBe('₹2,30,926');
    expect(inr(-1234567.6)).toBe('-₹12,34,568');
    expect(inr2(79.5)).toBe('₹79.50');
    expect(count(12345678)).toBe('1,23,45,678');
    expect(inWords(230926)).toBe('Rupees Two Lakh Thirty Thousand Nine Hundred Twenty Six only');
    expect(inWords(12345678.9)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise only');
    expect(inWords(0)).toBe('Rupees Zero only');
    expect(inWords(-2.5)).toBe('Minus Rupees Two and Fifty Paise only');
  });
});

describe('config', () => {
  it('defaults mirror CONFIG_DEFAULTS, without Test Plan', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      exercisePrice: 1, optionLotSize: 10, lotScope: 'grant', defaultMultiplier: 1,
      allowedPlans: ['ESOP Plan 2022', 'ESOP Plan 2025'],
      allowedGrantStatuses: ['Accepted', 'PendingAcceptance'],
      windowOpenDay: 1, windowCloseDay: 30, taxDueDay: 25, eligibleEmployeeIds: [],
      paymentReferenceFormat: 'ESOP Exercise – {EMPLOYEE_ID} – {NAME}', flatTaxRounding: 'rupee'
    });
  });

  it('legacy fallbacks: blank = default, non-numeric = default, REQUIRE_GRANT_ACCEPTED=false = all statuses', () => {
    const s = settingsFromConfig({ OPTION_LOT_SIZE: 'ten', EXERCISE_PRICE: '', LOT_SCOPE: ' TOTAL ', REQUIRE_GRANT_ACCEPTED: 'FALSE', FLAT_TAX_ROUNDING: 'paise', DEFAULT_MULTIPLIER: '0' });
    expect(s.optionLotSize).toBe(10);
    expect(s.exercisePrice).toBe(1);
    expect(s.lotScope).toBe('total');
    expect(s.allowedGrantStatuses).toBeNull();
    expect(s.flatTaxRounding).toBe('paise');
    expect(s.defaultMultiplier).toBe(1);
    expect(lotSize(settingsFromConfig({ OPTION_LOT_SIZE: '-5' }))).toBe(10);
    expect(settingsFromConfig({ ALLOWED_GRANT_STATUSES: ' , ' }).allowedGrantStatuses).toBeNull();
  });

  it('eligible list and payment reference', () => {
    expect(parseEmployeeIdList(' pw1, PW2;pw3\npw1 ')).toEqual(['PW1', 'PW2', 'PW3']);
    expect(paymentReference(DEFAULT_SETTINGS, { employeeId: 'PW42', name: 'Asha Rao' })).toBe('ESOP Exercise – PW42 – Asha Rao');
  });
});
