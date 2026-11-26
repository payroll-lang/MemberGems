/**
 * Exercise windows and the tax due date (Domain.gs 28-110).
 */
import type { PortalSettings } from './config';
import { daysBetween, lastDayOfMonth, monthYear, parts, prettyDate, trim, ymd } from './util';

export interface WindowDef {
  windowId: string;
  label: string;
  openDate: string;
  closeDate: string;
  taxDueDate: string;
  status: 'Open' | 'Closed';
}

/** Domain.windowIdFor: 'yyyy-MM'. */
export function windowIdFor(date: string): string {
  return date.slice(0, 7);
}

/** Domain.taxDueDateFor: the due day this month, or next month if past it. */
export function taxDueDateFor(referenceDate: string, settings: PortalSettings): string {
  const { year, monthIndex, day } = parts(referenceDate);
  const dueDay = settings.taxDueDay;
  if (day <= dueDay) {
    return ymd(year, monthIndex, Math.min(dueDay, lastDayOfMonth(year, monthIndex)));
  }
  const nm = parts(ymd(year, monthIndex + 1, 1));
  return ymd(nm.year, nm.monthIndex, Math.min(dueDay, lastDayOfMonth(nm.year, nm.monthIndex)));
}

/** The window Domain.ensureWindow would create for the month of `date`. */
export function windowFor(date: string, settings: PortalSettings): WindowDef {
  const { year, monthIndex } = parts(date);
  const openDay = Math.max(1, settings.windowOpenDay);
  const closeDay = settings.windowCloseDay;
  const last = lastDayOfMonth(year, monthIndex);
  const open = ymd(year, monthIndex, Math.min(openDay, last));
  const close = ymd(year, monthIndex, Math.min(closeDay, last));
  return {
    windowId: windowIdFor(date),
    label: monthYear(date),
    openDate: open,
    closeDate: close,
    taxDueDate: taxDueDateFor(close, settings),
    status: 'Open'
  };
}

export interface WindowState {
  open: boolean;
  reason: string;
}

/** Domain.windowState for `today`. */
export function windowState(
  w: { label: string; openDate: string; closeDate: string; status: string },
  today: string
): WindowState {
  const label = trim(w.label);
  if (trim(w.status).toLowerCase() === 'closed') {
    return { open: false, reason: 'The ' + label + ' exercise window has been closed by the ESOP team.' };
  }
  if (today < w.openDate) {
    return { open: false, reason: 'The ' + label + ' window opens on ' + prettyDate(w.openDate) + '.' };
  }
  if (today > w.closeDate) {
    return { open: false, reason: 'The ' + label + ' window closed on ' + prettyDate(w.closeDate) + '.' };
  }
  return {
    open: true,
    reason: 'Open until ' + prettyDate(w.closeDate) + ' · ' +
      Math.max(0, daysBetween(today, w.closeDate)) + ' days left'
  };
}

