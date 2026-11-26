/**
 * The date rules and dedupe keys of the scheduled jobs (Triggers.gs). Pure.
 *
 * Every reminder carries a deterministic dedupe key, used as the emailLog
 * document id (created only if absent). Legacy's alreadySent() looked for a
 * 'sent' row of the same template and AppID whose timestamp began with
 * today's date — but Mailer.log never wrote the AppID for most templates and
 * the window announcement was keyed by window, so re-runs re-sent (review
 * item: broken dedupe). Here a second run for the same key sends nothing.
 */
import { STATUS, addDays, daysBetween, isTradingDay, previousTradingDay, windowKey } from '@/domain';

/** Days before the tax due date on which a reminder goes (Triggers.taxReminders). */
export const TAX_REMINDER_DAYS = [5, 2, 0, -1] as const;
/** Days before the window closes on which an unsubmitted draft is nudged. */
export const DRAFT_REMINDER_DAYS = [2, 0] as const;

export function isTaxReminderDay(daysLeft: number): boolean {
  return (TAX_REMINDER_DAYS as readonly number[]).includes(daysLeft);
}

export function isDraftReminderDay(daysLeft: number): boolean {
  return (DRAFT_REMINDER_DAYS as readonly number[]).includes(daysLeft);
}

/** Whole days from today to a date key; null when there is no date. */
export function daysUntil(today: string, date: string): number | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? daysBetween(today, date) : null;
}

/**
 * Which day's price the job must find on record.
 *   morning (08:00): the trading day before today — what a payment made
 *     today is priced from (Triggers.checkPriceForToday, now holiday-aware).
 *   evening (20:00): today, if today is a trading day — the close is out.
 */
export function priceDayToCheck(today: string, holidays: readonly string[], slot: 'morning' | 'evening'): string | null {
  if (slot === 'morning') return previousTradingDay(today, holidays);
  return isTradingDay(today, holidays) ? today : null;
}

/** Statuses a tax reminder never goes to. */
export function isFinalStatus(status: string): boolean {
  return status === STATUS.APPROVED || status === STATUS.REJECTED;
}

/**
 * A Draft or Sent Back application from an earlier window was abandoned when
 * its window closed (its options are released), so it is not reminded.
 * (Deviation: legacy reminded every non-final application.)
 */
export function isAbandoned(app: { status: string; windowId: string }, today: string): boolean {
  const draft = app.status === STATUS.DRAFT || app.status === STATUS.SENT_BACK;
  return draft && windowKey(app.windowId) < today.slice(0, 7);
}

/** A window still Open whose close date has passed (Triggers.closeStaleWindows). */
export function isStaleWindow(w: { status: string; closeDate: string }, today: string): boolean {
  return w.status !== 'Closed' && !!w.closeDate && w.closeDate < today;
}

/* ================= dedupe keys ================= */

export const dedupeKeys = {
  taxReminder: (appId: string, today: string) => 'tax_reminder:' + appId + ':' + today,
  partnerTaxReminder: (appId: string, userId: string, today: string) => 'partner_tax_reminder:' + appId + ':' + userId + ':' + today,
  draftReminder: (appId: string, today: string) => 'window_closing:' + appId + ':' + today,
  windowOpen: (windowId: string, employeeId: string) => 'window_open:' + windowId + ':' + employeeId,
  priceMissing: (priceDate: string, slot: 'morning' | 'evening', today: string) => 'price_missing:' + priceDate + ':' + slot + ':' + today,
};

/** The window_open campaign's job document id. */
export function windowOpenJobId(windowId: string): string {
  return 'window_open-' + windowId;
}

/** For tests and reports: the dates in the next n days on which a tax reminder would go. */
export function taxReminderDates(taxDueDate: string): string[] {
  return TAX_REMINDER_DAYS.map((d) => addDays(taxDueDate, -d));
}
