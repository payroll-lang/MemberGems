/**
 * Golden tests: windows, tax due date, FMV, progress, field validation,
 * money formatting, the enabled/block list and signature matching.
 */
import { describe, expect, it } from 'vitest';
import {
  accessBar, addDays, count, num, fmvFor, inr, inr2, inWords, latestFmv, paymentReference, progress,
  settingsFromConfig, signatureNameMatches, taxDueDateFor, validateDemat, validateMobile, validatePan,
  validatePaymentDate, validateUtr, windowFor, windowState, dayOfWeek, type FmvRow, type ProgressInput
} from '@/domain';
import { j, Legacy, rng, type Row } from './legacy-harness';

const L = new Legacy(new Date(2026, 10, 20, 11, 30, 0));

function at(dateKey: string, h = 10): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, h, 0, 0);
}

function value<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

describe('windows and tax due date (golden)', () => {
  const configs: Record<string, string>[] = [
    {}, { WINDOW_OPEN_DAY: '0', WINDOW_CLOSE_DAY: '31', TAX_DUE_DAY: '31' },
    { WINDOW_OPEN_DAY: '5', WINDOW_CLOSE_DAY: '15', TAX_DUE_DAY: '10' }, { TAX_DUE_DAY: '29', WINDOW_CLOSE_DAY: '28' }
  ];
  for (const cfg of configs) {
    it('every day 2024-2028, config ' + JSON.stringify(cfg), () => {
      const s = settingsFromConfig(cfg);
      L.reset();
      L.setConfig(cfg);
      for (let d = '2024-01-01'; d <= '2028-12-31'; d = addDays(d, 1)) {
        L.setNow(at(d));
        expect(taxDueDateFor(d, s), d).toBe(value(L.run((a) => a.Util.dateKey(a.Domain.taxDueDateFor(L.date(at(d, 0)))))));
        const [, , day] = d.split('-').map(Number);
        if (day === 1 || day === 28 || day === 31 || d.endsWith('-15') || d.endsWith('-02-29')) {
          L.reset();
          L.setConfig(cfg);
          const w = value(L.run((a) => a.Domain.ensureWindow())) as Row;
          const port = windowFor(d, s);
          expect({
            WindowID: port.windowId, Label: port.label, OpenDate: port.openDate, CloseDate: port.closeDate,
            TaxDueDate: port.taxDueDate, Status: port.status
          }, d).toEqual({
            WindowID: w.WindowID, Label: w.Label, OpenDate: w.OpenDate, CloseDate: w.CloseDate,
            TaxDueDate: w.TaxDueDate, Status: w.Status
          });
        }
      }
    });
  }

  it('windowState for every day around a window, open and closed', () => {
    const w = { WindowID: '2026-11', Label: 'November 2026', OpenDate: '2026-11-03', CloseDate: '2026-11-27', Status: 'Open' };
    for (const status of ['Open', 'Closed', ' closed ']) {
      for (let d = '2026-10-25'; d <= '2026-12-05'; d = addDays(d, 1)) {
        for (const h of [0, 13, 23]) {
          L.setNow(at(d, h));
          const legacy = L.run((a) => a.Domain.windowState({ ...w, Status: status }));
          expect({ ok: true, value: windowState({ label: w.Label, openDate: w.OpenDate, closeDate: w.CloseDate, status }, d) }, d + ' ' + h)
            .toEqual(legacy);
        }
      }
    }
  });
});

