/**
 * The ESOP Exercise Notice (Notice.gs): the approved form's headings,
 * sections A / B / C and wording, plus the grant-wise share table (switched
 * by NOTICE_SHOW_SHARES). Pure: one model feeds both the on-screen HTML and
 * the PDF, so the two can never disagree.
 *
 * Not ported: NOTICE_TEMPLATE_DOC_ID (a Google Doc as the template). The new
 * portal always renders the approved default body.
 */
import { count, inr, inr2, inWords, lotSize, num, paymentReference, prettyDate, prettyStamp, trim } from '@/domain';
import type { ApplicationDoc, ApplicationLineDoc, EmployeeDoc, GrantDoc } from '@/lib/schema';
import { effectiveRate } from './applications';
import { parseBankDetails, type Settings } from './settings';

export interface NoticeRow {
  grantId: string;
  planName: string;
  multiplier: number;
  grantDate: string;
  options: number;
  shares: number;
  amount: number;
}

export interface NoticeModel {
  companyName: string;
  formerName: string;
  companyAddress: string;
  appId: string;
  windowLabel: string;
  personal: [string, string][];
  vestedTotal: string;
  optionsToExercise: string;
  lotSize: number;
  exercisePrice: string;
  totalExerciseAmount: string;
  totalExerciseAmountWords: string;
  showShares: boolean;
  sharesToAllot: string;
  multiplierSummary: string;
  rows: NoticeRow[];
  bank: { pairs: [string, string][]; loose: string[] };
  paymentReference: string;
  /** Extra figures (FMV, perquisite, tax) for the summary under the notice; not part of the form. */
  figures: { fmv: string; fmvDate: string; perquisite: string; taxRate: string; tax: string };
  signature: null | {
    name: string; signatureName: string; signingDate: string; place: string; signedAtStamp: string; memberId: string;
  };
}

/** The calendar day (IST) of an ISO timestamp. */
export function istDateOf(iso: string): string {
  const ms = Date.parse(iso);
  if (isNaN(ms)) return '';
  return new Date(ms + 330 * 60000).toISOString().slice(0, 10);
}

export function buildNoticeModel(input: {
  app: ApplicationDoc;
  employee: EmployeeDoc;
  email: string;
  lines: readonly ApplicationLineDoc[];
  grants: readonly GrantDoc[];
  windowLabel: string;
  settings: Settings;
  today: string;
}): NoticeModel {
  const { app, employee: emp, settings } = input;
  const grantsById = new Map(input.grants.map((g) => [trim(g.grantId), g]));
  const rows: NoticeRow[] = input.lines.filter((l) => num(l.optionsExercised, 0) > 0).map((l) => {
    const g = grantsById.get(trim(l.grantId));
    return {
      grantId: trim(l.grantId),
      planName: trim(l.planName) || trim(g?.planName),
      multiplier: num(l.multiplier, num(g?.multiplier, 1)) || 1,
      grantDate: prettyDate(g?.grantDate),
      options: num(l.optionsExercised, 0),
      shares: num(l.sharesAllotted, 0),
      amount: num(l.lineExerciseAmount, 0),
    };
  });
  const totalVested = input.grants.reduce((a, g) => a + num(g.vestedOptions, 0), 0);
  const multipliers = new Map<string, number>();
  rows.forEach((r) => multipliers.set(r.planName, r.multiplier));
  const text = settings.text;
  const price = app.exercisePrice || settings.portal.exercisePrice;

  return {
    companyName: text.COMPANY_NAME,
    formerName: trim(text.COMPANY_FORMER_NAME).replace(/^\(|\)$/g, ''),
    companyAddress: trim(text.COMPANY_ADDRESS),
    appId: app.appId,
    windowLabel: input.windowLabel,
    personal: [
      ['Name of the Applicant', trim(emp.name)],
      ['Designation', app.applicant.designation || trim(emp.designation)],
      ['Employee Code', trim(emp.employeeId)],
      ['Address', app.applicant.address || trim(emp.address)],
      ['Nationality', app.applicant.nationality || trim(emp.nationality) || 'Indian'],
      ['PAN', app.applicant.pan || trim(emp.pan)],
      ['Email ID', input.email],
      ['Mobile Number', app.applicant.mobile || trim(emp.mobile)],
    ],
    vestedTotal: count(totalVested),
    optionsToExercise: count(app.totalOptions),
    lotSize: lotSize(settings.portal),
    exercisePrice: inr2(price).replace(/^₹/, ''),
    totalExerciseAmount: count(app.exerciseAmount),
    totalExerciseAmountWords: inWords(app.exerciseAmount),
    showShares: settings.noticeShowShares,
    sharesToAllot: count(app.totalShares),
    multiplierSummary: [...multipliers.entries()]
      .map(([p, m]) => p + ': 1 option = ' + m + ' share' + (m === 1 ? '' : 's')).join('; '),
    rows,
    bank: parseBankDetails(text.COMPANY_BANK_DETAILS),
    paymentReference: paymentReference(settings.portal, { employeeId: emp.employeeId, name: emp.name }),
    figures: {
      fmv: app.fmvValue ? inr2(app.fmvValue) : '—',
      fmvDate: prettyDate(app.fmvDate) || '—',
      perquisite: inr(app.perquisiteAmount),
      taxRate: effectiveRate(app) + '%',
      tax: inr(app.taxAmount),
    },
    signature: app.notice.signedAt
      ? {
        name: trim(emp.name),
        signatureName: app.notice.signatureName,
        signingDate: prettyDate(istDateOf(app.notice.signedAt)) || prettyDate(input.today),
        place: app.notice.place || '—',
        signedAtStamp: prettyStamp(app.notice.signedAt),
        memberId: trim(emp.employeeId),
      }
      : null,
  };
}

