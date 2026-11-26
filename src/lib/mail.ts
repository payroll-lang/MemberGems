import 'server-only';
import type { DocumentReference } from 'firebase-admin/firestore';
import { loadSettings, type Settings } from '@/server/settings';
import { env } from './env';
import { bucket, db } from './firebase';
import { gmailSend } from './mail/gmail';
import { buildMime, isEmail, parseRecipients, toBase64Url, type MimeAttachment } from './mail/mime';
import { isTemplateName, renderTemplate, type MailContext, type MailData } from './mail/templates';
import { COL } from './schema';
import { nowIso } from './time';

/**
 * Email sending (Mailer.send). Mail goes out as EMAIL_SENDER (esop@pw.live)
 * through the Gmail API with domain-wide delegation — see mail/gmail.ts.
 *
 * Every call is logged to emailLog and never throws: a failed email must not
 * roll back a saved application. With a dedupeKey the log entry is created
 * first with that id (create() fails if it exists), so a re-run job, a retried
 * request or two overlapping runs can never send the same email twice.
 *
 * Nothing is sent when settings EMAILS_ENABLED is not 'true' or EMAIL_SENDER
 * is unset; the email is still rendered and logged as 'suppressed — …'.
 */
export type TemplateName =
  | 'account_ready' | 'reset_code' | 'password_changed' | 'window_open' | 'window_closing'
  | 'options_saved' | 'demat_saved' | 'exercise_payment_received' | 'tax_reminder' | 'tax_payment_received'
  | 'price_load_failed' | 'notice_signed'
  | 'partner_assigned_employee' | 'partner_assigned_partner'
  | 'partner_demat_set_employee' | 'partner_demat_set_admin'
  | 'partner_payment_fed_employee' | 'partner_payment_fed_admin'
  | 'partner_declined_employee' | 'partner_declined_admin'
  | 'application_submitted_employee' | 'application_submitted_admin'
  | 'application_sent_back' | 'application_approved' | 'application_rejected'
  | (string & {});

export interface SendOptions {
  appId?: string;
  /** Deterministic key: the email goes at most once for it (e.g. `tax_reminder:${appId}:${date}`). */
  dedupeKey?: string;
  /** Stored files (files/{fileId}) to attach, e.g. the signed notice PDF. `data.attachFileIds` is honoured too. */
  attachFileIds?: string[];
  cc?: string;
}

export type SendResult =
  | 'sent' | 'duplicate' | 'suppressed' | 'skipped' | 'failed';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Settings for mail, kept for a minute: outside a React render (route
 * handlers, the batch jobs) loadSettings is not request-cached, and a bulk
 * send must not re-read three documents per email.
 */
