/**
 * Share prices and the exchange-holiday calendar. Pure.
 *
 * AGREED CHANGE: an exercise payment is priced at the immediately previous
 * TRADING day and stops when that day has no price, so the calendar has to be
 * right and every trading day has to have a price.
 */
import { addDays, isTradingDay, toDateKey } from '@/domain';

/** Weekdays (not holidays) from `days` days ago up to yesterday that have no price. */
export function missingPriceDays(today: string, priced: ReadonlySet<string>, holidays: readonly string[], days = 60): string[] {
  const out: string[] = [];
  for (let d = addDays(today, -days); d < today; d = addDays(d, 1)) {
    if (isTradingDay(d, holidays) && !priced.has(d)) out.push(d);
  }
  return out.reverse();
}

/**
 * The holiday editor's text: one date per line (yyyy-mm-dd, dd/mm/yyyy,
 * "08 Nov 2026" …), anything after the date ignored. Returns sorted,
 * de-duplicated dates, or the lines that could not be read.
 */
export function parseHolidays(text: string): { ok: true; dates: string[] } | { ok: false; errors: string[] } {
  const dates = new Set<string>();
  const errors: string[] = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const candidates = [line, line.split(/\s+[-–—]\s+|\t|,(?=\s*[A-Za-z])/)[0], line.split(/\s+/)[0], line.split(/\s+/).slice(0, 3).join(' ')];
    const key = candidates.map((c) => toDateKey(c.trim())).find((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
    if (!key) { errors.push('Line ' + (i + 1) + ': "' + line + '" is not a date.'); return; }
    if (key < '2000-01-01' || key > '2100-12-31') { errors.push('Line ' + (i + 1) + ': ' + key + ' is out of range.'); return; }
    dates.add(key);
  });
  return errors.length ? { ok: false, errors } : { ok: true, dates: [...dates].sort() };
}