/* ---------------- the wording (shared by HTML and PDF) ---------------- */

export const NOTICE_TEXT = {
  title: 'ESOP - EXERCISE NOTICE',
  subject: 'Subject: Exercise of vested employee stock options',
  salutation: 'Dear Sir/Madam,',
  intro:
    'Having understood the terms and conditions of options granted under ‘Employees’ Stock Option Plan’ ' +
    '(“ESOP Scheme/Plan”), I hereby apply to exercise the vested options which were granted to me by the ' +
    'Company and also request the Company to allot and credit the appropriate and relevant type of shares to ' +
    'my demat account. I hereby agree to accept the shares applied for or the number of shares as may be ' +
    'allotted to me, subject to the terms and conditions of the ESOP Scheme/plan of the Company. I bind myself ' +
    'to the terms and conditions of the ESOP Scheme/Plan of the Company. I note that the Company has the ' +
    'absolute right to accept or reject this application in whole or in part without assigning any reason ' +
    'whatsoever. I hereby irrevocably authorise the Company to carry out its duties in connection with this ' +
    'application. Furnishing herein below all the required details:',
  sectionA: 'A. PERSONAL DETAILS (PLEASE PRINT IN BLOCK LETTERS):',
  sectionB: 'B. DETAILS OF OPTIONS EXERCISED',
  agreePay:
    'I hereby agree to pay the total exercise amount along with all applicable taxes, duties, and statutory ' +
    'levies within the prescribed exercise period in accordance with the ESOP Plan.',
  requestAllot:
    'I request the Company to allot and credit the corresponding equity shares and/or such adjustment to the ' +
    'fraction number of shares which may come after conversion of options to equity shares to my demat account ' +
    'upon receipt of the applicable exercise consideration and taxes.',
  sectionC: 'C. COMPANY BANK DETAILS FOR PAYMENT OF EXERCISE AMOUNT',
  bankIntro:
    'Members are required to transfer the total Exercise Amount (plus applicable taxes) to the following bank account:',
  instructionsHead: 'Important Instructions:',
  instructions: (ref: string): string[] => [
    'Payment reference must mention: “' + ref + '”',
    'Proof of payment (UTR number) must be shared with the ESOP team immediately after transfer.',
    'Shares shall be allotted only upon confirmation of receipt of funds, applicable taxes ' +
      '(e.g. perquisite income tax, etc.), and necessary information and subject to all necessary approval from ' +
      'the Board/committee and all other authorities wherever required.',
    'Incomplete or delayed payments may result in lapse of exercise request as per ESOP Plan terms.',
  ],
  attest: (m: NoticeModel): string =>
    'Signed electronically through the ' + m.companyName + ' ESOP Exercise Portal on ' +
    (m.signature?.signedAtStamp ?? '') + ' by the holder of employee code ' + (m.signature?.memberId ?? '') +
    ', authenticated by their portal password. Signature reference ' + m.appId + '.',
  unsigned: 'Not yet signed. Type your name in the portal to sign this notice.',
};