let settingsCache: { at: number; value: Settings } | null = null;
async function mailSettings(): Promise<Settings> {
  if (settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value;
  const value = await loadSettings();
  settingsCache = { at: Date.now(), value };
  return value;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  return s === 'true' || s === 'yes' || s === '1';
}

function cfg(settings: Settings | null, key: string): string {
  return String(settings?.config[key] ?? '').trim();
}

export function mailContext(settings: Settings | null): MailContext {
  const e = env();
  return {
    companyName: settings?.text.COMPANY_NAME || 'Physicswallah Limited',
    portalUrl: e.PORTAL_URL,
    supportEmail: settings?.text.SUPPORT_EMAIL || e.SUPPORT_EMAIL || '',
    companyBankDetails: settings?.text.COMPANY_BANK_DETAILS ?? '',
    taxBankDetails: settings?.text.TAX_BANK_DETAILS ?? '',
    symbol: cfg(settings, 'NSE_SYMBOL') || 'PWL',
    nowMs: Date.now(),
  };
}

/** Settings EMAILS_ENABLED (legacy default true). */
export function emailsEnabled(settings: Settings): boolean {
  return bool(settings.config.EMAILS_ENABLED, true);
}

/** Settings BULK_EMAILS_ENABLED (legacy default false): gates the window announcement. */
export function bulkEmailsEnabled(settings: Settings): boolean {
  return bool(settings.config.BULK_EMAILS_ENABLED, false);
}

async function attachmentsFor(ids: readonly string[]): Promise<{ files: MimeAttachment[]; missing: string[] }> {
  const files: MimeAttachment[] = [];
  const missing: string[] = [];
  let total = 0;
  for (const raw of ids) {
    const id = String(raw ?? '').trim();
    if (!id || id.includes('/')) continue;
    try {
      const snap = await db().collection(COL.files).doc(id).get();
      const f = snap.data() as { storagePath?: string; contentType?: string; originalName?: string; label?: string; status?: string } | undefined;
      if (!f?.storagePath || f.status === 'pending') { missing.push(id); continue; }
      const [buf] = await bucket().file(f.storagePath).download();
      if (total + buf.byteLength > MAX_ATTACHMENT_BYTES) { missing.push(id); continue; }
      total += buf.byteLength;
      files.push({ filename: f.originalName || f.label || id, contentType: f.contentType || 'application/octet-stream', data: new Uint8Array(buf) });
    } catch (e) {
      console.error('mail attachment ' + id + ' failed', e);
      missing.push(id);
    }
  }
  return { files, missing };
}

/**
 * Send one templated email. Returns true only when Gmail accepted it.
 * `to` may hold several addresses separated by commas.
 */
export async function sendTemplate(
  template: TemplateName,
  to: string,
  data: MailData,
  opts: SendOptions = {},
): Promise<boolean> {
  return (await sendTemplateResult(template, to, data, opts)) === 'sent';
}

/** sendTemplate, saying what happened (for the job reports). */
export async function sendTemplateResult(
  template: TemplateName,
  to: string,
  data: MailData,
  opts: SendOptions = {},
): Promise<SendResult> {
  const appId = String(opts.appId ?? data?.appId ?? '').trim();
  const recipients = parseRecipients(String(to ?? ''));
  const cc = opts.cc ? parseRecipients(opts.cc).valid : [];
  const base = {
    at: nowIso(), template: String(template), to: recipients.valid.join(', '), cc: cc.join(', '), appId,
    ...(opts.dedupeKey ? { dedupeKey: opts.dedupeKey } : {}),
  };
  const log = db().collection(COL.emailLog);
  let ref: DocumentReference | null = null;

  try {
    if (opts.dedupeKey) {
      const key = opts.dedupeKey.replace(/\//g, '_').slice(0, 1400);
      ref = log.doc(key);
      try {
        // create() fails if the key exists: whoever wrote it first is the only sender.
        await ref.create({ ...base, subject: '', result: 'pending' });
      } catch (e) {
        if ((e as { code?: unknown })?.code === 6) return 'duplicate';
        throw e;
      }
    } else {
      ref = log.doc();
    }
  } catch (e) {
    console.error('email log unavailable; ' + template + ' not sent', e);
    return 'failed';
  }

  const finish = async (result: string, extra: Record<string, unknown> = {}): Promise<void> => {
    try {
      await ref!.set({ ...base, ...extra, result }, { merge: true });
    } catch (e) {
      console.error('email log write failed for ' + template, e);
    }
  };

  let settings: Settings | null = null;
  try {
    settings = await mailSettings();
  } catch (e) {
    console.error('mail: settings unavailable', e);
  }

  let subject = '(' + template + ')';
  try {
    if (!isTemplateName(String(template))) {
      await finish('FAILED: unknown email template "' + template + '"', { subject });
      return 'failed';
    }
    const rendered = renderTemplate(String(template), data ?? {}, mailContext(settings));
    subject = rendered.subject;

    if (!recipients.valid.length) {
      await finish('skipped — no address on record' + (recipients.invalid.length ? ' (invalid: ' + recipients.invalid.join(', ') + ')' : ''), { subject });
      return 'skipped';
    }
    if (!settings || !emailsEnabled(settings)) {
      await finish(settings ? 'suppressed — EMAILS_ENABLED=false' : 'FAILED: settings could not be read', { subject });
      return settings ? 'suppressed' : 'failed';
    }
    const e = env();
    const sender = String(e.EMAIL_SENDER ?? '').trim();
    if (!sender || !isEmail(sender)) {
      await finish('suppressed — mail not configured (EMAIL_SENDER unset)', { subject });
      return 'suppressed';
    }

    const ids = [
      ...(opts.attachFileIds ?? []),
      ...(Array.isArray(data?.attachFileIds) ? (data.attachFileIds as unknown[]).map(String) : []),
    ];
    const att = ids.length ? await attachmentsFor([...new Set(ids)]) : { files: [], missing: [] };

    const replyTo = cfg(settings, 'EMAIL_REPLY_TO') || e.EMAIL_REPLY_TO || cfg(settings, 'SUPPORT_EMAIL') || e.SUPPORT_EMAIL || '';
    const fromName = cfg(settings, 'EMAIL_SENDER_NAME') || e.EMAIL_SENDER_NAME || 'PhysicsWallah ESOP Team';
    const mime = buildMime({
      from: { email: sender, name: fromName },
      to: recipients.valid,
      cc,
      replyTo: isEmail(replyTo) ? replyTo : undefined,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: att.files,
      headers: { 'X-ESOP-Template': String(template) },
      messageIdDomain: sender.split('@')[1],
    });
    const res = await gmailSend(sender, toBase64Url(mime));
    const attachInfo = ids.length ? { attachments: att.files.length, ...(att.missing.length ? { attachmentsMissing: att.missing } : {}) } : {};
    if (res.ok) {
      await finish('sent', { subject, messageId: res.messageId, ...attachInfo });
      return 'sent';
    }
    console.error('mail ' + template + ' -> ' + recipients.valid.join(',') + ': ' + res.error);
    await finish('FAILED: ' + res.error.slice(0, 1500), { subject, error: res.error.slice(0, 4000), ...attachInfo });
    return 'failed';
  } catch (err) {
    console.error('mail ' + template + ' failed', err);
    await finish('FAILED: ' + String((err as Error)?.message ?? err).slice(0, 1500), { subject });
    return 'failed';
  }
}

/** Mailer.sendToAdmins: the same template to ADMIN_NOTIFY_EMAILS. */
export async function sendToAdmins(template: TemplateName, data: MailData, opts: SendOptions = {}): Promise<boolean> {
  let list: string[] = [];
  try {
    list = (await mailSettings()).adminEmails;
  } catch (e) {
    console.error('mail: settings unavailable for admin list', e);
  }
  if (!list.length) return false;
  return sendTemplate(template, list.join(','), data, opts);
}