describe('FMV (golden where legacy and the agreed rule coincide)', () => {
  it('previous trading day with a price → identical; otherwise PRICE_MISSING where legacy used an older row', () => {
    const r = rng(55);
    const holidays = ['2026-10-02', '2026-10-21', '2026-11-05', '2026-11-24', '2026-12-25'];
    let same = 0, missing = 0;
    for (let trial = 0; trial < 40; trial++) {
      const rows: FmvRow[] = [];
      for (let d = '2026-09-01'; d <= '2026-12-31'; d = addDays(d, 1)) {
        const dow = dayOfWeek(d);
        if (dow === 0 || dow === 6 || holidays.indexOf(d) >= 0) continue;
        if (r.next() < 0.12) continue; // a price nobody loaded
        const kind = r.int(0, 9);
        const open = r.int(9000, 16000) / 100, close = r.int(9000, 16000) / 100;
        if (kind === 0) rows.push({ date: d, openPrice: '', closePrice: '', fmv: r.int(9000, 16000) / 100, source: 'Stated' });
        else if (kind === 1) rows.push({ date: d, openPrice: String(open), closePrice: '₹ ' + close, fmv: '', source: 'Typed' });
        else if (kind === 2) rows.push({ date: d, openPrice: 0, closePrice: close, fmv: 0, source: 'Bad' });
        else rows.push({ date: d, openPrice: open, closePrice: close, fmv: Math.round((open + close) / 2 * 100) / 100, source: 'NSE' });
      }
      L.reset();
      L.setRows('FMV', rows.map((x) => ({ Date: x.date as string, OpenPrice: x.openPrice as number, ClosePrice: x.closePrice as number, FMV: x.fmv as number, Source: x.source })));
      const lat = latestFmv(rows);
      const legacyLatest = value(L.run((a) => a.Domain.latestFmv())) as Row | null;
      expect(lat ? { date: lat.date, prettyDate: lat.prettyDate, fmv: lat.fmv, open: lat.open, close: lat.close, source: lat.source } : null).toEqual(legacyLatest);
      for (let pay = '2026-09-01'; pay <= '2027-01-05'; pay = addDays(pay, 1)) {
        const port = fmvFor(pay, rows, holidays);
        const legacy = L.run((a) => a.Domain.fmvForPaymentDate(pay));
        if (port.ok) {
          same++;
          const { ok: _ok, ...rest } = port;
          void _ok;
          expect({ ok: true, value: rest }, pay).toEqual(legacy);
        } else {
          missing++;
          expect(port.reason).toBe('PRICE_MISSING');
          // Legacy fell back to an OLDER row (or refused when there was none).
          if (legacy.ok) expect((legacy.value as { date: string }).date < port.date, pay).toBe(true);
        }
      }
    }
    expect(same).toBeGreaterThan(3000);
    expect(missing).toBeGreaterThan(300);
  });
});

describe('AppStore.progress (golden)', () => {
  it('2,000 pseudo-random applications', () => {
    const r = rng(8080);
    const maybe = (v: string) => (r.next() < 0.8 ? v : r.pick(['', '  ']));
    const stages: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      L.reset();
      const app: Row = {
        AppID: 'A1', EmployeeID: 'PW100', WindowID: '2026-11',
        Status: r.pick(['Draft', 'Submitted', 'Under Review', 'Sent Back', 'Approved', 'Rejected']),
        TotalOptions: r.pick([0, 100, '', '50']),
        DematDPId: maybe('IN300123'), DematClientId: maybe('12345678'), CMLFileId: maybe('f1'), PANFileId: maybe('f2'),
        PANNumber: maybe('ABCDE1234F'), ApplicantAddress: maybe('12 Long Street, Noida'), ApplicantNationality: maybe('Indian'),
        ApplicantMobile: maybe('9876543210'), ExercisePaymentUTR: maybe('UTR123456'), ExercisePaymentDate: maybe('2026-11-05'),
        ExerciseProofFileId: maybe('f3'), FMVValue: r.pick([0, '', 120.5, 99]),
        NoticeSignedAt: r.next() < 0.5 ? new Date(2026, 10, 6, 12, 0, 0) : '',
        TaxMode: r.pick(['', 'Self', 'FundPartner', 'Other']),
        TaxAmount: r.pick([0, 0, 1000, 25000.5, '']), TaxMethod: r.pick(['', 'Sheet', 'Flat', 'None'])
      };
      const pays: Row[] = [];
      for (let k = 0; k < r.int(0, 3); k++) pays.push({ PaymentID: 'P' + k, AppID: r.next() < 0.9 ? 'A1' : 'A2', Seq: k + 1, Amount: r.pick([0, 500, 999.5, 1000, 24000, 25000]) });
      const prs: Row[] = [];
      for (let k = 0; k < r.int(0, 2); k++) prs.push({ RequestID: 'R' + k, AppID: 'A1', Status: r.pick(['Assigned', 'Payment Fed', 'Verified', 'Sent Back', 'Declined', 'Withdrawn']) });
      L.setRows('Applications', [app]);
      L.setRows('TaxPayments', pays);
      L.setRows('FundPartnerRequests', prs);
      const legacy = L.run((a) => a.AppStore.progress(a.AppStore.require('A1')));
      const paid = Math.round(pays.filter((p) => p.AppID === 'A1').reduce((s, p) => s + (p.Amount as number), 0) * 100) / 100;
      const input: ProgressInput = {
        status: String(app.Status), totalOptions: app.TotalOptions as number, dematDPId: app.DematDPId, dematClientId: app.DematClientId,
        cmlFileId: app.CMLFileId, panFileId: app.PANFileId, panNumber: app.PANNumber, applicantAddress: app.ApplicantAddress,
        applicantNationality: app.ApplicantNationality, applicantMobile: app.ApplicantMobile,
        exercisePaymentUTR: app.ExercisePaymentUTR, exercisePaymentDate: app.ExercisePaymentDate,
        exerciseProofFileId: app.ExerciseProofFileId, fmvValue: app.FMVValue as number,
        noticeSignedAt: app.NoticeSignedAt ? '2026-11-06 12:00:00' : '', taxMode: app.TaxMode,
        taxAmount: app.TaxAmount as number, taxMethod: app.TaxMethod, taxPaidTotal: paid,
        partnerRequestStatus: prs.length ? String(prs[prs.length - 1].Status) : null
      };
      const port = progress(input);
      expect({ ok: true, value: port }, JSON.stringify(input)).toEqual(legacy);
      stages[port.stage] = (stages[port.stage] || 0) + 1;
    }
    for (const s of ['options', 'demat', 'exercise', 'tax', 'notice', 'submit']) expect(stages[s], s).toBeGreaterThan(0);
  });
});

