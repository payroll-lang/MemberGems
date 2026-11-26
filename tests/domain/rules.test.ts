import { describe, expect, it } from 'vitest';
import {
  annualTax, approvedSince, balanceTotals, buildTaxTables, canAutoReprice, canEditOptions, canSendBack,
  computeGrantBalances, DEFAULT_SETTINGS, editClearsSignature, flatTaxAmount, fmvErrorMessage, fmvFor,
  fmvFromPrices, indicativeGain, indicativeQuote, isGrantRowAllowed, previousTradingDay, price, progress,
  resolveMultiplier, settingsFromConfig, shareGranularity, signatureNameMatches, stepFor, submitBlocker,
  taxDueDateFor, taxForExercise, taxPositionUsable, validateAddress, validateDemat, validateExercisePaymentAmount,
  validateLines, validateSignature, validateTaxPaymentEntry, windowFor, windowState,
  type GrantRecord, type ProgressInput, type TaxPosition
} from '@/domain';

const TOTAL = settingsFromConfig({ LOT_SCOPE: 'total' });

function grant(over: Partial<GrantRecord> = {}): GrantRecord {
  return { grantId: 'G1', employeeId: 'PW1', planName: 'ESOP Plan 2022', multiplier: 3.6, vestedOptions: 500, grantDate: '2022-05-01', reportAsOn: '2026-10-31', ...over };
}

describe('lots', () => {
  it('granularity and step', () => {
    expect(shareGranularity(3.6)).toBe(5);
    expect(shareGranularity(1)).toBe(1);
    expect(shareGranularity(2.5)).toBe(2);
    expect(stepFor(3.6, DEFAULT_SETTINGS)).toBe(10);
    expect(stepFor(1, DEFAULT_SETTINGS)).toBe(1);
    expect(stepFor(3.6, TOTAL)).toBe(5);
  });

  const balances = computeGrantBalances({
    grants: [grant(), grant({ grantId: 'G2', planName: 'ESOP Plan 2025', multiplier: 1, vestedOptions: 7 }), grant({ grantId: 'G3', vestedOptions: 8 })],
    applications: [], lines: [], today: '2026-11-20', settings: DEFAULT_SETTINGS
  });

  it('validates lots per grant, with the legacy messages', () => {
    const ok = validateLines([{ grantId: 'G1', options: 100 }, { grantId: 'G2', options: 7 }], balances, DEFAULT_SETTINGS);
    expect(ok).toEqual({
      ok: true, lines: [
        { grantId: 'G1', planName: 'ESOP Plan 2022', multiplier: 3.6, options: 100, shares: 360, exercisePrice: 1, lineExerciseAmount: 100 },
        { grantId: 'G2', planName: 'ESOP Plan 2025', multiplier: 1, options: 7, shares: 7, exercisePrice: 1, lineExerciseAmount: 7 }
      ]
    });
    expect(validateLines([{ grantId: 'G1', options: 15 }], balances, DEFAULT_SETTINGS))
      .toEqual({ ok: false, error: 'For grant G1, options must be in multiples of 10. You entered 15 — use 10 or 20.' });
    expect(validateLines([{ grantId: 'G3', options: 5 }], balances, DEFAULT_SETTINGS))
      .toEqual({ ok: false, error: 'Grant G3 has 8 vested options, which is less than one lot of 10. It cannot be exercised on its own.' });
    expect(validateLines([], balances, DEFAULT_SETTINGS))
      .toEqual({ ok: false, error: 'Enter the number of options you wish to exercise on at least one grant.' });
  });

  it('FIX (review item 12): duplicate lines for one grant are validated on their combined total', () => {
    expect(validateLines([{ grantId: 'G1', options: 300 }, { grantId: 'G1', options: 300 }], balances, DEFAULT_SETTINGS))
      .toEqual({ ok: false, error: 'Grant G1 has 500 options available to exercise. You entered 600.' });
    const merged = validateLines([{ grantId: 'G1', options: 5 }, { grantId: 'G2', options: 3 }, { grantId: ' G1 ', options: '5' }], balances, DEFAULT_SETTINGS);
    expect(merged.ok && merged.lines.map((l) => [l.grantId, l.options, l.shares])).toEqual([['G1', 10, 36], ['G2', 3, 3]]);
    expect(validateLines([{ grantId: 'G1', options: 20 }, { grantId: 'G1', options: -10 }], balances, DEFAULT_SETTINGS))
      .toEqual({ ok: false, error: 'Enter a positive number of options for grant G1.' });
  });

  it("'total' scope: per-grant granularity, total must be a whole lot", () => {
    const b = computeGrantBalances({ grants: [grant({ vestedOptions: 8 }), grant({ grantId: 'G2', multiplier: 1, vestedOptions: 7 })], applications: [], lines: [], today: '2026-11-20', settings: TOTAL });
    expect(validateLines([{ grantId: 'G1', options: 5 }, { grantId: 'G2', options: 5 }], b, TOTAL).ok).toBe(true);
    expect(validateLines([{ grantId: 'G1', options: 5 }, { grantId: 'G2', options: 3 }], b, TOTAL))
      .toEqual({ ok: false, error: 'Your total across all grants must be a multiple of 10. You have entered 8 — adjust to 0 or 10.' });
  });
});

