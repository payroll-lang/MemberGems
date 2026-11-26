/**
 * Every portal email (Mailer.gs), as pure functions: template name + data +
 * context → subject, HTML and a plain-text alternative. No I/O, no clock
 * (the context carries "now"), so each one is unit tested.
 *
 * The wording, labels and order are the legacy ones. Changes:
 *   - every value taken from `data` is HTML-escaped (legacy inserted names,
 *     DP IDs and the like raw);
 *   - price_load_failed no longer talks about an NSE fetch: prices are entered
 *     by the ESOP team, so the alert says the price is missing;
 *   - the company logo is omitted (legacy attached it inline as cid:logo).
 */
import { count, inr, inr2, inWords } from '@/domain/money';
import { istStamp, num, prettyStamp, trim, type Numeric } from '@/domain/util';

export interface MailContext {
  companyName: string;
  /** The "Open the ESOP portal" button target; blank = no button. */
  portalUrl: string;
  supportEmail: string;
  companyBankDetails: string;
  taxBankDetails: string;
  /** NSE symbol, for the price alert. */
  symbol: string;
  /** Epoch ms, for "changed on …" lines. */
  nowMs: number;
}

export interface RenderedMail {
  subject: string;
  /** The full message body, wrapped in the portal's header and footer. */
  html: string;
  text: string;
}

export type MailData = Record<string, unknown>;

type Built = { subject: string; body: string };
type Template = (d: MailData, h: Helpers) => Built;

/* ================= helpers ================= */

