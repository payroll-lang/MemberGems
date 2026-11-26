/**
 * Spreadsheet-shaped input (an uploaded .xlsx/.csv, or rows pasted from a
 * spreadsheet) as a plain grid of cells. Pure — safe in the browser too.
 */

export type Cell = string | number | boolean | Date | null | undefined;
export type Grid = Cell[][];

/** Util.slug: lower-case letters and digits only, for matching headings. */
export function slug(s: unknown): string {
  return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A whole CSV file as rows of strings (RFC 4180: quoted fields, doubled
 * quotes, CR/LF line ends, a leading byte-order mark). A final empty line is
 * dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < n; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** Is every cell of a row blank? */
export function blankRow(r: readonly Cell[] | undefined): boolean {
  return !r || r.every((c) => c === null || c === undefined || String(c).trim() === '');
}

/**
 * Rows pasted from a spreadsheet: one per line, tab separated (or commas
 * outside double quotes, as the legacy dialogs accepted). Cells are trimmed
 * and stripped of surrounding quotes; blank lines are dropped.
 */
export function parsePaste(text: string): string[][] {
  return String(text ?? '').split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const cells = line.includes('\t') ? line.split('\t') : line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    return cells.map((x) => x.trim().replace(/^"|"$/g, '').trim());
  });
}

/** Employee codes in free text (spaces, commas, semicolons, new lines), upper-cased, de-duplicated. */
export function parseIdList(text: string): string[] {
  const out: string[] = [];
  String(text ?? '').split(/[\s,;]+/).forEach((x) => {
    const id = x.trim().toUpperCase();
    if (id && !out.includes(id)) out.push(id);
  });
  return out;
}
