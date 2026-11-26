/**
 * Reading payroll's HRIMS tax report (App.html readTaxCsv). Pure, and safe in
 * the browser: a CSV is read on the admin's own computer and only the ten
 * columns the tax needs are sent — names, PAN, date of birth, every deduction
 * and investment stay there, as on the old portal.
 */
import type { TaxSheetInputRow } from '@/domain';
import type { Grid } from './grid';

export const TAX_COLS: readonly [keyof TaxSheetInputRow, string][] = [
  ['employeeId', 'EMP ID'], ['regime', 'Tax Regime'],
  ['netTaxable', 'Net Taxable Salary (Rounded to Next 10)'], ['totalGross', 'Total Gross Salary'],
  ['projectedGross', 'Projected Gross (CTC + Extra Payments)'], ['totalTax', 'Total Tax'],
  ['previousTds', 'Previous TDS'], ['outsideTax', 'Outside Tax / Advance Tax'],
  ['tdsToDate', 'Tax Deducted Till Date'], ['remainingMonths', 'Remaining Months for TDS Deduction'],
];

/** The cap on rows one load may carry (the report has one row per employee). */
export const MAX_TAX_ROWS = 20000;

export interface TaxRow {
  employeeId: string;
  regime: string;
  netTaxable: number;
  totalGross: number;
  projectedGross: number;
  totalTax: number;
  previousTds: number;
  outsideTax: number;
  tdsToDate: number;
  remainingMonths: number;
}

export type TaxRead = { missing: string[]; rows: TaxRow[]; empty?: boolean };

export function normHeader(x: unknown): string {
  return String(x ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function toNum(v: unknown): number {
  const x = Number(String(v || '').replace(/[,\s]/g, ''));
  return isFinite(x) ? x : 0;
}

function finish(r: Partial<Record<keyof TaxSheetInputRow, unknown>>): TaxRow {
  return {
    employeeId: String(r.employeeId ?? '').trim(), regime: String(r.regime ?? '').trim(),
    netTaxable: toNum(r.netTaxable), totalGross: toNum(r.totalGross), projectedGross: toNum(r.projectedGross),
    totalTax: toNum(r.totalTax), previousTds: toNum(r.previousTds), outsideTax: toNum(r.outsideTax),
    tdsToDate: toNum(r.tdsToDate), remainingMonths: toNum(r.remainingMonths),
  };
}

/** One CSV line (the heading row). */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (q) {
      if (c === '"') { if (line.charAt(i + 1) === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else if (c !== '\r') f += c;
  }
  out.push(f);
  return out;
}

/**
 * readTaxCsv: the heading row is row 1; only the wanted columns are kept,
 * character by character; a row with nothing in the wanted columns is dropped.
 */
export function readTaxCsv(text: string): TaxRead {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const nl = text.indexOf('\n', start);
  if (nl < 0) return { missing: [], rows: [], empty: true };
  const head = csvLine(text.slice(start, nl)).map(normHeader);
  const want: Record<number, keyof TaxSheetInputRow> = {};
  const missing: string[] = [];
  TAX_COLS.forEach(([key, label]) => {
    const at = head.indexOf(normHeader(label));
    if (at < 0) missing.push(label); else want[at] = key;
  });
  if (missing.length) return { missing, rows: [] };

  const rows: Partial<Record<keyof TaxSheetInputRow, string>>[] = [];
  let row: Partial<Record<keyof TaxSheetInputRow, string>> = {};
  let col = 0, f = '', q = false, any = false;
  let keep = want[0] !== undefined;
  const endRow = () => {
    if (keep) { row[want[col]] = f; if (f !== '') any = true; }
    if (any) rows.push(row);
    row = {}; col = 0; f = ''; any = false; keep = want[0] !== undefined;
  };
  for (let i = nl + 1; i < text.length; i++) {
    const c = text.charAt(i);
    if (q) {
      if (c === '"') { if (text.charAt(i + 1) === '"') { if (keep) f += '"'; i++; } else q = false; } else if (keep) f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { if (keep) { row[want[col]] = f; if (f !== '') any = true; } f = ''; col++; keep = want[col] !== undefined; }
    else if (c === '\n') endRow();
    else if (c !== '\r' && keep) f += c;
  }
  if (f !== '' || any || col > 0) endRow();
  return { missing: [], rows: rows.map(finish) };
}

/** The same, from an .xlsx read into a grid. The heading row is the first row naming "EMP ID". */
export function taxRowsFromGrid(grid: Grid): TaxRead {
  if (!grid.length) return { missing: [], rows: [], empty: true };
  let h = grid.slice(0, 15).findIndex((r) => (r ?? []).map(normHeader).includes(normHeader('EMP ID')));
  if (h < 0) h = 0;
  const head = (grid[h] ?? []).map(normHeader);
  const want: [number, keyof TaxSheetInputRow][] = [];
  const missing: string[] = [];
  TAX_COLS.forEach(([key, label]) => {
    const at = head.indexOf(normHeader(label));
    if (at < 0) missing.push(label); else want.push([at, key]);
  });
  if (missing.length) return { missing, rows: [] };
  const rows: TaxRow[] = [];
  for (let r = h + 1; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const o: Partial<Record<keyof TaxSheetInputRow, unknown>> = {};
    let any = false;
    want.forEach(([at, key]) => {
      const v = cells[at];
      const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
      o[key] = s;
      if (s !== '') any = true;
    });
    if (any) rows.push(finish(o));
  }
  return { missing: [], rows };
}

/** The participant rows of a read, or the reason there are none (taxSheetDialog's checks). */
export function participantTaxRows(read: TaxRead, participantIds: ReadonlySet<string>): { ok: true; rows: TaxRow[] } | { ok: false; error: string } {
  if (read.empty || (!read.missing.length && !read.rows.length)) return { ok: false, error: 'That file has no data rows.' };
  if (read.missing.length) {
    return { ok: false, error: 'That file is missing these columns: ' + read.missing.join('; ') + '. Is it the HRIMS tax report?' };
  }
  const mine = read.rows.filter((r) => participantIds.has(r.employeeId.toUpperCase()));
  if (!mine.length) return { ok: false, error: 'None of the ' + read.rows.length + ' people in that file are participants on the portal.' };
  return { ok: true, rows: mine };
}

/** Clean a row that arrived from the browser: only the ten fields, of the right types. */
export function sanitizeTaxRow(raw: unknown): TaxRow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const o: Partial<Record<keyof TaxSheetInputRow, unknown>> = {};
  TAX_COLS.forEach(([key]) => { o[key] = r[key]; });
  const row = finish(o);
  row.employeeId = row.employeeId.slice(0, 40);
  row.regime = row.regime.slice(0, 40);
  return row;
}