describe('eligibility', () => {
  it('holds: live and current-window approvals hold; rejected and abandoned drafts do not', () => {
    const b = computeGrantBalances({
      grants: [grant()],
      applications: [
        { appId: 'A', status: 'Submitted', windowId: '2026-10' },
        { appId: 'B', status: 'Approved', windowId: '2026-11', approvedAt: '2026-11-03 10:00:00' },
        { appId: 'C', status: 'Rejected', windowId: '2026-11' },
        { appId: 'D', status: 'Draft', windowId: '2026-10' },
        { appId: 'E', status: 'Approved', windowId: '2026-10', approvedAt: '2026-10-20 10:00:00' },
        { appId: 'F', status: 'Draft', windowId: '2026-11' }
      ],
      lines: ['A', 'B', 'C', 'D', 'E', 'F'].map((appId) => ({ appId, grantId: 'G1', optionsExercised: 10 })),
      excludeAppId: 'F', today: '2026-11-20', settings: DEFAULT_SETTINGS
    });
    expect(b[0].pledgedElsewhere).toBe(20); // A + B
    expect(b[0].availableOptions).toBe(480);
    expect(b[0].exercisableShares).toBe(1728);
    expect(balanceTotals(b).stranded).toBe(0);
    expect(indicativeGain(b, 100)).toBe(480 * 3.6 * 100 - 480);
  });

  it('grant-sync filters: Test Plan is no longer allowed; blank multiplier defaults', () => {
    expect(isGrantRowAllowed('ESOP Plan 2022', 'Accepted', DEFAULT_SETTINGS)).toEqual({ ok: true });
    expect(isGrantRowAllowed('Test Plan', 'Accepted', DEFAULT_SETTINGS)).toEqual({ ok: false, reason: 'PLAN' });
    expect(isGrantRowAllowed('ESOP Plan 2025', 'Cancelled', DEFAULT_SETTINGS)).toEqual({ ok: false, reason: 'STATUS' });
    expect(isGrantRowAllowed('ESOP Plan 2025', undefined, DEFAULT_SETTINGS)).toEqual({ ok: true });
    expect(resolveMultiplier('', DEFAULT_SETTINGS)).toEqual({ ok: true, multiplier: 1, defaulted: true });
    expect(resolveMultiplier('3.6', DEFAULT_SETTINGS)).toEqual({ ok: true, multiplier: 3.6, defaulted: false });
    expect(resolveMultiplier('x', DEFAULT_SETTINGS)).toEqual({ ok: false });
  });
});

