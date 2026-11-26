import 'server-only';
import { STATUS, fmvFromPrices, isTradingDay, prettyDate, toDateKey, trim, inr2 } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { COL, type FmvDoc, type UserDoc } from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { UserError, type ActionResult } from '../core/errors';
import { loadSettings } from '../settings';
import { missingPriceDays } from './core/prices';
import { recentPrices } from './data';
import { autoReprice } from './review';
import { idList, plural, runAdmin } from './run';

/**
 * Share prices, entered by hand. (The legacy NSE bhavcopy fetch was switched
 * off and Google Finance only works inside Sheets, so there is no automatic
 * source on this portal yet.)
 */

export interface PricesView {
  rows: FmvDoc[];
  holidays: string[];
  missing: string[];
  today: string;
}

export async function loadPrices(): Promise<PricesView> {
  const settings = await loadSettings();
  const today = todayIst();
  const rows = await recentPrices(120);
  const priced = new Set(rows.filter((r) => r.fmv > 0).map((r) => r.date));
  return { rows, holidays: settings.holidays, missing: missingPriceDays(today, priced, settings.holidays, 60), today };
}

/** AdminApi.saveFmv: store a day's prices, then reprice the drafts priced on that day. */
export function savePrice(user: UserDoc, input: { date: string; open: string; close: string; source: string }): Promise<ActionResult> {
  return runAdmin(user, 'savePrice', async () => {
    const date = toDateKey(trim(input.date));
    if (!date) throw new UserError('Enter a valid date.');
    const today = todayIst();
    if (date > today) throw new UserError('That date is in the future.');
    const settings = await loadSettings();
    if (!isTradingDay(date, settings.holidays)) {
      throw new UserError(prettyDate(date) + ' is a weekend or an exchange holiday on the calendar, so its price is never used. ' +
        'If the exchange did trade that day, remove it from the holiday calendar first.');
    }
    const p = fmvFromPrices(input.open, input.close);
    if (!p.ok) throw new UserError(p.error);
    const ref = db().collection(COL.fmv).doc(date);
    const before = (await ref.get()).data() as Partial<FmvDoc> | undefined;
    const doc: FmvDoc = {
      date, openPrice: p.open, closePrice: p.close, fmv: p.fmv, source: trim(input.source) || 'Manual entry',
      enteredBy: user.userId, enteredAt: nowIso(),
    };
    await ref.set(doc);

    // A corrected price must not leave stale figures — but only drafts move (AGREED CHANGE).
    const snap = await db().collection(COL.applications).where('fmvDate', '==', date).get();
    const open = snap.docs.filter((d) => ![STATUS.APPROVED, STATUS.REJECTED].includes(String(d.get('status')) as 'Approved')).map((d) => d.id);
    const rep = open.length ? await autoReprice(open, user.userId, 'FMV for ' + date + ' set to ' + p.fmv, { fmv: p.fmv }) : null;
    return {
      message: 'FMV for ' + prettyDate(date) + ' set to ' + inr2(p.fmv) + '.' +
        (rep?.repriced.length ? ' ' + plural(rep.repriced.length, 'draft application') + ' repriced.' : '') +
        (rep?.frozen.length ? ' Submitted applications on this date were NOT repriced (use Reprice on each if needed): ' + idList(rep.frozen) + '.' : ''),
      effects: [() => audit(user.userId, 'Admin', 'FMV_SET', date + ' open ' + p.open + ' close ' + p.close + ' fmv ' + p.fmv +
        (before?.fmv ? ' (was ' + before.fmv + ')' : '') + (rep?.repriced.length ? '; repriced ' + rep.repriced.join(', ') : ''))],
    };
  });
}
