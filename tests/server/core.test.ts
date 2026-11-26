import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DEFAULT_SETTINGS, taxForExercise } from '@/domain';
import type { ApplicationDoc, EmployeeDoc, GrantDoc } from '@/lib/schema';
import {
  activeInWindow, applicationIdFor, appsThatMayHold, currentInWindow, latestPartnerRequest, newApplicationDoc,
  nextApplicationId, nextTaxSeq, normalizeApplication, progressOf, taxPaidTotal,
} from '@/server/core/applications';
import { normalizeEmployee, normalizeGrant, emailFor } from '@/server/core/employees';
import { checkUpload, contentDisposition, corsRuleFor, corsSatisfies, sniffType, storagePathFor } from '@/server/core/files';
import { buildNoticeModel, escapeHtml, istDateOf, noticeHtml } from '@/server/core/notice';
import { pdfSafe, renderNoticePdf } from '@/server/core/noticePdf';
import { buildSettings, configMapFrom, holidaysFrom, parseBankDetails } from '@/server/core/settings';
import { buildAppView } from '@/server/core/view';
import { taxExplain, taxLabel } from '@/components/calc';

const NOW = '2026-11-20T05:00:00.000Z';

function employee(over: Partial<EmployeeDoc> = {}): EmployeeDoc {
  return normalizeEmployee({
    employeeId: 'pw-4471', name: 'Ganesh Jadhav', designation: 'Engineer', accessEmail: 'g@pw.live', mobile: '9876543210',
    address: '12 Long Street, Noida 201301', nationality: 'Indian', pan: 'abcde1234f', taxRatePercent: 30,
    demat: { dpName: 'Zerodha', dpId: 'IN300123', clientId: '12345678', accountName: 'Ganesh Jadhav', accountType: 'nsdl' },
    ...over,
  });
}

function app(over: Partial<ApplicationDoc> = {}): ApplicationDoc {
  return { ...newApplicationDoc({ appId: 'APP-202611-PW4471', windowId: '2026-11', employee: employee(), exercisePrice: 1, window: { taxDueDate: '2026-11-25' }, now: NOW }), ...over };
}

describe('settings', () => {
  it('reads the Config map flat or under values, with defaults', () => {
    expect(configMapFrom({ values: { LOT_SCOPE: 'total', X: 3 } })).toEqual({ LOT_SCOPE: 'total', X: '3' });
    expect(configMapFrom({ LOT_SCOPE: 'grant', nested: { a: 1 }, updatedAt: 'x' })).toEqual({ LOT_SCOPE: 'grant' });
    const s = buildSettings({ LOT_SCOPE: 'total', ADMIN_NOTIFY_EMAILS: 'a@x.in; b@x.in', NOTICE_SHOW_SHARES: 'FALSE' }, undefined, { dates: ['2026-10-02', 'bad', '2026-10-02', '2026-08-15'] });
    expect(s.portal.lotScope).toBe('total');
    expect(s.text.COMPANY_NAME).toBe('Physicswallah Limited');
    expect(s.adminEmails).toEqual(['a@x.in', 'b@x.in']);
    expect(s.noticeShowShares).toBe(false);
    expect(s.holidays).toEqual(['2026-08-15', '2026-10-02']);
    expect(s.tax.New.slabs.length).toBeGreaterThan(3);
  });
  it('builds tax tables from stored rows', () => {
    const s = buildSettings({}, { slabs: [{ regime: 'New', above: 0, rate: 0 }, { regime: 'New', above: 100, rate: 50 }], surcharge: [], rules: [] }, {});
    expect(s.tax.New.slabs).toEqual([{ above: 0, rate: 0 }, { above: 100, rate: 50 }]);
    expect(s.tax.Old.slabs.length).toBe(4);
  });
  it('splits bank details', () => {
    expect(parseBankDetails('Bank: ICICI\nIFSC Code: ICIC0000816\nNEFT only')).toEqual({ pairs: [['Bank', 'ICICI'], ['IFSC Code', 'ICIC0000816']], loose: ['NEFT only'] });
    expect(holidaysFrom(null)).toEqual([]);
  });
});