export function escapeHtml(v: unknown): string {
  return trim(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const e = escapeHtml;

function p(html: string): string {
  return '<p style="margin:12px 0;line-height:1.6">' + html + '</p>';
}

/** Label / value rows. Values are HTML already (escape data before passing it). */
function kv(pairs: [string, string][]): string {
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0;border-collapse:collapse;font-size:14px">' +
    pairs.map(([k, v]) =>
      '<tr>' +
      '<td style="padding:6px 18px 6px 0;color:#5a6b63;vertical-align:top;white-space:nowrap">' + e(k) + '</td>' +
      '<td style="padding:6px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">' + v + '</td>' +
      '</tr>').join('') +
    '</table>';
}

/**
 * A figure someone is being asked to pay: the amount, and the amount in
 * words underneath it. The words are what catch a misread lakh before the
 * money moves.
 */
function payable(n: unknown): string {
  return '<b>' + e(inr(n as Numeric)) + '</b>' +
    '<div style="font-family:Georgia,serif;font-style:italic;font-size:12px;color:#5a6b63;margin-top:2px">' +
    e(inWords(n as Numeric)) + '</div>';
}

function bank(title: string, details: string): string {
  if (!trim(details)) return '';
  return '<div style="margin:16px 0;padding:12px 14px;border:1px solid #c2cabe;border-left:3px solid #1b6046;background:#f6f7f3">' +
    '<div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5a6b63;margin-bottom:6px">' + e(title) + '</div>' +
    '<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:pre-line">' + e(details) + '</div>' +
    '</div>';
}

function blockquote(text: unknown): string {
  return '<div style="margin:16px 0;padding:12px 14px;border-left:3px solid #a8741a;background:#f7efdd">' +
    '<div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5a6b63;margin-bottom:6px">Remarks from the ESOP team</div>' +
    '<div style="white-space:pre-line">' + e(text) + '</div></div>';
}

/** A stored timestamp (ISO) as "08 Sep 2026 at 20:44 IST"; anything else as given. */
function when(v: unknown): string {
  const s = trim(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return prettyStamp(s) || s;
  return s;
}

function plural(n: number, word: string): string {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

interface Helpers {
  company: string;
  link: string;
  ctx: MailContext;
}

/* ================= the templates ================= */

const T: Record<string, Template> = {
  account_ready: (d, h) => ({
    subject: 'Your ' + h.company + ' ESOP portal login',
    body:
      p('Hello ' + e(d.name) + ',') +
      p('A login has been created for you on the ' + e(h.company) + ' ESOP Exercise Portal.') +
      kv([
        ['User ID', e(d.userId)],
        ['One-time code', '<b style="font-size:20px;letter-spacing:.12em">' + e(d.code) + '</b>'],
        ['Valid for', e(d.minutes ?? 30) + ' minutes'],
      ]) +
      p('Sign in with your user ID, choose <i>Set or reset password</i>, enter the code above and pick a password of your own. The code works once.') +
      h.link +
      p('If the code has expired by the time you get to it, use <i>Forgot password</i> on the sign-in screen to have a new one sent.'),
  }),

  reset_code: (d) => ({
    subject: 'Your ESOP portal one-time code',
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Here is the one-time code to set a new password on your ESOP portal account.') +
      kv([
        ...(trim(d.userId) ? [['User ID', e(d.userId)] as [string, string]] : []),
        ['One-time code', '<b style="font-size:20px;letter-spacing:.12em">' + e(d.code) + '</b>'],
        ['Valid for', e(d.minutes ?? 30) + ' minutes'],
      ]) +
      p('If you did not ask for this, you can ignore this email — your current password still works.'),
  }),

  password_changed: (d, h) => ({
    subject: 'Your ESOP portal password was changed',
    body:
      p('Hello ' + e(d.name) + ',') +
      p('The password on ' + (trim(d.userId) ? 'ESOP portal account <b>' + e(d.userId) + '</b>' : 'your ESOP portal account') +
        ' was changed on ' + e(istStamp(h.ctx.nowMs)) + '. Every other signed-in session has been ended.') +
      p('If this was not you, contact the ESOP team immediately.'),
  }),

  window_open: (d, h) => ({
    subject: 'ESOP exercise window open — ' + trim(d.windowLabel),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('The <b>' + e(d.windowLabel) + '</b> exercise window is open from ' + e(d.openDate) + ' to ' + e(d.closeDate) + '.') +
      kv([
        ['Options available to exercise', e(count(d.available as Numeric))],
        ['Exercise price', e(inr2(d.exercisePrice as Numeric)) + ' per option'],
        ['Tax payment due by', e(d.taxDueDate)],
      ]) +
      p('You can start an application, save it part-finished and come back to it any time before the window closes.') +
      h.link,
  }),

  options_saved: (d, h) => ({
    subject: 'Options recorded — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('We have recorded the options you wish to exercise in the ' + e(d.windowLabel) + ' window.') +
      kv([
        ['Application', e(d.appId)],
        ['Total options', e(count(d.totalOptions as Numeric))],
        ['Equity shares on conversion', e(count(d.totalShares as Numeric))],
        ['Exercise amount payable', payable(d.exerciseAmount)],
      ]) +
      p('Next: complete your applicant details and upload your demat client master report (CML) and PAN, then transfer the exercise amount and upload the payment proof.') +
      bank('Exercise amount — transfer to', h.ctx.companyBankDetails) +
      (trim(d.paymentReference) ? p('Quote this reference on the transfer: <b>' + e(d.paymentReference) + '</b>') : '') +
      p('Your tax will be computed on the fair market value of the trading day <i>before</i> the day you pay the exercise amount, so the transfer date matters.') +
      h.link,
  }),

  price_load_failed: (d, h) => {
    const symbol = trim(d.symbol) || h.ctx.symbol || 'PWL';
    return {
      subject: 'ESOP portal has no ' + symbol + ' share price for ' + (trim(d.prettyDate) || trim(d.date) || 'the last trading day'),
      body:
        p('The opening and closing price for <b>' + e(symbol) + '</b> that the portal needs is not on record.') +
        p('Until a price is on record, nobody who pays the exercise amount can be priced, and the portal will ' +
          'tell them so rather than compute a wrong figure.') +
        blockquote(d.detail) +
        p('Enter the two prices on the Share price screen — the exchange bhavcopy is the auditable source.') +
        h.link,
    };
  },

  demat_saved: (d, h) => ({
    subject: 'Demat and PAN details received — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Your demat account details and PAN have been received against application ' + e(d.appId) + '.') +
      kv([
        ['Depository participant', e(d.dpName)],
        ['DP ID', e(d.dpId)],
        ['Client ID', e(d.clientId)],
        ['PAN', e(d.pan)],
      ]) +
      p('These will be verified by the ESOP team against the CML you uploaded. Shares will be credited to exactly this account, so tell us straight away if anything above is wrong.') +
      h.link,
  }),

  exercise_payment_received: (d, h) => ({
    subject: 'Exercise payment recorded — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Your exercise payment details have been recorded and your perquisite has been priced.') +
      kv([
        ['Application', e(d.appId)],
        ['Options exercised', e(count(d.totalOptions as Numeric))],
        ['Equity shares on conversion', e(count(d.totalShares as Numeric))],
        ['Exercise amount paid', e(inr(d.exerciseAmount as Numeric))],
        ['UTR', e(d.utr)],
        ['Payment date', e(d.paymentDate)],
        ['FMV applied (' + trim(d.fmvDate) + ')', e(inr2(d.fmv as Numeric)) + ' per share'],
        ['Perquisite value', e(inr(d.perquisite as Numeric))],
        ['Tax rate applied', e(d.taxRate) + '%'],
        ['Tax payable', payable(d.tax)],
        ['Tax due by', '<b>' + e(d.taxDueDate) + '</b>'],
      ]) +
      p('The FMV above is the average of the opening and closing price on ' + e(d.fmvDate) +
        ', the trading day before your payment date. The perquisite is that FMV applied to the ' +
        e(count(d.totalShares as Numeric)) + ' shares you receive, less the exercise amount you paid.') +
      p('Next: pay the tax amount and upload the proof, or choose to route it through one of our fund partners.') +
      bank('Tax amount — transfer to', h.ctx.taxBankDetails) +
      h.link,
  }),

  tax_reminder: (d, h) => {
    const left = num(d.daysLeft as Numeric, 0);
    return {
      subject: 'Reminder: ESOP tax payment due ' + trim(d.taxDueDate) + ' — ' + trim(d.appId),
      body:
        p('Hello ' + e(d.name) + ',') +
        p('The tax on your ' + e(d.windowLabel) + ' exercise is due by <b>' + e(d.taxDueDate) + '</b>' +
          (left === 0 ? ' — that is today.' : ' — ' + plural(left, 'day') + ' from now.')) +
        kv([
          ['Application', e(d.appId)],
          ['Perquisite value', e(inr(d.perquisite as Numeric))],
          ['Tax payable', payable(d.tax)],
        ]) +
        p('Pay the amount and upload the UTR and payment date in the portal, or select a fund partner to pay it on your behalf.') +
        h.link,
    };
  },

  tax_payment_received: (d, h) => ({
    subject: 'Tax payment recorded — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Your tax payment details have been recorded against application ' + e(d.appId) + '.') +
      kv([
        ['Tax amount', e(inr(d.amount as Numeric))],
        ['UTR', e(d.utr)],
        ['Payment date', e(d.paymentDate)],
      ]) +
      p('Next: read and sign the exercise notice, then submit the application for verification.') +
      h.link,
  }),

  partner_assigned_employee: (d, h) => ({
    subject: 'Fund partner selected — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('You have chosen <b>' + e(d.partner) + '</b> to pay the tax on application ' + e(d.appId) + ' on your behalf. They have been notified.') +
      kv([
        ['Tax amount', e(inr(d.tax as Numeric))],
        ['Tax due by', e(d.taxDueDate)],
      ]) +
      p('The partner will enter their payment details in the portal. You will be emailed when they do, and the ESOP team will then verify it. You remain responsible for the tax reaching us by the due date.') +
      h.link,
  }),

  partner_assigned_partner: (d, h) => ({
    subject: 'New ESOP tax payment request — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.partner) + ' team,') +
      p('An employee has asked you to pay the tax on their ESOP exercise.') +
      kv([
        ['Request', e(d.requestId)],
        ['Application', e(d.appId)],
        ['Employee', e(d.employeeName) + ' (' + e(d.employeeId) + ')'],
        ['Options exercised', e(count(d.totalOptions as Numeric))],
        ['Perquisite value', e(inr(d.perquisite as Numeric))],
        ['Tax amount to be paid', payable(d.tax)],
        ['Due by', '<b>' + e(d.taxDueDate) + '</b>'],
      ]) +
      bank('Transfer to', h.ctx.taxBankDetails) +
      p('Sign in to the portal with your fund partner login to record <b>the demat account</b> ' +
        'the shares are to be allotted into, then the UTR, payment date and payment proof. ' +
        'The demat account is needed first — the shares cannot be allotted without it.') +
      h.link,
  }),

  partner_demat_set_employee: (d, h) => ({
    subject: 'Where your shares will be credited — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('<b>' + e(d.partner) + '</b> has confirmed the demat account for your ESOP exercise ' +
        e(d.appId) + '. Your ' + e(count(d.totalShares as Numeric)) + ' equity shares will be credited here:') +
      kv([
        ['Depository participant', e(d.dpName)],
        ['Account type', e(d.accountType)],
        ['DP ID', '<b>' + e(d.dpId) + '</b>'],
        ['Client ID', '<b>' + e(d.clientId) + '</b>'],
        ['Account holder', e(d.accountName) || '—'],
      ]) +
      p('<b>Please check these against your own records with ' + e(d.partner) + '.</b> Shares are ' +
        'credited to exactly this account, and a wrong identifier is difficult to unwind after ' +
        'allotment. Tell the ESOP team straight away if anything looks wrong.') +
      p('This replaces any demat account you entered yourself earlier in the application, ' +
        'because you chose ' + e(d.partner) + ' to fund the tax and the shares are held in the ' +
        'account you opened with them.') +
      h.link,
  }),

  partner_declined_employee: (d, h) => ({
    subject: trim(d.partner) + ' could not take your funding request — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('<b>' + e(d.partner) + '</b> has declined to fund the tax for your ESOP exercise ' + e(d.appId) + '.') +
      kv([['Their reason', e(d.reason)]]) +
      p('<b>Nothing is lost.</b> Your options, payment and notice are as you left them. Open the ' +
        'tax step and either choose a different fund partner or pay the tax of ' + e(inr(d.taxAmount as Numeric)) +
        ' yourself. Any demat account entered on your behalf has been put back to the one you gave.') +
      p('The tax is still due by ' + e(d.taxDueDate) + ' whichever route you take.') +
      h.link,
  }),

  partner_declined_admin: (d) => ({
    subject: trim(d.partner) + ' declined a funding request — ' + trim(d.appId),
    body:
      p('<b>' + e(d.partner) + '</b> has declined a fund-partner request. The participant has been told ' +
        'and can choose another route.') +
      kv([
        ['Application', e(d.appId)],
        ['Employee', e(d.employeeName) + ' (' + e(d.employeeId) + ')'],
        ['Tax to fund', e(inr(d.taxAmount as Numeric))],
        ['Reason given', e(d.reason)],
      ]),
  }),

  partner_demat_set_admin: (d, h) => ({
    subject: 'Allotment account set by ' + trim(d.partner) + ' — ' + trim(d.appId),
    body:
      p('<b>' + e(d.partner) + '</b> has recorded the demat account for an application they are funding.') +
      kv([
        ['Application', e(d.appId)],
        ['Employee', e(d.employeeName) + ' (' + e(d.employeeId) + ')'],
        ['Shares to allot', e(count(d.totalShares as Numeric))],
        ['Account type', e(d.accountType)],
        ['DP ID / Client ID', '<b>' + e(d.dpId) + ' / ' + e(d.clientId) + '</b>'],
        ['Account holder', e(d.accountName) || '—'],
      ]) +
      p('This is now the allotment account on the application, replacing whatever the ' +
        'participant entered themselves. The demat section has been reset to <b>pending</b> ' +
        'so it is re-checked before approval.') +
      h.link,
  }),

  partner_payment_fed_employee: (d, h) => ({
    subject: 'Your fund partner has paid the tax — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('<b>' + e(d.partner) + '</b> has recorded the tax payment on your behalf.') +
      kv([
        ['Tax amount', e(inr(d.amount as Numeric))],
        ['UTR', e(d.utr)],
        ['Payment date', e(d.paymentDate)],
      ]) +
      p('Next: read and sign the exercise notice, then submit your application for verification.') +
      h.link,
  }),

  partner_payment_fed_admin: (d, h) => ({
    subject: 'Fund partner payment to verify — ' + trim(d.appId),
    body:
      p('A fund partner has fed a tax payment for verification.') +
      kv([
        ['Partner', e(d.partner)],
        ['Application', e(d.appId)],
        ['Employee', e(d.employeeName) + ' (' + e(d.employeeId) + ')'],
        ['Amount', e(inr(d.amount as Numeric))],
        ['UTR', e(d.utr)],
        ['Payment date', e(d.paymentDate)],
      ]) +
      h.link,
  }),

  notice_signed: (d, h) => ({
    subject: 'Exercise notice signed — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Your exercise notice has been signed electronically and filed in your document folder.') +
      kv([
        ['Signed as', e(d.signatureName)],
        ['Signed at', e(when(d.signedAt))],
        ['Options exercised', e(count(d.totalOptions as Numeric))],
      ]) +
      p((Array.isArray(d.attachFileIds) && d.attachFileIds.length === 0
        ? 'A PDF copy is in your document folder on the portal.'
        : 'A PDF copy is attached for your records.') + ' Submit the application when you are ready.') +
      h.link,
  }),

  application_submitted_employee: (d, h) => ({
    subject: 'Application submitted — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Your exercise application for the ' + e(d.windowLabel) + ' window has been submitted for verification.') +
      kv([
        ['Application', e(d.appId)],
        ['Options exercised', e(count(d.totalOptions as Numeric))],
        ['Exercise amount', e(inr(d.exerciseAmount as Numeric))],
        ['Perquisite value', e(inr(d.perquisite as Numeric))],
        ['Tax', e(inr(d.tax as Numeric))],
      ]) +
      p('The ESOP team will verify your demat details, PAN, payment proofs and signed notice. You will be emailed once it is approved, or if anything needs correcting.') +
      h.link,
  }),

  application_submitted_admin: (d, h) => ({
    subject: 'ESOP application to verify — ' + trim(d.appId) + ' (' + trim(d.employeeName) + ')',
    body:
      p('An exercise application has been submitted for verification.') +
      kv([
        ['Application', e(d.appId)],
        ['Employee', e(d.employeeName) + ' (' + e(d.employeeId) + ')'],
        ['Window', e(d.windowLabel)],
        ['Options', e(count(d.totalOptions as Numeric))],
        ['Exercise amount', e(inr(d.exerciseAmount as Numeric))],
        ['Perquisite', e(inr(d.perquisite as Numeric))],
        ['Tax', e(inr(d.tax as Numeric))],
        ['Tax route', e(d.taxMode)],
      ]) +
      h.link,
  }),

  application_sent_back: (d, h) => {
    const sections = Array.isArray(d.sections) ? (d.sections as unknown[]).map(trim).filter(Boolean) : [];
    return {
      subject: 'Action needed on your ESOP application — ' + trim(d.appId),
      body:
        p('Hello ' + e(d.name) + ',') +
        p('The ESOP team has reviewed application ' + e(d.appId) + ' and needs something corrected before it can be approved.') +
        (sections.length
          ? '<p style="margin:14px 0 6px"><b>Sections to correct</b></p><ul style="margin:0 0 14px;padding-left:20px">' +
            sections.map((s) => '<li>' + e(s) + '</li>').join('') + '</ul>'
          : '') +
        (trim(d.remarks) ? blockquote(d.remarks) : '') +
        p('Open the portal, correct the section and submit again. Nothing else you have entered is lost.') +
        h.link,
    };
  },

  application_approved: (d, h) => ({
    subject: 'Exercise application approved — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Your exercise application has been verified and approved.') +
      kv([
        ['Application', e(d.appId)],
        ['Options exercised', e(count(d.totalOptions as Numeric))],
        ['Exercise amount', e(inr(d.exerciseAmount as Numeric))],
        ['Perquisite value', e(inr(d.perquisite as Numeric))],
        ['Tax accounted', e(inr(d.tax as Numeric))],
        ['Demat account', e(d.dpId) + ' / ' + e(d.clientId)],
      ]) +
      (trim(d.remarks) ? blockquote(d.remarks) : '') +
      p('The shares will be allotted and credited to the demat account above. The perquisite and the tax will be reflected in your payroll records and in Form 12BA for the year.') +
      h.link,
  }),

  application_repriced: (d, h) => ({
    subject: 'Your ESOP application has been updated — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('The ESOP team has recalculated application ' + e(d.appId) + '.' + (trim(d.reason) ? ' Reason: ' + e(d.reason) + '.' : '')) +
      kv([
        ['Options', e(count(d.totalOptions as Numeric))],
        ['Shares', e(count(d.totalShares as Numeric))],
        ['Exercise amount', e(inr(d.exerciseAmount as Numeric))],
        ['FMV', e(inr(d.fmv as Numeric)) + (trim(d.fmvDate) ? ' (' + e(d.fmvDate) + ')' : '')],
        ['Perquisite value', e(inr(d.perquisite as Numeric))],
        ['Tax on this exercise', e(inr(d.tax as Numeric)) + (trim(d.previousTax) !== '' && d.previousTax !== d.tax ? ' (was ' + e(inr(d.previousTax as Numeric)) + ')' : '')],
        ['Tax due by', e(d.taxDueDate)],
        ['Still to pay', e(inr(d.stillToPay as Numeric))],
      ]) +
      p('Open the portal to see how the figures were worked out. If more tax is now due, please pay the balance by the due date.') +
      h.link,
  }),

  application_rejected: (d) => ({
    subject: 'Exercise application closed — ' + trim(d.appId),
    body:
      p('Hello ' + e(d.name) + ',') +
      p('Application ' + e(d.appId) + ' has been closed without being processed.') +
      (trim(d.remarks) ? blockquote(d.remarks) : '') +
      p('Your options have been released back to your available balance. Contact the ESOP team if you believe this is a mistake.'),
  }),

  window_closing: (d, h) => {
    const left = num(d.daysLeft as Numeric, 0);
    return {
      subject: 'ESOP window closes ' + trim(d.closeDate) + ' — application not yet submitted',
      body:
        p('Hello ' + e(d.name) + ',') +
        p('Your ' + e(d.windowLabel) + ' exercise application is still a draft and the window closes on <b>' + e(d.closeDate) + '</b>' +
          (left === 0 ? ' — today.' : ', ' + plural(left, 'day') + ' from now.')) +
        kv([
          ['Application', e(d.appId)],
          ['Still to do', e(d.pending)],
        ]) +
        p('A draft that is not submitted before the window closes does not carry over — the options return to your available balance and you would need to start again in the next window.') +
        h.link,
    };
  },
};

