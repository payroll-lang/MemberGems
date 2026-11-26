import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, settingsFromConfig } from '@/domain';
import type { ApplicationDoc, EmployeeDoc, TaxPaymentDoc } from '@/lib/schema';
import { newApplicationDoc } from '@/server/core/applications';
import { normalizeEmployee } from '@/server/core/employees';
import { parseDetailsRows, parseRateRows, planDetails, planEnabledList, planRates } from '@/server/admin/core/bulkPaste';
import { EXPORT_COLUMNS, exportRowsFor, sheetStamp } from '@/server/admin/core/exportRows';
import { blankEmployee, loginEmailSync, planEmployeeUpserts, rollupGrantReport } from '@/server/admin/core/grantReport';
import { parseCsv, parseIdList, parsePaste } from '@/server/admin/core/grid';
import { missingPriceDays, parseHolidays } from '@/server/admin/core/prices';
import { filterParticipants, filterQueue, grantTotalsByEmployee, participantRows, queueRow, type QueueRow } from '@/server/admin/core/queue';
import { assertReviewable, unverifiedSections } from '@/server/admin/core/review';
import { parseTaxRules, validateSetting } from '@/server/admin/core/settingsRules';
import { participantTaxRows, readTaxCsv, sanitizeTaxRow, taxRowsFromGrid } from '@/server/admin/core/taxSheet';

const LEGACY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'legacy', 'apps-script');

function emp(over: Partial<EmployeeDoc> = {}): EmployeeDoc {
  return normalizeEmployee({ ...blankEmployee('PW1', ''), name: 'Asha Rao', accessEmail: 'asha@pw.live', ...over });
}

function app(over: Partial<ApplicationDoc> = {}): ApplicationDoc {
  return { ...newApplicationDoc({ appId: 'APP-202611-PW1', windowId: '2026-11', employee: emp(), exercisePrice: 1, window: null, now: '2026-11-02T05:00:00.000Z' }), ...over };
}

/* ================= tax sheet ================= */

/** The legacy browser-side reader, lifted out of App.html unmodified. */
function legacyReadTaxCsv(text: string): unknown {
  const src = readFileSync(join(LEGACY, 'App.html'), 'utf8');
  const start = src.indexOf('  var TAX_COLS = [');
  const end = src.indexOf('  function taxSheetDialog()');
  const ctx = vm.createContext({});
  vm.runInContext(src.slice(start, end) + '\nglobalThis.__read = readTaxCsv;', ctx);
  return JSON.parse(JSON.stringify((ctx as { __read: (t: string) => unknown }).__read(text)));
}

const HEAD = 'S.No,EMP ID,Name,PAN,Tax Regime,Net Taxable Salary (Rounded to Next 10),Total Gross Salary,Projected Gross (CTC + Extra Payments),' +
  'Total Tax,Previous TDS,Outside Tax / Advance Tax,Tax Deducted Till Date,Remaining Months for TDS Deduction,DOB';