/** Section B's bullet lines as [label, bold value, trailing note]. */
export function sectionBLines(m: NoticeModel): [string, string, string][] {
  const out: [string, string, string][] = [
    ['Total Vested Options as on date: ', m.vestedTotal, ' Units'],
    ['Number of Options proposed to be Exercised: ', m.optionsToExercise,
      ' Units (Please ensure options should be in multiples of ' + m.lotSize + ' and less than the number of vested options)'],
    ['Exercise Price per Option: ', '₹ ' + m.exercisePrice, ''],
    ['Total Exercise Amount Payable: ', '₹ ' + m.totalExerciseAmount + '/-', ' (' + m.totalExerciseAmountWords + ')'],
  ];
  if (m.showShares) {
    out.push(['Equity shares to be allotted on conversion: ', m.sharesToAllot, m.multiplierSummary ? ' (' + m.multiplierSummary + ')' : '']);
  }
  return out;
}

/* ---------------- HTML ---------------- */

export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const NOTICE_CSS = `
.esop-notice{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:14px;color:#14211c;line-height:1.5}
.esop-notice h1{font-size:19px;font-weight:700;margin:0 0 16px;text-align:center;letter-spacing:.02em;text-decoration:underline;font-family:inherit}
.esop-notice h2{font-size:14px;font-weight:700;margin:22px 0 8px;font-family:inherit}
.esop-notice .sub{font-size:12px;font-weight:700;color:#4a5b53;margin:14px 0 4px;text-transform:uppercase;letter-spacing:.06em}
.esop-notice p{margin:9px 0}
.esop-notice ul{margin:8px 0;padding-left:22px}
.esop-notice ul.plain{list-style:none;padding-left:0}
.esop-notice li{margin:5px 0}
.esop-notice .tw{overflow-x:auto}
.esop-notice table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:13px}
.esop-notice th{text-align:left;font-weight:700;padding:6px 8px;border:1px solid #14211c;background:#f0f2ec}
.esop-notice td{padding:6px 8px;border:1px solid #c2cabe;vertical-align:top;overflow-wrap:anywhere}
.esop-notice tfoot td{font-weight:700;background:#f6f7f3}
.esop-notice td.pt{width:38%;color:#4a5b53}
.esop-notice td.pv{font-weight:600}
.esop-notice .n{text-align:right;white-space:nowrap}
.esop-notice .words{font-style:italic;color:#555}
.esop-notice .dim{color:#5a6b63;font-weight:400;font-size:12px}
.esop-notice .sig{margin:26px 0 0;padding:14px 16px;border:1px solid #14211c}
.esop-notice .sig.pending{border-style:dashed;border-color:#a8741a}
.esop-notice .sigrow{display:flex;gap:10px;margin:6px 0;align-items:baseline;flex-wrap:wrap}
.esop-notice .sigrow .k{min-width:88px;color:#4a5b53}
.esop-notice .sigrow .v{font-weight:600}
.esop-notice .signed{font-family:"Segoe Script","Brush Script MT","Lucida Handwriting","Apple Chancery",cursive,Georgia,serif;font-style:italic;font-weight:500;font-size:26px;line-height:1.1;color:#14342a}
.esop-notice .attest{margin:12px 0 0;font-size:11px;color:#5a6b63;line-height:1.45}
`;

