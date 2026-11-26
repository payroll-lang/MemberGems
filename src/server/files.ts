import 'server-only';
import { env } from '@/lib/env';
import { bucket, db } from '@/lib/firebase';
import { COL, type FileDoc, type FilePurpose, type Role } from '@/lib/schema';
import { addMinutes, nowIso } from '@/lib/time';
import { UserError } from './core/errors';
import {
  DOWNLOAD_URL_MINUTES, FILE_LABELS, MAX_UPLOAD_BYTES, UPLOAD_URL_MINUTES, checkUpload, contentDisposition,
  corsRuleFor, corsSatisfies, extFor, sniffType, storagePathFor,
} from './core/files';
import { getDoc, uid, type Tx } from './db';

export * from './core/files';

/**
 * Private Cloud Storage. Browsers upload straight to the bucket with a V4
 * signed PUT URL (Vercel caps request bodies at 4.5 MB; uploads may be 8 MB)
 * and download through short-lived signed GET URLs issued after an
 * ownership check. Every object has a files/{fileId} record; nothing is ever
 * deleted — a replaced file is marked superseded.
 */

export function fileRef(fileId: string) {
  return db().collection(COL.files).doc(fileId);
}

export function normalizeFile(raw: unknown, id: string): FileDoc {
  const f = (raw ?? {}) as Partial<FileDoc>;
  return {
    fileId: f.fileId || id,
    purpose: (f.purpose || 'cml') as FilePurpose,
    status: f.status === 'pending' ? 'pending' : 'ready',
    originalName: String(f.originalName ?? f.label ?? ''),
    confirmedAt: String(f.confirmedAt ?? ''),
    requestId: f.requestId ? String(f.requestId) : undefined,
    ownerEmployeeId: String(f.ownerEmployeeId ?? ''),
    appId: String(f.appId ?? ''),
    label: String(f.label ?? ''),
    storagePath: String(f.storagePath ?? ''),
    contentType: String(f.contentType ?? ''),
    size: Number(f.size) || 0,
    uploadedBy: String(f.uploadedBy ?? ''),
    uploadedAt: String(f.uploadedAt ?? ''),
    supersededAt: String(f.supersededAt ?? ''),
  };
}

export async function getFile(fileId: string, tx?: Tx): Promise<FileDoc | null> {
  const id = String(fileId ?? '').trim();
  if (!id || id.includes('/')) return null;
  const snap = await getDoc(fileRef(id), tx);
  return snap.exists ? normalizeFile(snap.data(), snap.id) : null;
}

/** What a screen shows about a stored file (Files.meta). */
export interface FileMeta {
  fileId: string;
  name: string;
  label: string;
  contentType: string;
  sizeKb: number;
  uploadedAt: string;
}

export function fileMeta(f: FileDoc | null): FileMeta | null {
  if (!f || f.status !== 'ready') return null;
  return {
    fileId: f.fileId, name: f.originalName || f.label, label: f.label, contentType: f.contentType,
    sizeKb: Math.round(f.size / 1024), uploadedAt: f.uploadedAt,
  };
}

export async function fileMetas(ids: readonly string[]): Promise<Map<string, FileMeta>> {
  const unique = [...new Set(ids.map((x) => String(x ?? '').trim()).filter((x) => x && !x.includes('/')))];
  const out = new Map<string, FileMeta>();
  if (!unique.length) return out;
  const snaps = await db().getAll(...unique.map((id) => fileRef(id)));
  snaps.forEach((s) => {
    if (!s.exists) return;
    const m = fileMeta(normalizeFile(s.data(), s.id));
    if (m) out.set(s.id, m);
  });
  return out;
}

const LENGTH_RANGE = '0,' + MAX_UPLOAD_BYTES;

