/**
 * Fair market value (Domain.gs 113-183).
 *
 * AGREED CHANGE: the FMV for a payment is the price of the immediately
 * previous TRADING day (weekends and listed exchange holidays skipped). If
 * that day has no usable price the result is PRICE_MISSING — legacy walked
 * back to whatever older row existed.
 */
import { addDays, dayOfWeek, num, prettyDate, toDateKey, trim, type Numeric } from './util';

export interface FmvRow {
  date: unknown;
  openPrice?: Numeric;
  closePrice?: Numeric;
  /** The stated FMV, used only when open/close are not both positive. */
  fmv?: Numeric;
  source?: string;
}

export interface FmvPoint {
  date: string;
  prettyDate: string;
  open: number | null;
  close: number | null;
  fmv: number;
  source: string;
}

/** One FMV row as Domain.fmvRows reads it, or null when it is unusable. */
export function readFmvRow(r: FmvRow): FmvPoint | null {
  const open = num(r.openPrice, NaN);
  const close = num(r.closePrice, NaN);
  const stated = num(r.fmv, NaN);
  const usable = (!isNaN(open) && !isNaN(close) && open > 0 && close > 0) ? (open + close) / 2 : stated;
  const date = toDateKey(r.date);
  const fmv = Math.round(usable * 100) / 100;
  if (!date || !(fmv > 0)) return null;
  return {
    date,
    prettyDate: prettyDate(date),
    open: isNaN(open) ? null : open,
    close: isNaN(close) ? null : close,
    fmv,
    source: trim(r.source)
  };
}

/** Usable rows, newest first (Domain.fmvRows). */
export function fmvPoints(rows: readonly FmvRow[]): FmvPoint[] {
  return rows.map(readFmvRow).filter((p): p is FmvPoint => p !== null)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Domain.latestFmv */
export function latestFmv(rows: readonly FmvRow[]): FmvPoint | null {
  const p = fmvPoints(rows);
  return p.length ? p[0] : null;
}

/** FMV of a day's prices, as Domain.upsertFmv stores it. */
export function fmvFromPrices(open: Numeric, close: Numeric):
  { ok: true; open: number; close: number; fmv: number } | { ok: false; error: string } {
  const o = num(open, NaN), c = num(close, NaN);
  if (isNaN(o) || o <= 0 || isNaN(c) || c <= 0) {
    return { ok: false, error: 'Enter both the opening and closing price as positive numbers.' };
  }
  return { ok: true, open: o, close: c, fmv: Math.round(((o + c) / 2) * 100) / 100 };
}

export function isTradingDay(date: string, holidays: readonly string[]): boolean {
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return false;
  return holidays.indexOf(date) < 0;
}

/** The last trading day strictly before `date`. */
export function previousTradingDay(date: string, holidays: readonly string[]): string {
  const hol = holidays.map((h) => toDateKey(h)).filter(Boolean);
  let d = addDays(date, -1);
  for (let i = 0; i < 366 && !isTradingDay(d, hol); i++) d = addDays(d, -1);
  return d;
}

export type FmvResult =
  | ({ ok: true } & FmvPoint)
  | { ok: false; reason: 'NO_DATE'; date: '' }
  | { ok: false; reason: 'PRICE_MISSING'; date: string };

/**
 * The FMV that applies to an exercise paid on `paymentDate`: (open + close)/2,
 * rounded to 2 dp, of the immediately previous trading day.
 */
export function fmvFor(paymentDate: unknown, rows: readonly FmvRow[], holidays: readonly string[]): FmvResult {
  const pay = toDateKey(paymentDate);
  if (!pay) return { ok: false, reason: 'NO_DATE', date: '' };
  const day = previousTradingDay(pay, holidays);
  const hit = fmvPoints(rows).filter((p) => p.date === day)[0];
  if (!hit) return { ok: false, reason: 'PRICE_MISSING', date: day };
  return { ok: true, ...hit };
}

/** The participant-facing message for a failed fmvFor. */
export function fmvErrorMessage(r: Exclude<FmvResult, { ok: true }>): string {
  if (r.reason === 'NO_DATE') return 'Enter the date on which you paid the exercise amount.';
  return 'The PWL share price for ' + prettyDate(r.date) + ', the trading day before your payment, ' +
    'is not on record yet. The ESOP team has been alerted and will load it; you can then save this step.';
}