describe('FMV — AGREED CHANGE: previous trading day exactly, no fallback', () => {
  const rows = [
    { date: '2026-11-19', openPrice: 140, closePrice: 141.05 },
    { date: '2026-11-20', openPrice: 150.11, closePrice: 150.2 },
    { date: '2026-11-13', openPrice: 0, closePrice: 0, fmv: 133.333 }
  ];
  it('skips weekends', () => {
    expect(previousTradingDay('2026-11-23', [])).toBe('2026-11-20'); // Monday → Friday
    const r = fmvFor('2026-11-23', rows, []);
    expect(r).toMatchObject({ ok: true, date: '2026-11-20', fmv: 150.16, open: 150.11, close: 150.2 });
  });
  it('skips listed holidays', () => {
    expect(fmvFor('2026-11-23', rows, ['2026-11-20'])).toMatchObject({ ok: true, date: '2026-11-19', fmv: 140.53 });
  });
  it('refuses when the trading day has no price, even if an older one exists', () => {
    const r = fmvFor('2026-11-17', rows, []);
    expect(r).toEqual({ ok: false, reason: 'PRICE_MISSING', date: '2026-11-16' });
    if (!r.ok) expect(fmvErrorMessage(r)).toContain('16 Nov 2026');
    expect(fmvFor('', rows, [])).toEqual({ ok: false, reason: 'NO_DATE', date: '' });
  });
  it('uses the stated FMV only when open/close are not both positive', () => {
    expect(fmvFor('2026-11-16', rows, [])).toMatchObject({ ok: true, date: '2026-11-13', fmv: 133.33 });
    expect(fmvFromPrices('100', 101.01)).toEqual({ ok: true, open: 100, close: 101.01, fmv: 100.51 });
    expect(fmvFromPrices(0, 1).ok).toBe(false);
  });
});

describe('pricing', () => {
  const lines = [{ grantId: 'G1', options: 100, multiplier: 3.6, exercisePrice: 1 }];
  it('shares, exercise amount, perquisite (hand-computed)', () => {
    const p = price(lines, 145.25, 31.2, { flatRounding: 'paise' });
    expect(p.totalShares).toBe(360);
    expect(p.exerciseAmount).toBe(100);
    expect(p.perquisiteAmount).toBe(52190); // 145.25 × 360 − 100
    expect(p.lines[0].perquisitePerShare).toBe(144.97);
    expect(p.taxAmount).toBe(16283.28); // legacy paise
  });
  it('AGREED CHANGE: flat tax in whole rupees = Math.round(perquisite × rate / 100)', () => {
    expect(price(lines, 145.25, 31.2, { flatRounding: 'rupee' }).taxAmount).toBe(16283);
    expect(flatTaxAmount(1000.5, 50, 'rupee')).toBe(500); // 500.25
    expect(flatTaxAmount(1001, 50, 'rupee')).toBe(501); // 500.5 rounds up
    expect(flatTaxAmount(1001, 50, 'paise')).toBe(500.5);
    const fallback = taxForExercise({ perquisite: 52190, flatRate: 31.2, position: null, applications: [], appId: 'A', flatRounding: 'rupee' });
    expect(fallback).toEqual({
      amount: 16283, method: 'Flat', effectivePercent: 31.2,
      breakdown: { v: 1, method: 'Flat', reason: 'No row for this participant in the tax sheet', ratePercent: 31.2, perquisite: 52190, collect: 16283 }
    });
  });
  it('no FMV → no perquisite; FMV below price → perquisite 0', () => {
    expect(price(lines, null, 30, { flatRounding: 'rupee' })).toMatchObject({ perquisiteAmount: 0, taxAmount: 0, taxMethod: 'None' });
    expect(price(lines, 0.25, 30, { flatRounding: 'rupee' })).toMatchObject({ perquisiteAmount: 0, taxMethod: 'None' });
  });
  it('indicative quote only while the FMV is not fixed', () => {
    const q = { latest: { fmv: 145.25, date: '2026-11-19' }, lines, taxRatePercent: 31.2, opts: { flatRounding: 'rupee' as const } };
    expect(indicativeQuote({ ...q, fixedFmvValue: 0 })).toMatchObject({ fmv: 145.25, perquisiteAmount: 52190, taxAmount: 16283 });
    expect(indicativeQuote({ ...q, fixedFmvValue: 150 })).toBeNull();
    expect(indicativeQuote({ ...q, latest: null, fixedFmvValue: '' })).toBeNull();
  });
});

