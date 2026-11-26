/**
 * RFC 2822 / MIME message building for the Gmail API (`raw`, base64url).
 * Pure: the caller supplies attachment bytes and, in tests, the boundary.
 *
 *   multipart/mixed                      (only when there are attachments)
 *     multipart/alternative
 *       text/plain; charset=UTF-8        base64
 *       text/html; charset=UTF-8         base64
 *     application/pdf; name=…            base64, Content-Disposition: attachment
 */

export interface Address {
  email: string;
  name?: string;
}

export interface MimeAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface MimeMessage {
  from: Address;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MimeAttachment[];
  /** Extra headers, e.g. X-ESOP-Template. Values must be ASCII. */
  headers?: Record<string, string>;
  date?: Date;
  messageIdDomain?: string;
}

const CRLF = '\r\n';

/** A loose but safe address check: one @, no spaces, no header-breaking characters. */
export function isEmail(v: string): boolean {
  return /^[^@\s<>()[\]\\,;:"]+@[^@\s<>()[\]\\,;:"]+\.[^@\s<>()[\]\\,;:"]+$/.test(v);
}

/** "a@x.com, b@y.com; c@z.com" → unique, valid addresses (case-insensitive de-duplication). */
export function parseRecipients(v: string | readonly string[]): { valid: string[]; invalid: string[] } {
  const raw = (Array.isArray(v) ? v.join(',') : String(v ?? '')).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  raw.forEach((a) => {
    if (!isEmail(a)) { invalid.push(a); return; }
    const k = a.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    valid.push(a);
  });
  return { valid, invalid };
}

function isAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/** RFC 2047 encoded-word(s) for a header value that is not plain ASCII. */
export function encodeHeader(value: string): string {
  const v = value.replace(/[\r\n]+/g, ' ');
  if (isAscii(v)) return v;
  // Split on characters (not bytes) so no UTF-8 sequence is cut; ~45 bytes per word keeps lines short.
  const words: string[] = [];
  let chunk = '';
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => '=?UTF-8?B?' + Buffer.from(w, 'utf8').toString('base64') + '?=').join(CRLF + ' ');
}

export function formatAddress(a: Address): string {
  const name = (a.name ?? '').replace(/[\r\n"]+/g, ' ').trim();
  if (!name) return a.email;
  return (isAscii(name) ? '"' + name.replace(/\\/g, '') + '"' : encodeHeader(name)) + ' <' + a.email + '>';
}

/** Base64 wrapped at 76 characters (RFC 2045). */
export function base64Lines(data: Uint8Array | string): string {
  const b64 = Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
  return (b64.match(/.{1,76}/g) ?? ['']).join(CRLF);
}

export function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function safeFilename(name: string): string {
  return name.replace(/[\r\n"\\/]+/g, ' ').trim() || 'attachment';
}

function dispositionParams(filename: string): string {
  const f = safeFilename(filename);
  if (isAscii(f)) return 'filename="' + f + '"';
  const ascii = f.replace(/[^\x20-\x7e]/g, '_');
  return 'filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(f);
}

function randomBoundary(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

/** The message as RFC 2822 text (CRLF line endings). */
export function buildMime(m: MimeMessage, boundarySeed: string = randomBoundary()): string {
  const alt = 'alt_' + boundarySeed;
  const mixed = 'mix_' + boundarySeed;
  const attachments = m.attachments ?? [];
  const date = m.date ?? new Date();

  const head: string[] = [
    'From: ' + formatAddress(m.from),
    'To: ' + m.to.join(', '),
    ...(m.cc?.length ? ['Cc: ' + m.cc.join(', ')] : []),
    ...(m.replyTo ? ['Reply-To: ' + m.replyTo] : []),
    'Subject: ' + encodeHeader(m.subject),
    'Date: ' + date.toUTCString().replace('GMT', '+0000'),
    ...(m.messageIdDomain ? ['Message-ID: <' + randomBoundary() + '.' + date.getTime() + '@' + m.messageIdDomain + '>'] : []),
    'MIME-Version: 1.0',
    ...Object.entries(m.headers ?? {}).filter(([k, v]) => /^[A-Za-z0-9-]+$/.test(k) && isAscii(v)).map(([k, v]) => k + ': ' + v),
  ];

  const alternative = [
    '--' + alt,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(m.text),
    '--' + alt,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(m.html),
    '--' + alt + '--',
  ].join(CRLF);

  if (!attachments.length) {
    return [...head, 'Content-Type: multipart/alternative; boundary="' + alt + '"', '', alternative, ''].join(CRLF);
  }

  const parts = attachments.map((a) => [
    '--' + mixed,
    'Content-Type: ' + a.contentType + '; name="' + safeFilename(a.filename).replace(/[^\x20-\x7e]/g, '_') + '"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; ' + dispositionParams(a.filename),
    '',
    base64Lines(a.data),
  ].join(CRLF));

  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="' + mixed + '"',
    '',
    '--' + mixed,
    'Content-Type: multipart/alternative; boundary="' + alt + '"',
    '',
    alternative,
    ...parts,
    '--' + mixed + '--',
    '',
  ].join(CRLF);
}
