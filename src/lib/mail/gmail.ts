import 'server-only';
import { JWT } from 'google-auth-library';
import { env } from '../env';

/**
 * Gmail API transport. The Firebase service account signs a JWT that
 * impersonates EMAIL_SENDER (esop@pw.live) through Workspace domain-wide
 * delegation, with the single scope gmail.send. Nothing is stored: the
 * access token lives in memory for its hour.
 *
 * Until a Workspace super admin authorises the service account's client ID
 * for that scope, the token request fails with `unauthorized_client`; that is
 * reported as 'Gmail delegation not authorised' and never thrown.
 */

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export type GmailResult = { ok: true; messageId: string } | { ok: false; error: string };

let client: { subject: string; jwt: JWT } | null = null;

interface ServiceAccount {
  client_email?: string;
  private_key?: string;
  private_key_id?: string;
  client_id?: string;
}

function serviceAccount(): ServiceAccount {
  const raw = env().FIREBASE_SERVICE_ACCOUNT.trim();
  return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as ServiceAccount;
}

/** The service account's OAuth client ID — what the Workspace admin authorises. */
export function delegationClientId(): string {
  try { return String(serviceAccount().client_id ?? ''); } catch { return ''; }
}

function jwtFor(subject: string): JWT {
  if (client && client.subject === subject) return client.jwt;
  const sa = serviceAccount();
  if (!sa.client_email || !sa.private_key) throw new Error('FIREBASE_SERVICE_ACCOUNT has no client_email / private_key');
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, keyId: sa.private_key_id, scopes: [GMAIL_SEND_SCOPE], subject });
  client = { subject, jwt };
  return jwt;
}

/** Turn whatever the auth library or the API threw into one log line. */
export function describeGmailError(e: unknown): string {
  const err = e as { message?: string; response?: { status?: number; data?: unknown }; status?: number };
  const data = err?.response?.data as { error?: unknown; error_description?: string } | undefined;
  const code = typeof data?.error === 'string' ? data.error : '';
  const text = [err?.message, code, data?.error_description, typeof data?.error === 'object' ? JSON.stringify(data.error) : '']
    .filter(Boolean).join(' | ');
  if (/unauthorized_client|not authorized to retrieve access tokens|Client is unauthorized/i.test(text)) {
    return 'Gmail delegation not authorised: a Workspace super admin must allow client ID ' +
      (delegationClientId() || '(service account client_id)') + ' the scope ' + GMAIL_SEND_SCOPE +
      ' (Admin console → Security → Access and data control → API controls → Domain-wide delegation). ' + text;
  }
  if (/invalid_grant/i.test(text)) {
    return 'Gmail impersonation refused (invalid_grant): check that EMAIL_SENDER is a real, active Workspace user. ' + text;
  }
  if (/Gmail API has not been used|SERVICE_DISABLED|accessNotConfigured/i.test(text)) {
    return 'The Gmail API is not enabled on the Google Cloud project of the service account. ' + text;
  }
  const status = err?.response?.status ?? err?.status;
  return (status ? 'HTTP ' + status + ': ' : '') + (text || String(e));
}

/** Send one RFC 2822 message (already base64url encoded). Never throws. */
export async function gmailSend(sender: string, rawBase64Url: string): Promise<GmailResult> {
  try {
    const res = await jwtFor(sender).request<{ id?: string }>({
      url: SEND_URL, method: 'POST', data: { raw: rawBase64Url },
      headers: { 'content-type': 'application/json' },
      timeout: 20_000,
    });
    return { ok: true, messageId: String(res.data?.id ?? '') };
  } catch (e) {
    return { ok: false, error: describeGmailError(e) };
  }
}