describe('tax engine (hand-computed)', () => {
  it('rebate and its marginal relief (new regime)', () => {
    expect(annualTax('New', 1200000).total).toBe(0);
    expect(annualTax('New', 1210000)).toMatchObject({ base: 61500, tax: 10000, rebate: 51500, cess: 400, total: 10400 });
    expect(annualTax('New', 1200001).income).toBe(1200010);
  });
  it('old regime rebate has no marginal relief', () => {
    expect(annualTax('Old', 500000).total).toBe(0);
    expect(annualTax('Old', 500010)).toMatchObject({ tax: 12502, cess: 500, total: 13002 });
  });
  it('surcharge marginal relief just above 50 lakh', () => {
    expect(annualTax('New', 5000010)).toMatchObject({
      tax: 1080003, surchargeRate: 10, surchargeRaw: 108000, surcharge: 7, marginalRelief: 107993, cess: 43200, total: 1123210
    });
    expect(annualTax('New', 60000000).surchargeRate).toBe(25); // no 37% band in the new regime
    expect(annualTax('Old', 60000000).surchargeRate).toBe(37);
  });
  it('sheet method: perquisite crossing the rebate limit', () => {
    const position: TaxPosition = { regime: 'New', netTaxable: 1200000, totalGross: 1200000, projectedGross: 400000, remainingMonths: 4, asOn: '2026-10-31' };
    const t = taxForExercise({ perquisite: 10000, flatRate: 30, position, applications: [], appId: 'A', flatRounding: 'rupee' });
    expect(t).toMatchObject({ amount: 10400, method: 'Sheet', effectivePercent: 104 });
  });
  it('sheet method: surcharge cliff split by the earned share', () => {
    const position: TaxPosition = { regime: 'New', netTaxable: 4900000, totalGross: 4900000, projectedGross: 1225000, remainingMonths: 3, asOn: '2026-12-31' };
    const t = taxForExercise({ perquisite: 200000, flatRate: 30, position, applications: [], appId: 'A', flatRounding: 'rupee' });
    if (t.breakdown?.method !== 'Sheet') throw new Error('expected sheet');
    const b = t.breakdown;
    expect(b.earnedShare).toBe(0.75);
    expect(b.cliff).toBeGreaterThan(0);
    expect(Math.abs(b.cliffNow + b.cliffLater - b.cliff)).toBeLessThanOrEqual(1);
    expect(b.collect + b.left).toBe(b.whole);
  });
  it('prior approvals after the as-on date add to income', () => {
    const apps = [
      { appId: 'A1', status: 'Approved', approvedAt: '2026-10-31 23:59:59', perquisiteAmount: 100 },
      { appId: 'A2', status: 'Approved', approvedAt: '2026-11-01 00:00:00', perquisiteAmount: 200.005 },
      { appId: 'A3', status: 'Submitted', approvedAt: '2026-11-05', perquisiteAmount: 400 },
      { appId: 'SELF', status: 'Approved', approvedAt: '2026-11-05', perquisiteAmount: 800 }
    ];
    expect(approvedSince(apps, '2026-10-31', 'SELF')).toEqual({ amount: 200.01, appIds: ['A2'] });
    expect(approvedSince(apps, '', 'SELF').appIds).toEqual(['A1', 'A2']);
  });
  it('unusable rows fall back with the legacy reason', () => {
    expect(taxPositionUsable({ regime: '', netTaxable: 1, totalGross: 0, projectedGross: 0, remainingMonths: 0, asOn: '' }))
      .toEqual({ ok: false, why: 'Payroll shows no tax regime for this participant' });
    expect(taxPositionUsable({ regime: 'new', netTaxable: 1, totalGross: 0, projectedGross: 0, remainingMonths: 0, asOn: '', flags: ['NEG_MONTHS', 'MISMATCH'] }))
      .toMatchObject({ ok: false });
    expect(taxPositionUsable({ regime: 'Old', netTaxable: 1, totalGross: 0, projectedGross: 0, remainingMonths: 0, asOn: '', flags: 'OVER_DEDUCTED' }))
      .toEqual({ ok: true, regime: 'Old' });
  });
  it('a regime whose slab rows were deleted keeps the shipped slabs', () => {
    const t = buildTaxTables([{ regime: 'Old', above: 0, rate: 10 }]);
    expect(t.New.slabs.length).toBe(7);
    expect(t.Old.slabs).toEqual([{ above: 0, rate: 10 }]);
  });
});