describe('tax sheet reading', () => {
  const samples = [
    '﻿' + HEAD + '\r\n1,PW1,"Rao, Asha",ABCDE1234F,New Regime,"12,50,000",1300000,1400000,"1,10,000",0,0,55000,5,1990-01-01\r\n' +
      '2,pw2,"Quote ""x""",X,Old,900000,0,0,90000,,,"",-1,\r\n,,,,,,,,,,,,,\r\n3,PW3,,,,,,,,,,,,\n',
    HEAD + '\n1,PW9,A,B,New,100,200,300,400,1,2,3,4,x',
    HEAD,
    'EMP ID,Tax Regime\nPW1,New\n',
    '',
  ];
  it('readTaxCsv matches the legacy browser reader', () => {
    for (const s of samples) expect(readTaxCsv(s)).toEqual(legacyReadTaxCsv(s));
  });

  it('only the ten columns survive, numbers cleaned', () => {
    const r = readTaxCsv(samples[0]);
    expect(r.missing).toEqual([]);
    expect(r.rows[0]).toEqual({
      employeeId: 'PW1', regime: 'New Regime', netTaxable: 1250000, totalGross: 1300000, projectedGross: 1400000, totalTax: 110000,
      previousTds: 0, outsideTax: 0, tdsToDate: 55000, remainingMonths: 5,
    });
    expect(JSON.stringify(r)).not.toContain('ABCDE1234F');
    expect(JSON.stringify(r)).not.toContain('Rao');
  });

  it('reads the same rows from an xlsx grid', () => {
    const grid = parseCsv(samples[0]);
    expect(taxRowsFromGrid(grid).rows).toEqual(readTaxCsv(samples[0]).rows.filter((x) => x.employeeId || x.regime || x.netTaxable));
    expect(taxRowsFromGrid([['Report'], ...grid]).rows.length).toBe(taxRowsFromGrid(grid).rows.length);
    expect(taxRowsFromGrid([['EMP ID']]).missing.length).toBe(9);
  });

  it('filters to participants with the legacy messages', () => {
    const read = readTaxCsv(samples[0]);
    expect(participantTaxRows(read, new Set(['PW2']))).toEqual({ ok: true, rows: [read.rows[1]] });
    expect(participantTaxRows(read, new Set(['ZZ']))).toEqual({ ok: false, error: 'None of the 3 people in that file are participants on the portal.' });
    expect(participantTaxRows(readTaxCsv(samples[3]), new Set())).toMatchObject({ ok: false });
    expect(participantTaxRows(readTaxCsv(''), new Set())).toEqual({ ok: false, error: 'That file has no data rows.' });
  });

  it('sanitises rows from the browser', () => {
    expect(sanitizeTaxRow({ employeeId: ' PW1 ', regime: 'New', netTaxable: '1,000', pan: 'X', evil: { a: 1 } })).toEqual({
      employeeId: 'PW1', regime: 'New', netTaxable: 1000, totalGross: 0, projectedGross: 0, totalTax: 0, previousTds: 0, outsideTax: 0, tdsToDate: 0, remainingMonths: 0,
    });
  });
});

/* ================= grids and pastes ================= */