describe('applications', () => {
  it('references follow the legacy pattern', () => {
    expect(applicationIdFor('2026-11', 'pw-4471', 1)).toBe('APP-202611-PW4471');
    expect(applicationIdFor('2026-11', 'PW-4471', 2)).toBe('APP-202611-PW4471-2');
  });
  it('the next reference counts the window and never reuses one', () => {
    const a1 = app({ status: 'Approved', createdAt: '2026-11-02T00:00:00Z' });
    expect(nextApplicationId([a1], 'PW-4471', '2026-11')).toBe('APP-202611-PW4471-2');
    const odd = app({ appId: 'APP-202611-PW4471-2', status: 'Rejected', windowId: '2026-10' });
    expect(nextApplicationId([a1, odd], 'PW-4471', '2026-11')).toBe('APP-202611-PW4471-3');
    expect(nextApplicationId([], 'PW-4471', '2026-11')).toBe('APP-202611-PW4471');
  });
  it('live and current application in a window', () => {
    const approved = app({ status: 'Approved', createdAt: '2026-11-02T00:00:00Z' });
    const draft = app({ appId: 'APP-202611-PW4471-2', status: 'Draft', createdAt: '2026-11-05T00:00:00Z' });
    expect(activeInWindow([approved], 'PW-4471', '2026-11')).toBeNull();
    expect(currentInWindow([approved], 'PW-4471', '2026-11')?.appId).toBe(approved.appId);
    expect(activeInWindow([draft, approved], 'pw-4471', '2026-11')?.appId).toBe(draft.appId);
  });
  it('a new draft is pre-filled from the master', () => {
    const a = app();
    expect(a.applicant.pan).toBe('ABCDE1234F');
    expect(a.demat).toEqual({ dpName: 'Zerodha', dpId: 'IN300123', clientId: '12345678', accountName: 'Ganesh Jadhav', accountType: 'NSDL' });
    expect(a.taxRatePercent).toBe(30);
    expect(a.taxDueDate).toBe('2026-11-25');
    expect(a.review.options).toBe('Pending');
    expect(a.rev).toBe(0);
  });
  it('normalises a sparse or legacy-shaped document', () => {
    const a = normalizeApplication({ status: 'Sent Back', taxBreakdown: '{"method":"Flat"}', review: { demat: 'Sent Back' } }, 'APP-1');
    expect(a.appId).toBe('APP-1');
    expect(a.taxBreakdown).toEqual({ method: 'Flat' });
    expect(a.review).toEqual({ options: 'Pending', demat: 'Sent Back', exercisePayment: 'Pending', taxPayment: 'Pending', notice: 'Pending' });
    expect(a.exercisePayment.utr).toBe('');
  });
  it('progress and tax totals', () => {
    const a = app({ totalOptions: 100, cmlFileId: 'F1', panFileId: 'F2', taxMode: 'Self', taxAmount: 1000, fmvValue: 50 });
    const pays = [{ amount: 600, seq: 1 }, { amount: 399.5, seq: 2 }].map((p) => ({ ...p, paymentId: 'x', appId: '', employeeId: '', paidBy: 'Self' as const, fundPartnerName: '', utr: '', paymentDate: '', bank: '', proofFileId: '', enteredBy: '', enteredAt: '', remarks: '' }));
    expect(taxPaidTotal(pays)).toBe(999.5);
    expect(nextTaxSeq(pays)).toBe(3);
    const p = progressOf(a, taxPaidTotal(pays), null);
    expect(p.done.options).toBe(true);
    expect(p.done.demat).toBe(true);
    expect(p.done.tax).toBe(true);
    expect(p.stage).toBe('exercise');
  });
  it('only applications that can hold options need their lines read', () => {
    const apps = [app({ status: 'Rejected' }), app({ appId: 'B', status: 'Draft', windowId: '2026-10' }), app({ appId: 'C', status: 'Approved', windowId: '2026-01' })];
    expect(appsThatMayHold(apps, '2026-11-20').map((a) => a.appId)).toEqual(['C']);
  });
  it('the latest partner request', () => {
    const r = (id: string, at: string) => ({ requestId: id, assignedAt: at }) as never;
    expect(latestPartnerRequest([r('A', '2026-11-02'), r('B', '2026-11-05'), r('C', '2026-11-03')])?.requestId).toBe('B');
    expect(latestPartnerRequest([])).toBeNull();
  });
});

describe('employees and grants', () => {
  it('normalises employee and grant documents', () => {
    const e = employee({ blocked: 'yes' as never });
    expect(e.employeeId).toBe('PW-4471');
    expect(e.blocked).toBe(true);
    expect(emailFor(e)).toBe('g@pw.live');
    const g = normalizeGrant({ grantId: 'G1', employeeId: 'pw-1', multiplier: '3.6', vestedOptions: '500', tranches: '[{"id":"T1","v":10}]' });
    expect(g.multiplier).toBe(3.6);
    expect(g.vestedOptions).toBe(500);
    expect(g.tranches[0]).toEqual({ id: 'T1', vd: '', avd: '', v: 10, u: 0, e: 0, p: 0 });
  });
});