describe('windows', () => {
  it('clamps close day and due day to the month', () => {
    expect(windowFor('2027-02-10', DEFAULT_SETTINGS)).toEqual({
      windowId: '2027-02', label: 'February 2027', openDate: '2027-02-01', closeDate: '2027-02-28', taxDueDate: '2027-03-25', status: 'Open'
    });
    expect(taxDueDateFor('2026-11-25', DEFAULT_SETTINGS)).toBe('2026-11-25');
    expect(taxDueDateFor('2026-11-26', DEFAULT_SETTINGS)).toBe('2026-12-25');
    expect(taxDueDateFor('2026-01-30', settingsFromConfig({ TAX_DUE_DAY: '30' }))).toBe('2026-01-30');
    expect(taxDueDateFor('2026-01-31', settingsFromConfig({ TAX_DUE_DAY: '30' }))).toBe('2026-02-28');
  });
  it('window state', () => {
    const w = { label: 'November 2026', openDate: '2026-11-01', closeDate: '2026-11-30', status: 'Open' };
    expect(windowState(w, '2026-11-26')).toEqual({ open: true, reason: 'Open until 30 Nov 2026 · 4 days left' });
    expect(windowState(w, '2026-12-01')).toEqual({ open: false, reason: 'The November 2026 window closed on 30 Nov 2026.' });
    expect(windowState({ ...w, status: 'Closed' }, '2026-11-26').open).toBe(false);
  });
});

describe('progress and editability', () => {
  const blank: ProgressInput = {
    status: 'Draft', totalOptions: 100, dematDPId: 'IN300123', dematClientId: '12345678', cmlFileId: 'c', panFileId: 'p',
    panNumber: 'ABCDE1234F', applicantAddress: '12 Long Street', applicantNationality: 'Indian', applicantMobile: '9876543210',
    exercisePaymentUTR: 'UTR123', exercisePaymentDate: '2026-11-05', exerciseProofFileId: 'x', fmvValue: 120,
    noticeSignedAt: '', taxMode: 'Self', taxAmount: 1000, taxMethod: 'Flat', taxPaidTotal: 999, partnerRequestStatus: null
  };
  it('tax done within ₹1; nil sheet tax counts as done; stage is the first unfinished', () => {
    expect(progress(blank)).toEqual({
      done: { options: true, demat: true, exercise: true, tax: true, notice: false, submit: false },
      stage: 'notice', pendingLabels: ['Exercise notice'], complete: false
    });
    expect(progress({ ...blank, taxPaidTotal: 998.99 }).stage).toBe('tax');
    expect(progress({ ...blank, taxMode: '', taxAmount: 0, taxMethod: 'Sheet' }).done.tax).toBe(true);
    expect(progress({ ...blank, taxMode: '', taxAmount: 0, taxMethod: 'Flat' }).done.tax).toBe(false);
    expect(progress({ ...blank, taxMode: 'FundPartner', partnerRequestStatus: 'Assigned' }).done.tax).toBe(false);
    expect(progress({ ...blank, taxMode: 'FundPartner', partnerRequestStatus: 'Payment Fed' }).done.tax).toBe(true);
  });
  it('submit gate', () => {
    const p = progress({ ...blank, noticeSignedAt: '2026-11-06 10:00:00' });
    expect(submitBlocker(p, {})).toBe('');
    expect(submitBlocker(p, { demat: 'Sent Back', notice: 'Verified' }))
      .toBe('The ESOP team sent these back and they have not been corrected yet: demat and PAN. Correct and save each one, then submit again.');
    expect(submitBlocker(progress(blank), {})).toBe('Still to finish before you can submit: Exercise notice.');
  });
  it('options fixed once paid unless the payment was sent back', () => {
    expect(canEditOptions({ fmvValue: 0, exercisePaymentUTR: '', reviewExercisePayment: 'Pending' })).toEqual({ ok: true, clearFmv: false });
    expect(canEditOptions({ fmvValue: 120, exercisePaymentUTR: '', reviewExercisePayment: 'Pending', appId: 'APP-1' }).ok).toBe(false);
    expect(canEditOptions({ fmvValue: 120, exercisePaymentUTR: 'U', reviewExercisePayment: 'Sent Back' })).toEqual({ ok: true, clearFmv: true });
  });
  it('AGREED CHANGES: no send-back after approval/rejection; no auto-reprice after submission; edits clear the signature', () => {
    expect(canSendBack('Approved')).toBe(false);
    expect(canSendBack('Rejected')).toBe(false);
    expect(canSendBack('Under Review')).toBe(true);
    expect(canAutoReprice('Draft')).toBe(true);
    expect(canAutoReprice('Sent Back')).toBe(true);
    expect(canAutoReprice('Submitted')).toBe(false);
    expect(editClearsSignature('demat', '2026-11-06 10:00:00')).toBe(true);
    expect(editClearsSignature('notice', '2026-11-06 10:00:00')).toBe(false);
    expect(editClearsSignature('options', '')).toBe(false);
  });
});