describe('field validation (golden)', () => {
  type Res = { ok: true; value: unknown } | { ok: false; error: string };
  const same = (port: Res, legacy: Res, label: string) => expect(port, label).toEqual(legacy);

  it('PAN, UTR, mobile', () => {
    const pans = ['ABCDE1234F', ' abcde1234f ', 'ABCD1234F', 'ABCDE12345', '', null, 'ABCDE1234FF', '1BCDE1234F'];
    for (const p of pans) same(validatePan(p), L.run((a) => a.Domain.validatePan(p)), 'pan ' + p);
    const utrs = ['UTR12345', 'abc12', 'ABC-12/34', 'ABC 1234', 'N123456789012', '', 'utr_123456', '      '];
    for (const u of utrs) same(validateUtr(u), L.run((a) => a.Domain.validateUtr(u)), 'utr ' + u);
    const mobiles = ['9876543210', '+91 98765 43210', '91-9876543210', '(+91) 98765-43210', '5876543210', '98765432',
      '919876543210', '+919876543210', '+1 4155552671', '', '09876543210', '9198765432101', '6000000000'];
    for (const m of mobiles) same(validateMobile(m), L.run((a) => a.Domain.validateMobile(m)), 'mobile ' + m);
  });

  it('payment date window (future / 400 days)', () => {
    for (const today of ['2026-11-20', '2027-03-01', '2028-03-01']) {
      L.setNow(at(today, 15));
      for (let k = -405; k <= 3; k++) {
        const d = addDays(today, k);
        const legacy = L.run((a) => a.Util.dateKey(a.Domain.validatePaymentDate(d, 'exercise payment')));
        same(validatePaymentDate(d, 'exercise payment', today), legacy, today + ' ' + d);
      }
      for (const d of ['05/11/2026', 'Nov 05, 2026', '05-Nov-2026', '2026-11-05 18:00:00']) {
        same(validatePaymentDate(d, 'tax payment', today), L.run((a) => a.Util.dateKey(a.Domain.validatePaymentDate(d, 'tax payment'))), d);
      }
      // LEGACY BUG: Util.startOfDay(null) is "today", so a blank or unreadable
      // date was silently accepted as today. The port refuses it.
      for (const d of ['', 'nonsense']) {
        expect(L.run((a) => a.Util.dateKey(a.Domain.validatePaymentDate(d, 'tax payment')))).toEqual({ ok: true, value: today });
        expect(validatePaymentDate(d, 'tax payment', today)).toEqual({ ok: false, error: 'Enter the date of the tax payment.' });
      }
    }
    L.setNow(new Date(2026, 10, 20, 11, 30, 0));
  });

  it('demat: NSDL / CDSL / inferred, with the repaired regexes', () => {
    const r = rng(12);
    const dpIds = ['IN300123', 'in300123', 'IN30012', 'IN3001234', 'INABC123', '12345678', '1234567', 'AB300123', '', ' IN300123 '];
    const clients = ['12345678', '1234567', '123456789', 'A2345678', '', '00000001'];
    for (let i = 0; i < 1500; i++) {
      const d = {
        dematDPName: r.pick(['NSDL DP', '', ' x ']), dematAccountName: r.pick(['Asha Rao', '', 'A']),
        dematDPId: r.pick(dpIds), dematClientId: r.pick(clients), dematAccountType: r.pick(['', 'NSDL', 'cdsl', 'CDSL', 'NSE', ' nsdl '])
      };
      same(validateDemat(d), L.run((a) => a.Domain.validateDemat(d)), JSON.stringify(d));
    }
  });
});

describe('Util.num (golden)', () => {
  it('typed money, accounting negatives, junk', () => {
    const xs = ['₹ 79.99', '1,25,000', 'Rs 500', 'Rs. 500', 'rs.500', 'INR 1,000', '(250)', '( 1,000 )', '12%', '-', '', ' ', '.', 'abc',
      '1e3', '0x10', ' 42 ', '₹', '$ 5', '£3.5', '€ 1 000', '-12.5', '+7', true, false, 0, -0.5, NaN, null, undefined, '٣'];
    for (const x of xs) {
      for (const d of [undefined, 0, 7, NaN]) {
        expect(j(num(x as string, d)), String(x)).toEqual(value(L.run((a) => a.Util.num(x, d))));
      }
    }
  });
});