describe('files', () => {
  it('checks type and size before issuing an upload URL', () => {
    expect(checkUpload({ contentType: 'image/jpg', size: 1000, name: 'a/b.jpg' })).toEqual({ ok: true, contentType: 'image/jpeg', size: 1000, name: 'a b.jpg' });
    expect(checkUpload({ contentType: 'application/zip', size: 1, name: 'x' }).ok).toBe(false);
    const big = checkUpload({ contentType: 'application/pdf', size: 9 * 1024 * 1024, name: 'x' });
    expect(big.ok ? '' : big.error).toContain('9.0 MB');
    expect(checkUpload({ contentType: 'application/pdf', size: 0, name: 'x' }).ok).toBe(false);
  });
  it('paths cannot escape their folder', () => {
    expect(storagePathFor({ employeeId: 'pw/../4471', appId: 'APP-1', purpose: 'cml', fileId: 'F../x', contentType: 'application/pdf' }))
      .toBe('employees/PW4471/APP-1/cml/Fx.pdf');
  });
  it('sniffs real file types', () => {
    expect(sniffType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffType(new Uint8Array([0x3c, 0x68]))).toBeNull();
  });
  it('content disposition is safe for any name', () => {
    expect(contentDisposition('PAN "card".pdf', true)).toBe('inline; filename="PAN _card_.pdf"; filename*=UTF-8\'\'PAN%20%22card%22.pdf');
  });
  it('CORS check is order-insensitive and idempotent', () => {
    const want = corsRuleFor(['https://esop.pw.live', 'https://esop.pw.live']);
    expect(want.origin).toEqual(['https://esop.pw.live']);
    expect(corsSatisfies([], want)).toBe(false);
    expect(corsSatisfies([{ origin: ['https://esop.pw.live'], method: ['get', 'HEAD', 'PUT'], responseHeader: ['x-goog-content-length-range', 'content-type'] }], want)).toBe(true);
    expect(corsSatisfies([{ origin: ['https://other'], method: ['PUT', 'GET', 'HEAD'], responseHeader: ['Content-Type', 'x-goog-content-length-range'] }], want)).toBe(false);
  });
});

function noticeFixture(signed: boolean) {
  const settings = buildSettings({}, {}, {});
  const grants: GrantDoc[] = [normalizeGrant({ grantId: 'G-1', employeeId: 'PW-4471', planName: 'ESOP Plan 2022', multiplier: 3.6, grantDate: '2022-05-01', vestedOptions: 500 })];
  const a = app({
    totalOptions: 100, totalShares: 360, exerciseAmount: 100, fmvValue: 812.35, fmvDate: '2026-11-18', perquisiteAmount: 292346,
    taxAmount: 87704, taxMethod: 'Flat', taxRatePercent: 30,
    exercisePayment: { utr: 'UTR123456', date: '2026-11-19', amount: 100, bank: 'HDFC', proofFileId: 'F3' },
    notice: signed ? { signatureName: 'Ganesh', signedAt: '2026-11-20T19:00:00.000Z', place: 'Noida <b>', fileId: '' } : { signatureName: '', signedAt: '', place: '', fileId: '' },
    applicant: { address: 'Flat 4, सेक्टर 62, Noida', nationality: 'Indian', mobile: '9876543210', designation: 'Engineer', pan: 'ABCDE1234F' },
  });
  const lines = [{ lineId: 'L1', appId: a.appId, grantId: 'G-1', planName: 'ESOP Plan 2022', multiplier: 3.6, optionsExercised: 100, sharesAllotted: 360, exercisePrice: 1, lineExerciseAmount: 100, perquisitePerShare: 812.07, linePerquisite: 292346, updatedAt: NOW }];
  return buildNoticeModel({ app: a, employee: employee(), email: 'g@pw.live', lines, grants, windowLabel: 'November 2026', settings, today: '2026-11-20' });
}