describe('grid and paste parsing', () => {
  it('parses CSV with quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,"b,c","d""e"\r\n1,,3\n')).toEqual([['a', 'b,c', 'd"e'], ['1', '', '3']]);
    expect(parseCsv('x\n\ny')).toEqual([['x'], [''], ['y']]);
  });

  it('splits pasted rows on tabs, or commas outside quotes', () => {
    expect(parsePaste('PW1\t100\t20\n\n  PW2 , "1,00,000" , 30 \r\n')).toEqual([['PW1', '100', '20'], ['PW2', '1,00,000', '30']]);
    expect(parseIdList('pw1, PW2;pw1\nPW3  pw4')).toEqual(['PW1', 'PW2', 'PW3', 'PW4']);
  });

  it('rate rows: three columns, or ID and rate', () => {
    expect(parseRateRows('PW1\t2800000\t31.2\nPW2,20\nPW3;100;15')).toEqual([
      { employeeId: 'PW1', ctc: '2800000', taxRatePercent: '31.2' },
      { employeeId: 'PW2', ctc: '', taxRatePercent: '20' },
      { employeeId: 'PW3', ctc: '100', taxRatePercent: '15' },
    ]);
    const plan = planRates(parseRateRows('pw1\t100\t31.2\nPW2\t\t61\nPW9\t1\t2\nPW1\t\t10\nPW3\tabc\t5'), new Set(['PW1', 'PW2', 'PW3']));
    expect(plan.updates).toEqual([{ employeeId: 'PW1', taxRatePercent: 10 }]);
    expect(plan.skipped).toEqual([
      'PW2 — rate "61" is not a percentage between 0 and 60', 'PW9 — no participant record', 'PW3 — CTC "abc" is not an amount',
    ]);
  });

  it('details rows: blanks leave values, bad values warn, IDs upper-cased', () => {
    const rows = parseDetailsRows('PW1\tabcde1234f\tnsdl\tZerodha\tin300123\t12345678\tAsha Rao\t9876543210\t12 Long Street, Noida\n' +
      'PW2\tBADPAN\tXYZ\t\t\t\t\t123\t\nPW3\nPW9\tABCDE1234F');
    const byId = new Map([
      ['PW1', emp()], ['PW2', emp({ employeeId: 'PW2', pan: 'ABCDE1234F' })],
      ['PW3', emp({ employeeId: 'PW3', demat: { dpName: 'X', dpId: 'IN30', clientId: '1', accountName: '', accountType: 'NSDL' } })],
    ]);
    const plan = planDetails(rows, byId);
    expect(plan.updates).toEqual([{
      employeeId: 'PW1', patch: {
        pan: 'ABCDE1234F', mobile: '9876543210', address: '12 Long Street, Noida',
        demat: { dpName: 'Zerodha', dpId: 'IN300123', clientId: '12345678', accountName: 'Asha Rao', accountType: 'NSDL' },
      },
    }]);
    expect(plan.unchanged).toBe(2);
    expect(plan.skipped).toEqual(['PW9 - no participant record']);
    expect(plan.warnings.some((w) => w.startsWith('Row 2 (PW2):') && w.endsWith('PAN not set.'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('"XYZ" is neither NSDL nor CDSL'))).toBe(true);
    expect(plan.warnings.some((w) => w.endsWith('Mobile not set.'))).toBe(true);
    expect(plan.warnings.some((w) => w.startsWith('Row 3 (PW3):') && w.includes('Stored anyway'))).toBe(true);
  });

  it('enabled list reports codes that match nobody', () => {
    expect(planEnabledList(['pw1', 'PW1', 'XX'], new Set(['PW1']))).toEqual({ kept: ['PW1', 'XX'], unknown: ['XX'] });
  });
});

/* ================= grant sync pieces the golden test does not reach ================= */

describe('grant sync: participant master and logins', () => {
  it('normalises prefills and never touches rate, CTC, override or block', () => {
    const existing = new Map([['PW1', emp({ taxRatePercent: 30, ctc: 100, emailOverride: 'me@x.com', blocked: true, pan: '' })]]);
    const plan = planEmployeeUpserts(existing, {
      PW1: {
        employeeId: 'PW1', name: 'Asha R', designation: 'Lead', stakeholderCategory: '', accessEmail: 'asha@pw.live', secondaryEmail: '',
        employmentStatus: 'Active', separationDate: '', resignationDate: '',
        prefill: { pan: 'abcde1234f', dematAccountType: 'nsdl', dematDPId: 'in3001', mobile: '' },
      },
      PW2: {
        employeeId: 'PW2', name: 'New', designation: '', stakeholderCategory: '', accessEmail: '', secondaryEmail: '', employmentStatus: '',
        separationDate: '', resignationDate: '', prefill: { dematAccountType: 'bogus' },
      },
    }, 'now');
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].patch).toMatchObject({ name: 'Asha R', designation: 'Lead', pan: 'ABCDE1234F', demat: { accountType: 'NSDL', dpId: 'IN3001' } });
    expect(Object.keys(plan.updates[0].patch)).not.toContain('taxRatePercent');
    expect(plan.creates[0]).toMatchObject({ employeeId: 'PW2', employmentStatus: 'Active', nationality: 'Indian', remarks: 'Created by grant sync', demat: { accountType: '' } });
    expect(plan.missingEmail).toBe(1);
    expect(plan.missingRate).toBe(1);
  });

  it('keeps login addresses in line with the record', () => {
    expect(loginEmailSync({ loginEmails: ['old@pw.live'], notifyEmail: 'old@pw.live' }, { emailOverride: '', accessEmail: 'New@PW.live', secondaryEmail: 'me@gmail.com' }))
      .toEqual({ loginEmails: ['new@pw.live', 'me@gmail.com'], notifyEmail: 'New@PW.live' });
    expect(loginEmailSync({ loginEmails: ['me@gmail.com', 'new@pw.live'], notifyEmail: 'New@PW.live' }, { emailOverride: '', accessEmail: 'New@PW.live', secondaryEmail: 'me@gmail.com' })).toBeNull();
    expect(loginEmailSync({ loginEmails: ['a@b.c'] }, { emailOverride: '', accessEmail: '', secondaryEmail: '' })).toBeNull();
  });

  it('reads xlsx-style Date cells (UTC midnight) as the calendar day', () => {
    const grid = [
      ['Plan Name', 'Employee ID', 'Grant ID', 'Vested', 'Unvested', 'Multiplier', 'Grant Date', 'Vest Date'],
      ['ESOP Plan 2025', 'pw1', 'G1', 10, 0, 1, new Date(Date.UTC(2024, 2, 31)), new Date(Date.UTC(2027, 0, 1))],
    ];
    const r = rollupGrantReport(grid, { settings: DEFAULT_SETTINGS, today: '2026-11-15', syncedAt: 's' });
    expect(r.grants[0]).toMatchObject({ grantId: 'G1', employeeId: 'PW1', grantDate: '2024-03-31', lastVestDate: '2027-01-01', reportAsOn: '2026-11-15' });
  });
});

