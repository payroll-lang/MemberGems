import 'server-only';
import { db } from './firebase';
import { COL } from './schema';
import { nowIso } from './time';

/**
 * Email sending. Mail goes out as esop@pw.live through the Gmail API once the
 * Workspace admin approves domain-wide delegation; until then every email is
 * logged and not sent (the old portal's EMAILS_ENABLED=false behaviour).
 *
 * Templates are ported from Mailer.gs in a later step; this is the seam.
 */
export type TemplateName =
  | 'account_ready'
  | 'reset_code'
  | 'password_changed'
  | (string & {});

export async function sendTemplate(
  template: TemplateName,
  to: string,
  data: Record<string, unknown>,
  opts: { appId?: string; dedupeKey?: string } = {},
): Promise<boolean> {
  const log = db().collection(COL.emailLog);
  const entry = { at: nowIso(), template, to, appId: opts.appId ?? '', result: 'suppressed: mail not configured' };
  if (opts.dedupeKey) {
    // create() fails if the key exists, so a re-run job cannot send twice.
    try {
      await log.doc(opts.dedupeKey).create(entry);
    } catch {
      return false;
    }
  } else {
    await log.add(entry);
  }
  void data;
  return false;
}