function kvTable(pairs: [string, string][]): string {
  return '<div class="tw"><table><thead><tr><th>Particulars</th><th>Details</th></tr></thead><tbody>' +
    pairs.map(([k, v]) => '<tr><td class="pt">' + escapeHtml(k) + '</td><td class="pv">' +
      escapeHtml(v || '—').replace(/\n/g, '<br>') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

function grantTable(rows: NoticeRow[]): string {
  const multi = rows.some((r) => Math.abs(r.multiplier - 1) > 1e-9);
  return '<div class="tw"><table><thead><tr><th>Grant ID</th><th>Plan</th><th class="n">Options</th>' +
    (multi ? '<th class="n">Conversion</th>' : '') + '<th class="n">Equity shares</th><th class="n">Exercise amount</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + escapeHtml(r.grantId) +
      (r.grantDate ? '<br><span class="dim">granted ' + escapeHtml(r.grantDate) + '</span>' : '') + '</td>' +
      '<td>' + escapeHtml(r.planName) + '</td><td class="n">' + count(r.options) + '</td>' +
      (multi ? '<td class="n">× ' + escapeHtml(r.multiplier) + '</td>' : '') +
      '<td class="n">' + count(r.shares) + '</td><td class="n">' + inr(r.amount) + '</td></tr>').join('') +
    '</tbody><tfoot><tr><td colspan="2">Total</td><td class="n">' + count(rows.reduce((a, r) => a + r.options, 0)) + '</td>' +
    (multi ? '<td class="n"></td>' : '') +
    '<td class="n">' + count(rows.reduce((a, r) => a + r.shares, 0)) + '</td>' +
    '<td class="n">' + inr(rows.reduce((a, r) => a + r.amount, 0)) + '</td></tr></tfoot></table></div>';
}

function signatureHtml(m: NoticeModel): string {
  const s = m.signature;
  if (!s) return '<div class="sig pending"><p class="dim">' + escapeHtml(NOTICE_TEXT.unsigned) + '</p></div>';
  return '<div class="sig">' +
    '<div class="sigrow"><span class="k">Name:</span><span class="v">' + escapeHtml(s.name) + '</span></div>' +
    '<div class="sigrow"><span class="k">Signature:</span><span class="v signed">' + escapeHtml(s.signatureName) + '</span></div>' +
    '<div class="sigrow"><span class="k">Date:</span><span class="v">' + escapeHtml(s.signingDate) + '</span></div>' +
    '<div class="sigrow"><span class="k">Place:</span><span class="v">' + escapeHtml(s.place) + '</span></div>' +
    '<p class="attest">' + escapeHtml(NOTICE_TEXT.attest(m)) + '</p></div>';
}

/** The notice body, with its own scoped styles, safe to inject into a page. */
export function noticeHtml(m: NoticeModel): string {
  const T = NOTICE_TEXT;
  return '<style>' + NOTICE_CSS + '</style><div class="esop-notice">' +
    '<h1>' + escapeHtml(T.title) + '</h1>' +
    '<p>To,<br><b>' + escapeHtml(m.companyName) + '</b>' +
    (m.formerName ? '<br>(' + escapeHtml(m.formerName) + ')' : '') +
    (m.companyAddress ? '<br>Add: ' + escapeHtml(m.companyAddress).replace(/\n/g, '<br>') : '') + '</p>' +
    '<p><b>' + escapeHtml(T.subject) + '</b></p>' +
    '<p>' + escapeHtml(T.salutation) + '</p>' +
    '<p>' + escapeHtml(T.intro) + '</p>' +
    '<h2>' + escapeHtml(T.sectionA) + '</h2>' + kvTable(m.personal) +
    '<h2>' + escapeHtml(T.sectionB) + '</h2>' +
    '<ul class="plain">' + sectionBLines(m).map(([k, v, tail]) =>
      '<li>' + escapeHtml(k) + '<b>' + escapeHtml(v) + '</b><span class="dim">' + escapeHtml(tail) + '</span></li>').join('') + '</ul>' +
    (m.showShares && m.rows.length ? '<div class="sub">Grant-wise breakdown</div>' + grantTable(m.rows) : '') +
    '<p>' + escapeHtml(T.agreePay) + '</p>' +
    '<p>' + escapeHtml(T.requestAllot) + '</p>' +
    '<h2>' + escapeHtml(T.sectionC) + '</h2>' +
    '<p>' + escapeHtml(T.bankIntro) + '</p>' +
    (m.bank.pairs.length ? kvTable(m.bank.pairs) : '') +
    (m.bank.loose.length ? '<p>' + m.bank.loose.map(escapeHtml).join('<br>') + '</p>' : '') +
    '<p><b>' + escapeHtml(T.instructionsHead) + '</b></p>' +
    '<ul>' + T.instructions(m.paymentReference).map((x) => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul>' +
    signatureHtml(m) +
    '</div>';
}