describe('notice', () => {
  it('builds the approved form fields', () => {
    const m = noticeFixture(true);
    expect(m.personal[0]).toEqual(['Name of the Applicant', 'Ganesh Jadhav']);
    expect(m.vestedTotal).toBe('500');
    expect(m.totalExerciseAmount).toBe('100');
    expect(m.totalExerciseAmountWords).toBe('Rupees One Hundred only');
    expect(m.multiplierSummary).toBe('ESOP Plan 2022: 1 option = 3.6 shares');
    expect(m.paymentReference).toBe('ESOP Exercise – PW-4471 – Ganesh Jadhav');
    // Signed at 19:00Z = 00:30 IST next day.
    expect(m.signature?.signingDate).toBe('21 Nov 2026');
    expect(istDateOf('2026-11-20T19:00:00.000Z')).toBe('2026-11-21');
  });
  it('escapes everything that came from a person', () => {
    const html = noticeHtml(noticeFixture(true));
    expect(html).toContain('Noida &lt;b&gt;');
    expect(html).not.toContain('Noida <b>');
    expect(html).toContain('Grant-wise breakdown');
    expect(escapeHtml('<a href="x">\'')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;');
    expect(noticeHtml(noticeFixture(false))).toContain('Not yet signed');
  });
  it('renders a PDF, replacing what the standard fonts cannot draw', async () => {
    const bytes = await renderNoticePdf(noticeFixture(true));
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getTitle()).toBe('Exercise Notice — APP-202611-PW4471');
    const font = await doc.embedFont('Helvetica');
    expect(pdfSafe('₹ 1,000 सेक्टर – “ok”', font)).toBe('Rs. 1,000 ?????? – “ok”');
  });
});

describe('views and explanations', () => {
  it('builds an application view with the indicative figure before payment', () => {
    const a = app({ totalOptions: 100, totalShares: 360, exerciseAmount: 100 });
    const lines = [{ lineId: 'L1', appId: a.appId, grantId: 'G-1', planName: 'ESOP Plan 2022', multiplier: 3.6, optionsExercised: 100, sharesAllotted: 360, exercisePrice: 1, lineExerciseAmount: 100, perquisitePerShare: 0, linePerquisite: 0, updatedAt: NOW }];
    const v = buildAppView({
      app: a, lines, payments: [], partnerRequest: null, employee: employee(), grants: [], window: { label: 'November 2026', closeDate: '2026-11-30' },
      files: new Map(), latest: { fmv: 800, date: '2026-11-19' }, taxContext: undefined, flatRounding: DEFAULT_SETTINGS.flatTaxRounding,
    });
    expect(v.indicative?.perquisiteAmount).toBe(800 * 360 - 100);
    expect(v.indicative?.taxAmount).toBe(Math.round((800 * 360 - 100) * 30 / 100));
    expect(v.progress.stage).toBe('demat');
    expect(v.editable).toBe(true);
    expect(v.applicant.email).toBe('g@pw.live');
  });
  it('explains a flat and a sheet tax', () => {
    const flat = taxExplain({ method: 'Flat', breakdown: { v: 1, method: 'Flat', reason: 'No row', ratePercent: 30, perquisite: 1000, collect: 300 }, tax: 300, perquisite: 1000, flatRate: 30 });
    expect(flat.steps?.[1]).toEqual(['Percentage used', '30%']);
    expect(flat.notes?.[0]).toContain('No row');
    expect(taxLabel({ method: 'Flat', breakdown: null, tax: 0, perquisite: 0, flatRate: 30 })).toBe('Tax at 30% (estimate)');
    const r = taxForExercise({
      perquisite: 2500000, flatRate: 30, appId: 'A', applications: [], flatRounding: 'rupee',
      position: { regime: 'New', netTaxable: 4800000, totalGross: 4000000, projectedGross: 1000000, remainingMonths: 4, asOn: '2026-10-31', tdsToDate: 0 },
    });
    const sheet = taxExplain({ method: r.method, breakdown: r.breakdown, tax: r.amount, perquisite: 2500000, flatRate: 30 });
    expect(sheet.sections?.length).toBe(4);
    expect(sheet.result).toBeTruthy();
  });
});

describe('guards', async () => {
  const { assertRev, assertEditable, STALE_MESSAGE } = await import('@/server/core/guards');
  it('the page must have been showing the current version', () => {
    const a = app({ rev: 3 });
    expect(() => assertRev(a, { appId: a.appId, rev: 3 })).not.toThrow();
    expect(() => assertRev(a, { appId: a.appId, rev: 2 })).toThrow(STALE_MESSAGE);
    expect(() => assertRev(a, { appId: '', rev: 0 })).toThrow(STALE_MESSAGE);
    expect(() => assertRev(null, { appId: a.appId, rev: 3 })).toThrow(STALE_MESSAGE);
    expect(() => assertRev(null, { appId: '', rev: 0 })).not.toThrow();
  });
  it('only Draft and Sent Back are editable', () => {
    expect(() => assertEditable(app({ status: 'Sent Back' }))).not.toThrow();
    expect(() => assertEditable(app({ status: 'Submitted' }))).toThrow('is submitted and can no longer be edited');
  });
});