describe('money formatting (golden)', () => {
  it('inWords / inr / inr2 / count on 4,000 amounts', () => {
    const r = rng(77);
    const xs: (number | string)[] = [0, 1, -1, 0.5, 0.01, 0.005, 99.99, 100, 101, 1000, 100000, 230926, 1e7, 12345678.9,
      99999999.99, 999999999, '(250)', '₹ 1,25,000.50', '', 'abc', -2.5, 19.995, 1e9];
    for (let i = 0; i < 4000; i++) {
      const k = r.int(0, 3);
      xs.push(k === 0 ? r.int(0, 999) : k === 1 ? r.int(0, 99999999) + r.int(0, 99) / 100 : k === 2 ? -r.int(0, 1e6) / 100 : r.next() * 1e9);
    }
    for (const x of xs) {
      expect(inWords(x), String(x)).toBe(value(L.run((a) => a.Util.inWords(x))));
      expect(inr(x), String(x)).toBe(value(L.run((a) => a.Util.inr(x))));
      expect(inr2(x), String(x)).toBe(value(L.run((a) => a.Util.inr2(x))));
      expect(count(x), String(x)).toBe(value(L.run((a) => a.Util.count(x))));
    }
  });
});

describe('access: block list and enabled list (golden)', () => {
  const lists = ['', 'PW1, pw2;PW3\nPW4', '  ', 'PW9'];
  for (const list of lists) {
    it('ELIGIBLE_EMPLOYEE_IDS = ' + JSON.stringify(list), () => {
      // Domain caches the enabled set for the life of the execution: fresh context per list.
      const Lx = new Legacy();
      Lx.setConfig({ ELIGIBLE_EMPLOYEE_IDS: list, PAYMENT_REFERENCE_FORMAT: 'Ref {EMPLOYEE_ID}/{NAME}/{EMPLOYEE_ID}' });
      const s = settingsFromConfig({ ELIGIBLE_EMPLOYEE_IDS: list, PAYMENT_REFERENCE_FORMAT: 'Ref {EMPLOYEE_ID}/{NAME}/{EMPLOYEE_ID}' });
      for (const id of ['PW1', 'pw2', ' PW3 ', 'PW4', 'PW5', 'PW9']) {
        for (const blocked of ['', 'TRUE', 'yes', 'Y', '1', 'no', true, false]) {
          for (const reason of ['', 'Under investigation']) {
            const e = { EmployeeID: id, Blocked: blocked, BlockedReason: reason, Name: ' Asha Rao ' };
            expect(accessBar({ employeeId: id, blocked, blockedReason: reason }, s), JSON.stringify(e))
              .toBe(value(Lx.run((a) => a.Domain.accessBar(e))));
          }
        }
        expect(paymentReference(s, { employeeId: id, name: ' Asha Rao ' }))
          .toBe(value(Lx.run((a) => a.Domain.paymentReference({ EmployeeID: id, Name: ' Asha Rao ' }))));
      }
    });
  }
});

describe('notice signature name matching (golden, fragment lifted from signNotice)', () => {
  it('hand-picked and 3,000 random signatures', () => {
    const names = ['Asha Rao', 'Asha K. Rao', 'ASHA KUMARI RAO', 'Mohammed Al-Haq', 'A Rao', 'Rao', 'Dr. Asha Rao', "O'Brien Sean", ''];
    const typed = ['Asha', 'asha rao', 'Asha Rao Kumari', 'Asha K Rao', 'asha k. rao', 'Rao', 'Asha  Rao', 'Asha Kumari', 'Mohammed AlHaq',
      'mohammed al-haq', 'A', 'a rao', 'Dr Asha', 'obrien', 'OBrien Sean', '', ' ', 'Asha Rao Rao', 'Asha Asha'];
    for (const n of names) for (const t of typed) {
      expect(signatureNameMatches(t, n), t + ' / ' + n).toBe(value(L.run((a) => a.signatureMatches(t, n))));
    }
    const r = rng(3);
    const words = ['asha', 'Rao', 'K.', 'kumari', 'Sean', 'x', 'Al-Haq'];
    for (let i = 0; i < 3000; i++) {
      const n = [...Array(r.int(1, 4))].map(() => r.pick(words)).join(' ');
      const t = [...Array(r.int(1, 4))].map(() => r.pick(words)).join(r.pick([' ', '  ']));
      expect(signatureNameMatches(t, n), t + ' / ' + n).toBe(value(L.run((a) => a.signatureMatches(t, n))));
    }
  });
});

void j;
