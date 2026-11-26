/**
 * Upload rules and Storage layout (Files.gs). Pure.
 *
 * Objects live at  employees/{employeeId}/{appId}/{purpose}/{fileId}.{ext}
 * Each upload gets its own object, so nothing is ever overwritten; a
 * replaced document is marked superseded on its files/{fileId} record and
 * kept (the legacy prefix-delete could remove the partner's CML).
 */
import type { FilePurpose } from '@/lib/schema';

export const MAX_UPLOAD_MB = 8;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type UploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

/** How long a browser has to PUT the file after asking. */
export const UPLOAD_URL_MINUTES = 15;
/** How long a download link works. */
export const DOWNLOAD_URL_MINUTES = 5;

export const FILE_LABELS: Record<FilePurpose, string> = {
  cml: 'CML',
  pan: 'PAN card',
  exerciseProof: 'Exercise payment proof',
  taxProof: 'Tax payment proof',
  notice: 'Exercise notice',
  partnerCml: 'Partner CML',
  partnerTaxProof: 'Partner tax payment proof',
};

/** Purposes a participant may upload themselves. */
export const EMPLOYEE_UPLOAD_PURPOSES: readonly FilePurpose[] = ['cml', 'pan', 'exerciseProof', 'taxProof'];
/** Purposes a fund partner may upload. */
export const PARTNER_UPLOAD_PURPOSES: readonly FilePurpose[] = ['partnerCml', 'partnerTaxProof'];

export function isFilePurpose(v: unknown): v is FilePurpose {
  return typeof v === 'string' && v in FILE_LABELS;
}

export function extFor(contentType: string): string {
  return contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg';
}

export type UploadCheck =
  | { ok: true; contentType: UploadType; size: number; name: string }
  | { ok: false; error: string };

/** Files.save's type and size checks, before any URL is issued. */
export function checkUpload(input: { contentType: unknown; size: unknown; name: unknown }): UploadCheck {
  const type = String(input.contentType ?? '').trim().toLowerCase();
  const normalised = type === 'image/jpg' || type === 'image/pjpeg' ? 'image/jpeg' : type;
  if (!(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(normalised)) {
    return { ok: false, error: 'Upload a PDF, JPG or PNG file. That file is "' + (type || 'of an unknown type') + '".' };
  }
  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'That file is empty. Please choose the file again.' };
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: 'That file is ' + (size / (1024 * 1024)).toFixed(1) + ' MB. The limit is ' + MAX_UPLOAD_MB +
        ' MB — please compress it or upload a clearer, smaller scan.',
    };
  }
  const name = String(input.name ?? '').replace(/[\u0000-\u001f\\/]/g, ' ').trim().slice(0, 160) || 'document';
  return { ok: true, contentType: normalised as UploadType, size, name };
}

/** The object path for an upload. Components are sanitised so a path can never escape its folder. */
export function storagePathFor(p: { employeeId: string; appId: string; purpose: FilePurpose; fileId: string; contentType: string }): string {
  const clean = (x: string) => String(x).toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'X';
  return [
    'employees', clean(p.employeeId), clean(p.appId), p.purpose,
    p.fileId.replace(/[^A-Za-z0-9_-]/g, '') + '.' + extFor(p.contentType),
  ].join('/');
}

/** Content-Disposition for a download, safe for any original name. */
export function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return (inline ? 'inline' : 'attachment') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

/** The CORS rule the bucket needs for direct browser uploads from these origins. */
export function corsRuleFor(origins: string[]) {
  return {
    origin: [...new Set(origins.filter(Boolean))].sort(),
    method: ['PUT', 'GET', 'HEAD'],
    responseHeader: ['Content-Type', 'x-goog-content-length-range'],
    maxAgeSeconds: 3600,
  };
}

/** Is the bucket's CORS already what we want? (Order-insensitive.) */
export function corsSatisfies(
  current: readonly { origin?: string[]; method?: string[]; responseHeader?: string[] }[] | undefined,
  want: ReturnType<typeof corsRuleFor>,
): boolean {
  return (current ?? []).some((r) => {
    const origins = new Set(r.origin ?? []);
    const methods = new Set((r.method ?? []).map((m) => m.toUpperCase()));
    const headers = new Set((r.responseHeader ?? []).map((h) => h.toLowerCase()));
    return want.origin.every((x) => origins.has(x) || origins.has('*')) &&
      want.method.every((m) => methods.has(m)) &&
      want.responseHeader.every((h) => headers.has(h.toLowerCase()));
  });
}

/** What the first bytes of a file say it is (PDF, PNG or JPEG), or null. */
export function sniffType(head: Uint8Array): UploadType | null {
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return 'application/pdf';
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  return null;
}