describe('validation', () => {
  it('demat shapes', () => {
    const base = { dematDPName: 'DP', dematAccountName: 'Asha' };
    expect(validateDemat({ ...base, dematDPId: 'in300123', dematClientId: '12345678', dematAccountType: '' }))
      .toEqual({ ok: true, value: { dpId: 'IN300123', clientId: '12345678', accountType: 'NSDL' } });
    expect(validateDemat({ ...base, dematDPId: '12081600', dematClientId: '00012345', dematAccountType: '' }))
      .toEqual({ ok: true, value: { dpId: '12081600', clientId: '00012345', accountType: 'CDSL' } });
    expect(validateDemat({ ...base, dematDPId: '12081600', dematClientId: '00012345', dematAccountType: 'NSDL' }).ok).toBe(false);
  });
  it('signature: first name required, further words in order', () => {
    expect(signatureNameMatches('Asha', 'Asha Kumari Rao')).toBe(true);
    expect(signatureNameMatches('asha rao', 'Asha Kumari Rao')).toBe(true);
    expect(signatureNameMatches('Rao Asha', 'Asha Kumari Rao')).toBe(false);
    expect(signatureNameMatches('Asha Rao Kumari', 'Asha Kumari Rao')).toBe(false);
    expect(validateSignature({ accepted: true, place: 'Noida', signatureName: 'Kumari', expectedName: 'Asha Kumari Rao' }))
      .toEqual({ ok: false, error: 'Sign with your own name as it appears on your record — "Asha" on its own is enough, or the full name "Asha Kumari Rao".' });
    expect(validateSignature({ accepted: false, place: '', signatureName: '', expectedName: 'A' }))
      .toEqual({ ok: false, error: 'Tick the declaration to sign the notice.' });
  });
  it('address, exercise amount within ₹1, tax instalments', () => {
    expect(validateAddress('short').ok).toBe(false);
    expect(validateAddress('  12 Long Street ')).toEqual({ ok: true, value: '12 Long Street' });
    expect(validateExercisePaymentAmount('', 360)).toEqual({ ok: true, value: 360 });
    expect(validateExercisePaymentAmount(361, 360)).toEqual({ ok: true, value: 361 });
    expect(validateExercisePaymentAmount(361.5, 360).ok).toBe(false);
    const entry = { due: 5000, alreadyPaid: 2000, utr: 'utr123456', existing: [{ utr: 'UTR999999', amount: 2000, paymentDate: '2026-11-05' }] };
    expect(validateTaxPaymentEntry({ ...entry, amount: 3001 })).toEqual({ ok: true, value: { amount: 3001, remaining: 3000 } });
    expect(validateTaxPaymentEntry({ ...entry, amount: 3001.01 }).ok).toBe(false);
    expect(validateTaxPaymentEntry({ ...entry, amount: 100, utr: 'utr999999' }))
      .toEqual({ ok: false, error: 'UTR UTR999999 is already recorded against this application, for ₹2,000 on 05 Nov 2026.' });
    expect(validateTaxPaymentEntry({ ...entry, alreadyPaid: 5000, amount: 1 }).ok).toBe(false);
  });
});