/* ================= export ================= */

describe('export rows', () => {
  it('39 columns in the legacy order, one row per line', () => {
    expect(EXPORT_COLUMNS).toHaveLength(39);
    const a = app({
      status: 'Approved', fmvDate: '2026-11-04', fmvValue: 80, taxRatePercent: 30, taxAmount: 2394, taxMode: 'Self', taxPaidAmount: 2394,
      taxPaymentCount: 2, approvedAt: '2026-11-20T06:30:00.000Z', exercisePayment: { utr: 'UTR1', date: '2026-11-05', amount: 100, bank: '', proofFileId: '' },
      notice: { signatureName: 'Asha Rao', signedAt: '2026-11-06T04:00:00.000Z', place: 'Noida', fileId: 'F1' },
      applicant: { address: '', nationality: '', mobile: '', designation: 'Lead', pan: 'ABCDE1234F' },
    });
    const pay = (seq: number, date: string, amount: number): TaxPaymentDoc => ({
      paymentId: 'T' + seq, appId: a.appId, employeeId: 'PW1', seq, paidBy: 'Self', fundPartnerName: '', utr: 'U' + seq, paymentDate: date,
      amount, bank: '', proofFileId: '', enteredBy: '', enteredAt: '', remarks: '',
    });
    const line = (grantId: string, options: number) => ({
      lineId: 'L' + grantId, appId: a.appId, grantId, planName: 'ESOP Plan 2025', multiplier: 1, optionsExercised: options, sharesAllotted: options,
      exercisePrice: 1, lineExerciseAmount: options, perquisitePerShare: 79, linePerquisite: 79 * options, updatedAt: '',
    });
    const rows = exportRowsFor({
      windowId: '2026-11', app: a, employee: emp({ designation: 'Engineer', employmentStatus: 'Active' }), lines: [line('G1', 10), line('G2', 20)],
      payments: [pay(1, '2026-11-10', 1000), pay(2, '2026-11-12', 1394)], partnerRequest: null, folderUrl: 'https://p/x',
    });
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0])).toEqual([...EXPORT_COLUMNS]);
    expect(rows[1]).toMatchObject({
      Window: '2026-11', AppID: 'APP-202611-PW1', Status: 'Approved', EmployeeID: 'PW1', Name: 'Asha Rao', Designation: 'Lead', Email: 'asha@pw.live',
      PAN: 'ABCDE1234F', GrantID: 'G2', Options: 20, Shares: 20, ExerciseAmount: 20, FMVDate: '2026-11-04', FMV: 80, Perquisite: 1580,
      TaxOnApplication: 2394, TaxUTRs: 'U1 (₹1,000 on 10 Nov 2026); U2 (₹1,394 on 12 Nov 2026)', TaxPaymentDate: '2026-11-12',
      DematSuppliedBy: 'Participant', NoticeSignedAt: '2026-11-06 09:30:00', ApprovedAt: '2026-11-20 12:00:00', FolderURL: 'https://p/x',
    });
    expect(sheetStamp('')).toBe('');
  });
});

