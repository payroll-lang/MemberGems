import 'server-only';
import ExcelJS from 'exceljs';
import { bucket } from '@/lib/firebase';
import { addMinutes, nowIso, todayIst } from '@/lib/time';
import { UserError } from '../core/errors';
import { uid } from '../db';
import { parseCsv, type Cell, type Grid } from './core/grid';

/**
 * Report files the ESOP team uploads (the vesting report, the tax sheet as
 * .xlsx). They go straight from the browser to the private bucket with a
 * signed PUT URL — the vesting report is several MB, over what a request to
 * the portal may carry — and are read back here.
 */

export type ImportKind = 'grantReport' | 'taxSheet';
export const IMPORT_MAX_BYTES = 40 * 1024 * 1024;
const TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};
const LENGTH_RANGE = '0,' + IMPORT_MAX_BYTES;

export interface ImportTicket {
  path: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export async function importUploadTicket(kind: ImportKind, name: string, size: number, allowCsv: boolean): Promise<ImportTicket> {
  const ext = String(name).toLowerCase().split('.').pop() ?? '';
  if (!(ext in TYPES) || (ext === 'csv' && !allowCsv)) {
    throw new UserError(allowCsv ? 'Choose the report as an .xlsx or .csv file.' : 'Choose the report as an .xlsx file.');
  }
  if (!Number.isFinite(size) || size <= 0) throw new UserError('That file is empty.');
  if (size > IMPORT_MAX_BYTES) throw new UserError('That file is over ' + IMPORT_MAX_BYTES / 1048576 + ' MB.');
  const path = 'imports/' + kind + '/' + todayIst() + '/' + uid('I') + '.' + ext;
  const expires = addMinutes(new Date(), 15);
  const contentType = TYPES[ext];
  const [url] = await bucket().file(path).getSignedUrl({
    version: 'v4', action: 'write', expires, contentType, extensionHeaders: { 'x-goog-content-length-range': LENGTH_RANGE },
  });
  return { path, url, headers: { 'Content-Type': contentType, 'x-goog-content-length-range': LENGTH_RANGE }, expiresAt: nowIso(expires) };
}

export function checkImportPath(kind: ImportKind, path: string): string {
  const p = String(path ?? '');
  const re = new RegExp('^imports/' + kind + '/\\d{4}-\\d{2}-\\d{2}/I[A-Za-z0-9_-]+\\.(xlsx|csv)$');
  if (!re.test(p)) throw new UserError('That upload was not found. Choose the file again.');
  return p;
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return '';
  if (v instanceof Date || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('');
    if ('result' in o) return cellValue(o.result as ExcelJS.CellValue);
    if ('text' in o) return String(o.text ?? '');
    if ('error' in o) return '';
  }
  return String(v);
}

/** A worksheet as a grid. Dates arrive as Date (UTC midnight of the cell's day), read in IST by toDateKey. */
export function sheetGrid(ws: ExcelJS.Worksheet): Grid {
  const grid: Grid = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = (row.values as ExcelJS.CellValue[]).slice(1).map(cellValue);
    grid[n - 1] = vals;
  });
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return grid;
}

/** Read an uploaded report. For .xlsx: the named sheet if present, else the sheet with the most rows. */
export async function readImportGrid(path: string, preferSheet?: string): Promise<{ grid: Grid; sheet: string }> {
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw new UserError('The file did not arrive. Choose it and upload it again.');
  const [buf] = await file.download();
  if (path.endsWith('.csv')) return { grid: parseCsv(buf.toString('utf8')), sheet: '' };
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new UserError('That file could not be read as an Excel workbook (.xlsx). Save it from Excel as .xlsx, or as .csv.');
  }
  const sheets = wb.worksheets;
  if (!sheets.length) throw new UserError('That workbook has no sheets.');
  const named = preferSheet ? sheets.find((s) => s.name.trim().toLowerCase() === preferSheet.toLowerCase()) : undefined;
  const ws = named ?? [...sheets].sort((a, b) => b.rowCount - a.rowCount)[0];
  return { grid: sheetGrid(ws), sheet: ws.name };
}

/** Remove an uploaded file (the tax sheet carries personal data the portal does not keep). */
export async function deleteImport(path: string): Promise<void> {
  try { await bucket().file(path).delete({ ignoreNotFound: true }); } catch (e) { console.error('delete import ' + path, e); }
}
