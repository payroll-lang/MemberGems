/**
 * Low-level helpers ported from Repo.gs `Util`.
 *
 * Everything here is pure. Dates are 'yyyy-MM-dd' strings meaning a calendar
 * day in Asia/Kolkata; timestamps are 'yyyy-MM-dd HH:mm:ss' (IST) or ISO-8601
 * strings with an offset. IST has no daylight saving, so day arithmetic is
 * done on UTC calendar values and a fixed +05:30 offset.
 */

/** A value that may arrive from a sheet, a form or Firestore. */
export type Numeric = number | string | boolean | null | undefined;

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const DAY_MS = 86400000;

/** Util.trim */
export function trim(v: unknown): string {
  return String(v === null || v === undefined ? '' : v).trim();
}

/**
 * Util.num — a number from a cell, tolerating how people type money
 * ("₹ 79.99", "1,25,000", "Rs 500", "(250)"). Dates are not accepted here
 * (legacy returned getTime(); the domain never relies on that).
 */
export function num(v: Numeric, dflt?: number): number {
  const fallback = dflt === undefined ? 0 : dflt;
  if (v === '' || v === null || v === undefined || v === '-') return fallback;
  if (typeof v === 'number') return isNaN(v) ? fallback : v;
  if (typeof v === 'boolean') return v ? 1 : 0;

  let s = String(v).trim();
  if (!s) return fallback;

  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }

  s = s
    .replace(/[₹$£€]/g, '')
    .replace(/\brs\.?\b/gi, '')
    .replace(/\binr\b/gi, '')
    .replace(/[,\s ]/g, '')
    .replace(/%$/, '');

  if (s === '' || s === '-' || s === '.') return fallback;
  const n = Number(s);
  return isNaN(n) ? fallback : sign * n;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** yyyy-MM-dd from calendar parts, rolling over like `new Date(y, m, d)`. */
export function ymd(year: number, monthIndex: number, day: number): string {
  const t = new Date(0);
  t.setUTCFullYear(year, monthIndex, day);
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}

function istPartsOfInstant(ms: number): { y: number; m: number; d: number; hh: number; mi: number; ss: number } {
  const t = new Date(ms + IST_OFFSET_MS);
  return {
    y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(),
    hh: t.getUTCHours(), mi: t.getUTCMinutes(), ss: t.getUTCSeconds()
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Util.toDate followed by Util.dateKey: the calendar day a value names, as
 * 'yyyy-MM-dd', or '' when it names none. Accepts yyyy-MM-dd (any suffix),
 * dd/MM/yyyy, dd-MM-yyyy, "Sep 08, 2026", "08-Sep-2026", a spreadsheet serial
 * or a Date (read in IST). 0, '-' and '' are "no date".
 */
export function toDateKey(v: unknown): string {
  if (v === null || v === undefined || v === '' || v === '-') return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const p = istPartsOfInstant(v.getTime());
    return ymd(p.y, p.m, p.d);
  }
  if (typeof v === 'number') {
    if (v <= 0 || isNaN(v)) return '';
    const p = istPartsOfInstant((v - 25569) * DAY_MS);
    return ymd(p.y, p.m, p.d);
  }
  const s = String(v).trim();
  if (!s || s === '-' || s === '0') return '';
  // An ISO instant with a zone (e.g. ...T19:00:00Z, +05:30) is a moment in
  // time: take its India date, not the calendar date written in UTC.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const ms = Date.parse(s);
    if (!isNaN(ms)) {
      const p = istPartsOfInstant(ms);
      return ymd(p.y, p.m, p.d);
    }
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return ymd(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s*(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mi >= 0) return ymd(Number(m[3]), mi, Number(m[2]));
  }
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) return ymd(Number(m[3]), mi, Number(m[1]));
  }
  const ms = Date.parse(s);
  if (isNaN(ms)) return '';
  const p = istPartsOfInstant(ms);
  return ymd(p.y, p.m, p.d);
}

/** Midnight IST of a date key, as epoch ms. */
export function dayStartMs(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
}

/**
 * A timestamp as epoch ms. 'yyyy-MM-dd HH:mm[:ss]' without an offset is IST
 * (how the legacy sheet wrote it); ISO strings with Z or an offset are exact;
 * a bare date is midnight IST. Returns null for no value.
 */
export function instantMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return v > 0 ? (v - 25569) * DAY_MS : null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0),
      m[7] ? Number((m[7] + '00').slice(0, 3)) : 0);
    if (!m[8]) return base - IST_OFFSET_MS;
    if (m[8].toUpperCase() === 'Z') return base;
    const sign = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(':', '');
    const off = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
    return base - sign * off;
  }
  const key = toDateKey(s);
  return key ? dayStartMs(key) : null;
}

/** Util.addDays on date keys. */
export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return ymd(y, m - 1, d + n);
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayStartMs(b) - dayStartMs(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Util.lastDayOfMonth (monthIndex is 0-based). */
export function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function parts(dateKey: string): { year: number; monthIndex: number; day: number } {
  const [y, m, d] = dateKey.split('-').map(Number);
  return { year: y, monthIndex: m - 1, day: d };
}

/** Util.prettyDate: "08 Sep 2026". */
export function prettyDate(v: unknown): string {
  const k = toDateKey(v);
  if (!k) return '';
  const p = parts(k);
  return pad2(p.day) + ' ' + MONTH_SHORT[p.monthIndex] + ' ' + p.year;
}

/** "September 2026" for a date key. */
export function monthYear(dateKey: string): string {
  const p = parts(dateKey);
  return MONTH_NAMES[p.monthIndex] + ' ' + p.year;
}

/** Util.prettyStamp: "08 Sep 2026 at 20:44 IST". */
export function prettyStamp(v: unknown): string {
  const ms = instantMs(v);
  if (ms === null) return '';
  const p = istPartsOfInstant(ms);
  return pad2(p.d) + ' ' + MONTH_SHORT[p.m] + ' ' + p.y + ' at ' + pad2(p.hh) + ':' + pad2(p.mi) + ' IST';
}

/** Util.stamp for an instant: "yyyy-MM-dd HH:mm:ss" in IST. */
export function istStamp(ms: number): string {
  const p = istPartsOfInstant(ms);
  return ymd(p.y, p.m, p.d) + ' ' + pad2(p.hh) + ':' + pad2(p.mi) + ':' + pad2(p.ss);
}

/** Util.windowKey: canonical 'yyyy-MM' of a WindowID. */
export function windowKey(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return toDateKey(v).slice(0, 7);
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return m[1] + '-' + String(Number(m[2])).padStart(2, '0');
  const k = toDateKey(s);
  return k ? k.slice(0, 7) : s;
}