export interface UploadTicket {
  fileId: string;
  url: string;
  /** Headers the browser must send with the PUT, exactly as given. */
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * Step 1 of an upload: check type and size, record a pending file and
 * return a signed PUT URL. The caller has already checked that this user may
 * upload this purpose against this application.
 */
export async function createUpload(input: {
  ownerEmployeeId: string; appId: string; purpose: FilePurpose; contentType: unknown; size: unknown; name: unknown;
  uploadedBy: string; requestId?: string;
}): Promise<UploadTicket> {
  const check = checkUpload(input);
  if (!check.ok) throw new UserError(check.error);
  const fileId = uid('F');
  const path = storagePathFor({ employeeId: input.ownerEmployeeId, appId: input.appId, purpose: input.purpose, fileId, contentType: check.contentType });
  const expires = addMinutes(new Date(), UPLOAD_URL_MINUTES);
  const headers = { 'Content-Type': check.contentType, 'x-goog-content-length-range': LENGTH_RANGE };
  const [url] = await bucket().file(path).getSignedUrl({
    version: 'v4', action: 'write', expires, contentType: check.contentType,
    extensionHeaders: { 'x-goog-content-length-range': LENGTH_RANGE },
  });
  const doc: FileDoc = {
    fileId, purpose: input.purpose, status: 'pending', originalName: check.name, confirmedAt: '',
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ownerEmployeeId: input.ownerEmployeeId.toUpperCase(), appId: input.appId,
    label: FILE_LABELS[input.purpose], storagePath: path, contentType: check.contentType, size: check.size,
    uploadedBy: input.uploadedBy, uploadedAt: nowIso(), supersededAt: '',
  };
  await fileRef(fileId).create(doc);
  return { fileId, url, headers, expiresAt: nowIso(expires) };
}

/**
 * Step 2: the browser says it has uploaded. The object's real metadata is
 * checked (type, size) before the file can be attached to anything.
 */
export async function confirmUpload(fileId: string, userId: string): Promise<FileDoc> {
  const f = await getFile(fileId);
  if (!f || f.uploadedBy !== userId) throw new UserError('That upload was not found. Please choose the file again.');
  if (f.status === 'ready') return f;
  const obj = bucket().file(f.storagePath);
  const [exists] = await obj.exists();
  if (!exists) throw new UserError('The file did not arrive. Please choose it and upload it again.');
  const [meta] = await obj.getMetadata();
  const size = Number(meta.size);
  const type = String(meta.contentType ?? '');
  const check = checkUpload({ contentType: type, size, name: f.originalName });
  const [head] = await obj.download({ start: 0, end: 7 });
  const sniffed = sniffType(new Uint8Array(head));
  if (!check.ok || check.contentType !== f.contentType || sniffed !== f.contentType) {
    // Never deleted, but never usable either.
    await fileRef(fileId).update({ supersededAt: nowIso(), status: 'pending' });
    throw new UserError(check.ok ? 'That file is not the type it said it was. Upload a PDF, JPG or PNG.' : check.error);
  }
  const now = nowIso();
  await fileRef(fileId).update({ status: 'ready', size, confirmedAt: now });
  return { ...f, status: 'ready', size, confirmedAt: now };
}

/**
 * Inside a mutation: the file must be a confirmed upload of this purpose,
 * by this owner, for this application, and not already replaced.
 */
export async function requireAttachable(
  fileId: string, want: { ownerEmployeeId: string; appId: string; purposes: FilePurpose[] }, tx: Tx,
): Promise<FileDoc> {
  const f = await getFile(fileId, tx);
  const bad = !f || f.ownerEmployeeId !== want.ownerEmployeeId.toUpperCase() || f.appId !== want.appId ||
    !want.purposes.includes(f.purpose);
  if (bad) throw new UserError('That upload does not belong to this application. Please upload the file again.');
  if (f.status !== 'ready') throw new UserError('That upload has not finished. Wait for it to complete, or choose the file again.');
  if (f.supersededAt) throw new UserError('That file has been replaced. Please upload it again.');
  return f;
}

/** Mark a file replaced (never deleted). A write: call after all transaction reads. */
export function supersede(tx: Tx, fileId: string, at: string): void {
  const id = String(fileId ?? '').trim();
  if (!id || id.includes('/')) return;
  tx.set(fileRef(id), { supersededAt: at }, { merge: true });
}

/** Store a file the server made itself (the signed notice PDF). */
export async function saveGeneratedFile(input: {
  ownerEmployeeId: string; appId: string; purpose: FilePurpose; bytes: Uint8Array; contentType: string;
  name: string; uploadedBy: string;
}): Promise<FileDoc> {
  const fileId = uid('F');
  const path = storagePathFor({ employeeId: input.ownerEmployeeId, appId: input.appId, purpose: input.purpose, fileId, contentType: input.contentType });
  await bucket().file(path).save(Buffer.from(input.bytes), {
    contentType: input.contentType, resumable: false, metadata: { cacheControl: 'private, no-store' },
  });
  const now = nowIso();
  const doc: FileDoc = {
    fileId, purpose: input.purpose, status: 'ready', originalName: input.name, confirmedAt: now,
    ownerEmployeeId: input.ownerEmployeeId.toUpperCase(), appId: input.appId, label: FILE_LABELS[input.purpose],
    storagePath: path, contentType: input.contentType, size: input.bytes.byteLength,
    uploadedBy: input.uploadedBy, uploadedAt: now, supersededAt: '',
  };
  await fileRef(fileId).create(doc);
  return doc;
}

/** A short-lived signed GET URL. The caller has checked the reader may see it. */
export async function downloadUrl(f: FileDoc, inline: boolean): Promise<string> {
  const name = f.originalName && /\.[a-z0-9]{2,4}$/i.test(f.originalName)
    ? f.originalName
    : (f.label || 'document') + ' — ' + f.appId + '.' + extFor(f.contentType);
  const [url] = await bucket().file(f.storagePath).getSignedUrl({
    version: 'v4', action: 'read', expires: addMinutes(new Date(), DOWNLOAD_URL_MINUTES),
    responseDisposition: contentDisposition(name, inline), responseType: f.contentType,
  });
  return url;
}

/** Who may read a file. Partners never see a participant's own documents. */
export function mayRead(user: { userId: string; role: Role; fundPartnerId?: string }, f: FileDoc, partnerOfRequest?: string): boolean {
  if (user.role === 'Admin') return true;
  if (user.role === 'Employee') return f.ownerEmployeeId === user.userId.toUpperCase();
  if (user.role === 'FundPartner') {
    return f.uploadedBy === user.userId || (!!partnerOfRequest && partnerOfRequest === user.fundPartnerId);
  }
  return false;
}

/** The origins the bucket must accept browser uploads from. */
export function portalOrigins(): string[] {
  const out: string[] = [];
  try { out.push(new URL(env().PORTAL_URL).origin); } catch { /* validated by env() */ }
  for (const v of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (v) out.push('https://' + v.replace(/^https?:\/\//, ''));
  }
  return [...new Set(out)];
}

/**
 * Idempotent: make sure the bucket's CORS lets the portal PUT and GET
 * directly from the browser. Existing rules are kept; ours is added or
 * replaced only when it is missing something.
 */
export async function ensureBucketCors(origins: string[] = portalOrigins()): Promise<'ok' | 'updated'> {
  const want = corsRuleFor(origins);
  const b = bucket();
  const [meta] = await b.getMetadata();
  const current = (meta.cors ?? []) as { origin?: string[]; method?: string[]; responseHeader?: string[]; maxAgeSeconds?: number }[];
  if (corsSatisfies(current, want)) return 'ok';
  const others = current.filter((r) => !(r.method ?? []).map((m) => m.toUpperCase()).includes('PUT'));
  await b.setCorsConfiguration([...others, want]);
  return 'updated';
}