/* ================= settings, prices, queue ================= */

describe('settings validation', () => {
  it('known keys only, with typed values', () => {
    expect(validateSetting('emails_enabled', 'TRUE')).toEqual({ ok: true, key: 'EMAILS_ENABLED', value: 'true' });
    expect(validateSetting('EMAILS_ENABLED', 'yes')).toMatchObject({ ok: false });
    expect(validateSetting('LOT_SCOPE', 'Total')).toEqual({ ok: true, key: 'LOT_SCOPE', value: 'total' });
    expect(validateSetting('LOT_SCOPE', 'grants')).toMatchObject({ ok: false });
    expect(validateSetting('FLAT_TAX_ROUNDING', 'paise')).toMatchObject({ ok: true, value: 'paise' });
    expect(validateSetting('OPTION_LOT_SIZE', '2.5')).toMatchObject({ ok: false });
    expect(validateSetting('TAX_DUE_DAY', '32')).toMatchObject({ ok: false });
    expect(validateSetting('ADMIN_NOTIFY_EMAILS', 'a@pw.live; b@pw.live')).toEqual({ ok: true, key: 'ADMIN_NOTIFY_EMAILS', value: 'a@pw.live, b@pw.live' });
    expect(validateSetting('ADMIN_NOTIFY_EMAILS', 'a@pw.live, nope')).toMatchObject({ ok: false });
    expect(validateSetting('ELIGIBLE_EMPLOYEE_IDS', 'pw1 pw2,pw1')).toMatchObject({ ok: true, value: 'PW1, PW2' });
    expect(validateSetting('WHATEVER', 'x')).toMatchObject({ ok: false });
    expect(validateSetting('COMPANY_ADDRESS', ' a\nb ')).toMatchObject({ ok: true, value: 'a\nb' });
    expect(validateSetting('EXERCISE_PRICE', '')).toEqual({ ok: true, key: 'EXERCISE_PRICE', value: '' });
  });

  it('tax rules round-trip and are checked', () => {
    const ok = parseTaxRules({ slabs: 'New, 0, 0\nNew, 400000, 5\nOld, 0, 0\n# comment', surcharge: 'New, 5000000, 10', rules: 'New, CessPercent, 4\nOld, RebateMarginalRelief, false' });
    expect(ok).toEqual({ ok: true, doc: {
      slabs: [{ regime: 'New', above: 0, rate: 0 }, { regime: 'New', above: 400000, rate: 5 }, { regime: 'Old', above: 0, rate: 0 }],
      surcharge: [{ regime: 'New', above: 5000000, rate: 10 }],
      rules: [{ regime: 'New', rule: 'CessPercent', value: 4 }, { regime: 'Old', rule: 'RebateMarginalRelief', value: 'FALSE' }],
    } });
    const bad = parseTaxRules({ slabs: 'New, 100, 5\nMid, 0, 1', surcharge: 'Old, x, 1', rules: 'New, Foo, 1' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBe(5);
  });
});

describe('share prices and holidays', () => {
  it('lists weekdays without a price that are not holidays', () => {
    // 2026-11-09 is a Monday.
    const priced = new Set(['2026-11-09', '2026-11-10']);
    expect(missingPriceDays('2026-11-14', priced, ['2026-11-11'], 6)).toEqual(['2026-11-13', '2026-11-12']);
  });
  it('reads holiday lines in any format', () => {
    expect(parseHolidays('2026-11-08 Diwali\n25/12/2026\n08 Nov 2026 - again\n# note\n')).toEqual({ ok: true, dates: ['2026-11-08', '2026-12-25'] });
    expect(parseHolidays('Diwali')).toMatchObject({ ok: false });
  });
});

describe('queue and participants', () => {
  it('sorts Submitted first, then most recent', () => {
    const rows = [
      { ...queueRow(app({ appId: 'A', status: 'Draft', updatedAt: '2026-11-10T00:00:00Z' }), emp(), undefined) },
      { ...queueRow(app({ appId: 'B', status: 'Under Review', updatedAt: '2026-11-09T00:00:00Z' }), emp(), undefined) },
      { ...queueRow(app({ appId: 'C', status: 'Submitted', updatedAt: '2026-11-01T00:00:00Z' }), emp(), undefined) },
      { ...queueRow(app({ appId: 'D', status: 'Submitted', updatedAt: '2026-11-05T00:00:00Z' }), emp({ name: 'Zed' }), undefined) },
    ] as QueueRow[];
    expect(filterQueue(rows, {}).map((r) => r.appId)).toEqual(['D', 'C', 'B', 'A']);
    expect(filterQueue(rows, { search: 'zed' }).map((r) => r.appId)).toEqual(['D']);
    expect(filterQueue(rows, { status: 'Draft' }).map((r) => r.appId)).toEqual(['A']);
  });

  it('flags the partner-paid-awaiting-participant case', () => {
    const r = queueRow(app({ status: 'Draft' }), emp(), { status: 'Payment Fed' } as never);
    expect(r.awaitingParticipant).toBe(true);
  });

  it('participant filters', () => {
    const settings = settingsFromConfig({});
    const grants = [
      { employeeId: 'PW1', planName: 'ESOP Plan 2022', multiplier: 3.6, vestedOptions: 25, unvestedOptions: 0 },
      { employeeId: 'PW2', planName: 'ESOP Plan 2025', multiplier: 1, vestedOptions: 3, unvestedOptions: 5 },
    ] as never;
    const totals = grantTotalsByEmployee(grants, settings);
    expect(totals.get('PW1')).toMatchObject({ exercisable: 20, shares: 72 });
    const rows = participantRows({
      employees: [emp(), emp({ employeeId: 'PW2', name: 'B', taxRatePercent: 10, pan: 'ABCDE1234F' }), emp({ employeeId: 'PW3', name: 'C', blocked: true })],
      totals, users: new Map([['PW2', { status: 'Active', lastLoginAt: '' }]]), sheetCovered: new Set(), enabledIds: ['PW1'],
    });
    expect(filterParticipants(rows, '', 'noTaxRate').map((r) => r.employeeId)).toEqual(['PW1']);
    expect(filterParticipants(rows, '', 'noLogin').map((r) => r.employeeId)).toEqual(['PW1']);
    expect(filterParticipants(rows, '', 'blocked').map((r) => r.employeeId)).toEqual(['PW3']);
    expect(filterParticipants(rows, '', 'prefilled').map((r) => r.employeeId)).toEqual(['PW2']);
    expect(rows.find((r) => r.employeeId === 'PW2')?.enabled).toBe(false);
  });

  it('nothing is reviewable before submission', () => {
    expect(() => assertReviewable({ appId: 'A', status: 'Draft' })).toThrow('still with the participant');
    expect(() => assertReviewable({ appId: 'A', status: 'Approved' })).toThrow('already approved');
    expect(() => assertReviewable({ appId: 'A', status: 'Under Review' })).not.toThrow();
    expect(unverifiedSections({ options: 'Verified', demat: 'Pending', exercisePayment: 'Verified', taxPayment: 'Sent Back', notice: 'Verified' })).toEqual(['demat', 'taxPayment']);
  });
});
