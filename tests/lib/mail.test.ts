import { describe, expect, it } from 'vitest';
import { buildMime, encodeHeader, formatAddress, parseRecipients, toBase64Url } from '@/lib/mail/mime';
import { escapeHtml, htmlToText, renderTemplate, TEMPLATE_NAMES, type MailContext } from '@/lib/mail/templates';

const ctx: MailContext = {
  companyName: 'Physicswallah Limited',
  portalUrl: 'https://esop.pw.live',
  supportEmail: 'esop@pw.live',
  companyBankDetails: 'Account Name: Physicswallah Limited\nIFSC Code: ICIC0000816',
  taxBankDetails: 'Account Name: Physicswallah Limited (tax)\nIFSC Code: ICIC0000816',
  symbol: 'PWL',
  nowMs: Date.UTC(2026, 11, 3, 4, 30),
};

/** Every template, with the data its callers send. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  account_ready: { name: 'Asha Rao', userId: 'PW123', code: '482913', minutes: 30 },
  reset_code: { name: 'Asha Rao', code: '482913' },
  password_changed: { name: 'Asha Rao' },
  window_open: { name: 'Asha Rao', windowLabel: 'December 2026', openDate: '01 Dec 2026', closeDate: '30 Dec 2026', taxDueDate: '25 Jan 2027', available: 12340, exercisePrice: 1, appId: '2026-12' },
  options_saved: { name: 'Asha Rao', appId: 'APP-202612-PW123', windowLabel: 'December 2026', totalOptions: 2370, totalShares: 8532, exerciseAmount: 2370, paymentReference: 'ESOP Exercise – PW123 – Asha Rao' },
  price_load_failed: { detail: 'No price is on record for 02 Dec 2026.', date: '2026-12-02', appId: 'APP-1' },
  demat_saved: { name: 'Asha Rao', appId: 'APP-1', dpName: 'Zerodha', dpId: 'IN300123', clientId: '12345678', pan: 'ABCDE1234F' },
  exercise_payment_received: { name: 'Asha Rao', appId: 'APP-1', totalOptions: 2370, totalShares: 8532, exerciseAmount: 2370, utr: 'UTR123456', paymentDate: '03 Dec 2026', fmvDate: '02 Dec 2026', fmv: 140.5, perquisite: 1196376, taxRate: 31.2, tax: 373269, taxDueDate: '25 Dec 2026' },
  tax_reminder: { name: 'Asha Rao', appId: 'APP-1', windowLabel: 'December 2026', taxDueDate: '25 Dec 2026', daysLeft: 2, perquisite: 1196376, tax: 373269 },
  tax_payment_received: { name: 'Asha Rao', appId: 'APP-1', amount: 373269, utr: 'UTR777777', paymentDate: '04 Dec 2026' },
  partner_assigned_employee: { name: 'Asha Rao', appId: 'APP-1', partner: 'Acme Capital', tax: 373269, taxDueDate: '25 Dec 2026' },
  partner_assigned_partner: { partner: 'Acme Capital', requestId: 'FP-abc', appId: 'APP-1', employeeName: 'Asha Rao', employeeId: 'PW123', totalOptions: 2370, totalShares: 8532, perquisite: 1196376, tax: 373269, taxDueDate: '25 Dec 2026' },
  partner_demat_set_employee: { name: 'Asha Rao', appId: 'APP-1', partner: 'Acme Capital', dpName: 'Acme Capital', dpId: 'IN300123', clientId: '12345678', accountType: 'NSDL', accountName: 'Asha Rao', totalShares: 8532 },
  partner_demat_set_admin: { partner: 'Acme Capital', appId: 'APP-1', employeeName: 'Asha Rao', employeeId: 'PW123', dpId: 'IN300123', clientId: '12345678', accountType: 'NSDL', accountName: '', totalShares: 8532 },
  partner_payment_fed_employee: { name: 'Asha Rao', appId: 'APP-1', partner: 'Acme Capital', amount: 373269, utr: 'UTR888888', paymentDate: '05 Dec 2026' },
  partner_payment_fed_admin: { partner: 'Acme Capital', appId: 'APP-1', employeeName: 'Asha Rao', employeeId: 'PW123', amount: 373269, utr: 'UTR888888', paymentDate: '05 Dec 2026' },
  partner_declined_employee: { name: 'Asha Rao', appId: 'APP-1', partner: 'Acme Capital', reason: 'Account could not be opened', taxAmount: 373269, taxDueDate: '25 Dec 2026' },
  partner_declined_admin: { partner: 'Acme Capital', appId: 'APP-1', employeeName: 'Asha Rao', employeeId: 'PW123', reason: 'Account could not be opened', taxAmount: 373269 },
  notice_signed: { name: 'Asha Rao', appId: 'APP-1', signatureName: 'Asha Rao', signedAt: '2026-12-05T09:14:00.000Z', totalOptions: 2370, totalShares: 8532, attachFileIds: ['Fabc'] },
  application_submitted_employee: { name: 'Asha Rao', appId: 'APP-1', windowLabel: 'December 2026', totalOptions: 2370, exerciseAmount: 2370, perquisite: 1196376, tax: 373269 },
  application_submitted_admin: { employeeName: 'Asha Rao', employeeId: 'PW123', appId: 'APP-1', windowLabel: 'December 2026', totalOptions: 2370, exerciseAmount: 2370, perquisite: 1196376, tax: 373269, taxMode: 'Acme Capital' },
  application_sent_back: { name: 'Asha Rao', appId: 'APP-1', sections: ['demat and PAN', 'tax payment'], remarks: 'The CML is unreadable.' },
  application_approved: { name: 'Asha Rao', appId: 'APP-1', totalOptions: 2370, exerciseAmount: 2370, perquisite: 1196376, tax: 373269, dpId: 'IN300123', clientId: '12345678' },
  application_rejected: { name: 'Asha Rao', appId: 'APP-1', remarks: 'Duplicate application.' },
  window_closing: { name: 'Asha Rao', appId: 'APP-1', windowLabel: 'December 2026', closeDate: '30 Dec 2026', daysLeft: 0, pending: 'Tax payment, Exercise notice' },
};

describe('email templates', () => {
  it('covers every legacy Mailer.gs template (25)', () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(Object.keys(SAMPLES).sort());
    expect(TEMPLATE_NAMES.length).toBe(25);
  });

  it.each(Object.keys(SAMPLES))('%s renders subject, HTML and text', (name) => {
    const m = renderTemplate(name, SAMPLES[name], ctx);
    expect(m.subject.length).toBeGreaterThan(5);
    expect(m.subject).not.toMatch(/undefined|null|NaN/);
    expect(m.html).not.toMatch(/undefined|NaN/);
    expect(m.html).toContain('Physicswallah Limited · ESOP');
    expect(m.html).toContain('Do not reply to this address.');
    expect(m.text).not.toMatch(/<[a-z]/i);
  });

  it('uses the legacy subjects', () => {
    expect(renderTemplate('tax_reminder', SAMPLES.tax_reminder, ctx).subject).toBe('Reminder: ESOP tax payment due 25 Dec 2026 — APP-1');
    expect(renderTemplate('window_open', SAMPLES.window_open, ctx).subject).toBe('ESOP exercise window open — December 2026');
    expect(renderTemplate('application_submitted_admin', SAMPLES.application_submitted_admin, ctx).subject)
      .toBe('ESOP application to verify — APP-1 (Asha Rao)');
    expect(renderTemplate('partner_declined_employee', SAMPLES.partner_declined_employee, ctx).subject)
      .toBe('Acme Capital could not take your funding request — APP-1');
    expect(renderTemplate('window_closing', SAMPLES.window_closing, ctx).subject).toBe('ESOP window closes 30 Dec 2026 — application not yet submitted');
  });

  it('shows payable amounts with Indian grouping and in words', () => {
    const m = renderTemplate('exercise_payment_received', SAMPLES.exercise_payment_received, ctx);
    expect(m.html).toContain('₹3,73,269');
    expect(m.html).toContain('Rupees Three Lakh Seventy Three Thousand Two Hundred Sixty Nine only');
    expect(m.html).toContain('₹140.50 per share');
    expect(m.html).toContain('31.2%');
    expect(m.text).toContain('Tax payable: ₹3,73,269');
    // The tax bank box.
    expect(m.html).toContain('Account Name: Physicswallah Limited (tax)');
    const o = renderTemplate('options_saved', SAMPLES.options_saved, ctx);
    expect(o.html).toContain('8,532');
    expect(o.html).toContain('Rupees Two Thousand Three Hundred Seventy only');
    expect(o.html).toContain('IFSC Code: ICIC0000816');
    expect(o.html).toContain('ESOP Exercise – PW123 – Asha Rao');
  });

  it('has the portal button, and leaves it out with no portal URL', () => {
    const m = renderTemplate('demat_saved', SAMPLES.demat_saved, ctx);
    expect(m.html).toContain('href="https://esop.pw.live"');
    expect(m.html).toContain('Open the ESOP portal');
    expect(m.text).toContain('Open the ESOP portal: https://esop.pw.live');
    expect(renderTemplate('demat_saved', SAMPLES.demat_saved, { ...ctx, portalUrl: '' }).html).not.toContain('Open the ESOP portal');
    // application_rejected and partner_declined_admin carry no button in the legacy either.
    expect(renderTemplate('application_rejected', SAMPLES.application_rejected, ctx).html).not.toContain('Open the ESOP portal');
  });

  it('days-left wording', () => {
    expect(renderTemplate('tax_reminder', { ...SAMPLES.tax_reminder, daysLeft: 0 }, ctx).html).toContain('— that is today.');
    expect(renderTemplate('tax_reminder', { ...SAMPLES.tax_reminder, daysLeft: 1 }, ctx).html).toContain('— 1 day from now.');
    expect(renderTemplate('tax_reminder', { ...SAMPLES.tax_reminder, daysLeft: 5 }, ctx).html).toContain('— 5 days from now.');
    expect(renderTemplate('window_closing', { ...SAMPLES.window_closing, daysLeft: 2 }, ctx).html).toContain(', 2 days from now.');
  });

  it('escapes data and keeps the footer and sign-off', () => {
    const m = renderTemplate('partner_declined_employee', { ...SAMPLES.partner_declined_employee, reason: '<script>x</script> & co', name: 'A <b>' }, ctx);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; co');
    expect(m.html).toContain('Hello A &lt;b&gt;,');
    expect(m.html).toContain('mailto:esop@pw.live');
    expect(escapeHtml('"\'')).toBe('&quot;&#39;');
  });

  it('formats a stored signing time, and tolerates missing optional data', () => {
    expect(renderTemplate('notice_signed', SAMPLES.notice_signed, ctx).html).toContain('05 Dec 2026 at 14:44 IST');
    expect(renderTemplate('notice_signed', { ...SAMPLES.notice_signed, attachFileIds: [] }, ctx).html).toContain('in your document folder');
    const r = renderTemplate('reset_code', SAMPLES.reset_code, ctx);
    expect(r.html).toContain('482913');
    expect(r.html).toContain('30 minutes');
    expect(renderTemplate('password_changed', SAMPLES.password_changed, ctx).html).toContain('2026-12-03 10:00:00');
    expect(renderTemplate('application_sent_back', SAMPLES.application_sent_back, ctx).text).toContain('• demat and PAN');
  });

  it('refuses an unknown template', () => {
    expect(() => renderTemplate('nope', {}, ctx)).toThrow(/Unknown email template/);
  });

  it('htmlToText keeps label: value rows', () => {
    expect(htmlToText('<table><tr><td>UTR</td><td>X1</td></tr></table><p>a &amp; b</p>')).toBe('UTR: X1\n\na & b\n');
  });
});

describe('MIME', () => {
  const msg = {
    from: { email: 'esop@pw.live', name: 'PhysicsWallah ESOP Team' },
    to: ['a@x.com'],
    replyTo: 'help@pw.live',
    subject: 'Tax payment recorded — APP-1 ₹',
    html: '<p>Hello ₹3,73,269</p>',
    text: 'Hello ₹3,73,269',
    date: new Date(Date.UTC(2026, 11, 1, 2, 30)),
  };

  it('builds a multipart/alternative message with encoded headers', () => {
    const raw = buildMime(msg, 'B1');
    expect(raw).toContain('From: "PhysicsWallah ESOP Team" <esop@pw.live>\r\n');
    expect(raw).toContain('To: a@x.com\r\n');
    expect(raw).toContain('Reply-To: help@pw.live\r\n');
    expect(raw).toContain('MIME-Version: 1.0\r\n');
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="alt_B1"');
    expect(raw).toContain('Date: Tue, 01 Dec 2026 02:30:00 +0000');
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    const parts = raw.split('--alt_B1');
    expect(parts).toHaveLength(4);
    expect(parts[1]).toContain('text/plain; charset=UTF-8');
    expect(parts[2]).toContain('text/html; charset=UTF-8');
    const htmlB64 = parts[2].split('\r\n\r\n')[1].replace(/\r\n/g, '');
    expect(Buffer.from(htmlB64, 'base64').toString('utf8')).toBe(msg.html);
    expect(raw.split('\r\n').every((l) => l.length <= 998)).toBe(true);
    expect(raw).not.toMatch(/[^\r]\n/);
  });

  it('decodes the encoded subject back to the original', () => {
    const enc = encodeHeader(msg.subject);
    const decoded = enc.split('\r\n ').map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(msg.subject);
    expect(encodeHeader('Plain ASCII')).toBe('Plain ASCII');
    expect(encodeHeader('a\r\nBcc: x@y.com')).toBe('a Bcc: x@y.com');
  });

  it('adds attachments in multipart/mixed', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const raw = buildMime({ ...msg, attachments: [{ filename: 'Exercise Notice — APP-1.pdf', contentType: 'application/pdf', data: pdf }] }, 'B2');
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="mix_B2"');
    expect(raw).toContain('Content-Type: application/pdf; name="Exercise Notice _ APP-1.pdf"');
    expect(raw).toContain("filename*=UTF-8''Exercise%20Notice%20%E2%80%94%20APP-1.pdf");
    expect(raw).toContain(Buffer.from(pdf).toString('base64'));
    expect(raw.trimEnd().endsWith('--mix_B2--')).toBe(true);
  });

  it('encodes a non-ASCII display name and base64url', () => {
    expect(formatAddress({ email: 'e@x.com', name: 'ईसॉप Team' })).toMatch(/^=\?UTF-8\?B\?.+\?= <e@x\.com>$/);
    expect(toBase64Url('??>>')).not.toMatch(/[+/=]/);
  });

  it('parses recipient lists', () => {
    expect(parseRecipients('a@x.com, b@y.com; A@x.com  bad')).toEqual({ valid: ['a@x.com', 'b@y.com'], invalid: ['bad'] });
    expect(parseRecipients('')).toEqual({ valid: [], invalid: [] });
  });
});
