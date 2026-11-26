import { env } from '@/lib/env';
import { checkGmailDelegation, GMAIL_SEND_SCOPE } from '@/lib/mail/gmail';
import { isAuthorisedJobRequest, notFound } from '@/server/jobs/auth';
import { loadSettings } from '@/server/settings';

/**
 * Go-live check for email: is EMAIL_SENDER set, are emails enabled in
 * settings, and has the Workspace admin authorised the delegation? Sends
 * nothing. Not scheduled; call it by hand with `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorisedJobRequest(request)) return notFound();
  const sender = String(env().EMAIL_SENDER ?? '').trim();
  let emailsEnabled: string = 'unknown';
  try { emailsEnabled = (await loadSettings()).config.EMAILS_ENABLED ?? '(unset: true)'; } catch (e) { emailsEnabled = 'settings unreadable: ' + String(e); }
  const delegation = sender ? await checkGmailDelegation(sender) : { ok: false, clientId: '', detail: 'EMAIL_SENDER is not set' };
  return Response.json({ sender, scope: GMAIL_SEND_SCOPE, emailsEnabled, delegation }, { headers: { 'cache-control': 'no-store' } });
}