export const TEMPLATE_NAMES = Object.freeze(Object.keys(T)) as readonly string[];

export function isTemplateName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(T, name);
}

/* ================= wrapper ================= */

function signoff(ctx: MailContext): string {
  const support = trim(ctx.supportEmail);
  return '<p style="margin:22px 0 0">— ESOP team, ' + e(ctx.companyName) + '</p>' +
    (support ? '<p style="margin:4px 0 0;color:#5a6b63;font-size:13px">Questions: ' +
      '<a href="mailto:' + e(support) + '">' + e(support) + '</a></p>' : '');
}

function wrap(subject: string, bodyHtml: string, ctx: MailContext): string {
  const company = e(ctx.companyName);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>' +
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#14211c;max-width:620px">' +
    '<div style="border-bottom:1px solid #c2cabe;padding-bottom:10px;margin-bottom:18px">' +
    '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7c8b83">' + company + ' · ESOP</div>' +
    '<div style="font-size:19px;margin-top:4px">' + e(subject) + '</div>' +
    '</div>' + bodyHtml + signoff(ctx) +
    '<div style="margin-top:26px;padding-top:12px;border-top:1px solid #dde2da;font-size:11.5px;color:#7c8b83;line-height:1.6">' +
    'Sent by the ' + company + ' ESOP Exercise Portal. Amounts shown are computed from the data on record at the time of sending; ' +
    'payroll figures of record prevail. Do not reply to this address.' +
    '</div></div></body></html>';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/** The plain-text alternative, derived from the HTML body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, '').trim();
      const target = href.replace(/^mailto:/i, '');
      return l === target ? l : l + ': ' + href;
    })
    .replace(/<\/td>\s*<td[^>]*>/gi, ': ')
    .replace(/<li[^>]*>/gi, '\n  • ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table|ul|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, k: string) => ENTITIES[k] ?? '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

/** Build one email. Throws only for an unknown template name. */
export function renderTemplate(name: string, data: MailData, ctx: MailContext): RenderedMail {
  const tpl = isTemplateName(name) ? T[name] : undefined;
  if (!tpl) throw new Error('Unknown email template "' + name + '"');
  const portal = trim(ctx.portalUrl);
  const link = portal
    ? '<p style="margin:18px 0"><a href="' + e(portal) + '" style="background:#1b6046;color:#fff;padding:10px 18px;border-radius:2px;text-decoration:none;font-weight:600">Open the ESOP portal</a></p>'
    : '';
  const built = tpl(data ?? {}, { company: ctx.companyName, link, ctx });
  const subject = built.subject.replace(/[\r\n]+/g, ' ').trim();
  const html = wrap(subject, built.body, ctx);
  return { subject, html, text: htmlToText(html) };
}
