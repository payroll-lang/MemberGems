import 'server-only';
import { monthYear, prettyDate, readFmvRow, STATUS, windowIdFor, PARTNER_STATUS } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { bulkEmailsEnabled, sendTemplateResult, type SendResult } from '@/lib/mail';
import { COL, type ApplicationDoc, type FmvDoc, type JobStateDoc, type WindowDoc } from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { applicationsInWindow, applicationsWithStatus, progressOf } from '../applications';
import { getEmployee } from '../employees';
import { partnerLogins } from '../partners';
import { partnerRequestOf } from '../partnerRequests';
import { loadSettings, type Settings } from '../settings';
import { ensureWindow, normalizeWindow, windowRef } from '../windows';
import {
  daysUntil, dedupeKeys, isAbandoned, isDraftReminderDay, isFinalStatus, isStaleWindow, isTaxReminderDay,
  priceDayToCheck, windowOpenJobId,
} from './plan';
import { employeeNotifyEmail, loginAddress } from './recipients';
import { runWindowOpenCampaigns } from './windowOpen';

/**
 * Triggers.daily, run at 08:00 IST. Each step is independent: one failing
 * is reported and the others still run. A JOB audit row records the report.
 */

export interface JobReport {
  ok: boolean;
  job: string;
  today: string;
  lines: string[];
  report: string;
}

function tally(results: SendResult[]): string {
  const c = (r: SendResult) => results.filter((x) => x === r).length;
  const parts = [c('sent') + ' sent'];
  if (c('duplicate')) parts.push(c('duplicate') + ' already sent');
  if (c('suppressed')) parts.push(c('suppressed') + ' suppressed');
  if (c('skipped')) parts.push(c('skipped') + ' with no address');
  if (c('failed')) parts.push(c('failed') + ' FAILED');
  return parts.join(', ');
}

async function step(lines: string[], label: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    lines.push(await fn());
    return true;
  } catch (e) {
    console.error(label + ' failed', e);
    lines.push(label + ': FAILED ' + String((e as Error)?.message ?? e));
    return false;
  }
}

/* ================= 1. price ================= */

/**
 * Is the price the portal needs on record? Prices are entered by the ESOP
 * team (the NSE / Google Finance fetch is not ported), so this only alerts.
 */
export async function checkPrice(settings: Settings, today: string, slot: 'morning' | 'evening'): Promise<string> {
  const day = priceDayToCheck(today, settings.holidays, slot);
  if (!day) return 'price check: ' + prettyDate(today) + ' is not a trading day, nothing to check';
  const snap = await db().collection(COL.fmv).doc(day).get();
  const row = snap.exists ? readFmvRow({ ...(snap.data() as Partial<FmvDoc>), date: day }) : null;
  if (row) return 'price check: ' + day + ' is on record (FMV ' + row.fmv + ')';

  const detail = slot === 'morning'
    ? 'No price is on record for ' + prettyDate(day) + ', which is the day an exercise payment made today would be ' +
      'priced from. Anyone trying to record a payment today will be refused until it is entered.'
    : 'Today, ' + prettyDate(day) + ', was a trading day and its opening and closing price have not been entered yet. ' +
      'Exercise payments made from tomorrow are priced from it, and will be refused until it is entered.';
  if (!settings.adminEmails.length) return 'price check: MISSING ' + day + ' — no ADMIN_NOTIFY_EMAILS to alert';
  const r = await sendTemplateResult('price_load_failed', settings.adminEmails.join(','), {
    symbol: String(settings.config.NSE_SYMBOL ?? '').trim() || 'PWL', date: day, prettyDate: prettyDate(day), detail,
  }, { dedupeKey: dedupeKeys.priceMissing(day, slot, today) });
  return 'price check: MISSING ' + day + ' — ESOP team alert ' + r;
}

/* ================= 2. windows ================= */

async function openWindow(settings: Settings, today: string): Promise<{ line: string; window: WindowDoc }> {
  const w = await ensureWindow(today, settings.portal, 'system');
  if (w.openDate !== today) return { line: 'window: ' + w.windowId + ' already open, nothing announced', window: w };
  if (w.status === 'Closed') return { line: 'window: ' + w.windowId + ' is closed by the ESOP team, nothing announced', window: w };
  if (!bulkEmailsEnabled(settings)) {
    return { line: 'window: ' + w.windowId + ' opened — no announcement sent (BULK_EMAILS_ENABLED=false)', window: w };
  }
  // Start the announcement; it runs in batches (this run and /api/jobs/announce).
  const now = nowIso();
  const doc: JobStateDoc = {
    jobId: windowOpenJobId(w.windowId), kind: 'window_open', windowId: w.windowId, status: 'running', cursor: '',
    sent: 0, skipped: 0, failed: 0, considered: 0, leaseUntil: '', startedAt: now, updatedAt: now, finishedAt: '', lastMessage: '',
  };
  try {
    await db().collection(COL.jobs).doc(doc.jobId).create(doc);
    return { line: 'window: ' + w.windowId + ' opened — announcement started', window: w };
  } catch (e) {
    if ((e as { code?: unknown })?.code === 6) return { line: 'window: announcement for ' + w.windowId + ' already started', window: w };
    throw e;
  }
}

export async function closeStaleWindows(today: string): Promise<string> {
  const snap = await db().collection(COL.windows).where('status', '==', 'Open').get();
  const stale = snap.docs.map((d) => normalizeWindow(d.data(), d.id)).filter((w) => isStaleWindow(w, today));
  for (const w of stale) {
    await db().runTransaction(async (tx) => {
      const cur = await tx.get(windowRef(w.windowId));
      const now = normalizeWindow(cur.data(), cur.id);
      if (!isStaleWindow(now, today)) return;
      tx.update(windowRef(w.windowId), {
        status: 'Closed', closedAt: nowIso(),
        remarks: now.remarks + (now.remarks ? '; ' : '') + 'closed automatically',
      });
    });
  }
  return 'window close: ' + stale.length + ' window(s) closed' + (stale.length ? ' (' + stale.map((w) => w.windowId).join(', ') + ')' : '');
}

/* ================= 4. tax reminders ================= */

export async function taxReminders(today: string): Promise<string> {
  const live = await applicationsWithStatus([STATUS.DRAFT, STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.SENT_BACK]);
  const due = live.filter((a) => !isFinalStatus(a.status) && !isAbandoned(a, today) && a.taxAmount > 0 && a.taxDueDate);
  const windows = new Map<string, string>();
  const results: SendResult[] = [];
  const partnerResults: SendResult[] = [];
  let considered = 0;

  for (const a of due) {
    const daysLeft = daysUntil(today, a.taxDueDate);
    if (daysLeft === null) continue;
    considered++;
    if (!isTaxReminderDay(daysLeft)) continue;
    const pr = await partnerRequestOf(a.appId);
    const prog = progressOf(a, a.taxPaidAmount, pr ? pr.status : null);
    if (prog.done.tax) continue;
    const emp = await getEmployee(a.employeeId);
    if (!emp) continue;
    if (!windows.has(a.windowId)) {
      const w = await windowRef(a.windowId).get();
      windows.set(a.windowId, (w.exists ? normalizeWindow(w.data(), w.id).label : '') || monthYear(a.windowId + '-01'));
    }

    // A fund-partner route reminds the partner's logins as well.
    if (a.taxMode === 'FundPartner' && pr && pr.status === PARTNER_STATUS.ASSIGNED) {
      for (const u of await partnerLogins(pr.fundPartnerId)) {
        const to = loginAddress(u);
        if (!to) continue;
        partnerResults.push(await sendTemplateResult('partner_assigned_partner', to, {
          partner: pr.fundPartnerName, requestId: pr.requestId, appId: a.appId, employeeName: emp.name,
          employeeId: emp.employeeId, totalOptions: a.totalOptions, totalShares: a.totalShares, perquisite: a.perquisiteAmount,
          tax: a.taxAmount, taxDueDate: prettyDate(a.taxDueDate),
        }, { appId: a.appId, dedupeKey: dedupeKeys.partnerTaxReminder(a.appId, u.userId, today) }));
      }
    }

    results.push(await sendTemplateResult('tax_reminder', await employeeNotifyEmail(emp), {
      name: emp.name, appId: a.appId, windowLabel: windows.get(a.windowId), taxDueDate: prettyDate(a.taxDueDate),
      daysLeft: Math.max(0, daysLeft), perquisite: a.perquisiteAmount, tax: a.taxAmount,
    }, { appId: a.appId, dedupeKey: dedupeKeys.taxReminder(a.appId, today) }));
  }
  return 'tax reminders: ' + tally(results) + ' of ' + considered + ' unpaid application(s)' +
    (partnerResults.length ? '; fund partner reminders: ' + tally(partnerResults) : '');
}

/* ================= 5. draft reminders ================= */

export async function draftReminders(window: WindowDoc, today: string): Promise<string> {
  if (!window.closeDate) return 'draft reminders: no close date on ' + window.windowId;
  if (window.status === 'Closed') return 'draft reminders: ' + window.windowId + ' is closed';
  const daysLeft = daysUntil(today, window.closeDate) ?? -999;
  if (!isDraftReminderDay(daysLeft)) return 'draft reminders: ' + daysLeft + ' day(s) to close, nothing due';

  const drafts = (await applicationsInWindow(window.windowId))
    .filter((a: ApplicationDoc) => a.status === STATUS.DRAFT || a.status === STATUS.SENT_BACK);
  const results: SendResult[] = [];
  for (const a of drafts) {
    const emp = await getEmployee(a.employeeId);
    if (!emp) continue;
    const pr = await partnerRequestOf(a.appId);
    const prog = progressOf(a, a.taxPaidAmount, pr ? pr.status : null);
    results.push(await sendTemplateResult('window_closing', await employeeNotifyEmail(emp), {
      name: emp.name, appId: a.appId, windowLabel: window.label || monthYear(window.windowId + '-01'),
      closeDate: prettyDate(window.closeDate), daysLeft: Math.max(0, daysLeft),
      pending: prog.pendingLabels.join(', ') || 'submit the application',
    }, { appId: a.appId, dedupeKey: dedupeKeys.draftReminder(a.appId, today) }));
  }
  return 'draft reminders: ' + tally(results) + ' to ' + drafts.length + ' open draft(s), ' + daysLeft + ' day(s) to close';
}

/* ================= the jobs ================= */

function finish(job: string, today: string, lines: string[], ok: boolean): JobReport {
  return { ok, job, today, lines, report: lines.join('\n') };
}

/** The 08:00 IST job. `budgetMs` bounds the window-open batch work done in this run. */
export async function runDailyJob(opts: { now?: Date; budgetMs?: number; actor?: string } = {}): Promise<JobReport> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const today = todayIst(now);
  const lines: string[] = [];
  let ok = true;
  const settings = await loadSettings();

  ok = (await step(lines, 'price check', () => checkPrice(settings, today, 'morning'))) && ok;
  const opened: { window: WindowDoc | null } = { window: null };
  ok = (await step(lines, 'window', async () => {
    const r = await openWindow(settings, today);
    opened.window = r.window;
    return r.line;
  })) && ok;
  ok = (await step(lines, 'window close', () => closeStaleWindows(today))) && ok;
  ok = (await step(lines, 'announcement', async () => {
    const budget = Math.max(0, (opts.budgetMs ?? 150_000) - (Date.now() - started));
    return runWindowOpenCampaigns(settings, today, started + budget);
  })) && ok;
  ok = (await step(lines, 'tax reminders', () => taxReminders(today))) && ok;
  ok = (await step(lines, 'draft reminders', async () => {
    const w = opened.window ?? (await ensureWindow(today, settings.portal, 'system'));
    if (w.windowId !== windowIdFor(today)) return 'draft reminders: no window this month';
    return draftReminders(w, today);
  })) && ok;

  lines.push('took ' + Math.round((Date.now() - started) / 1000) + 's');
  const rep = finish('DAILY_JOB', today, lines, ok);
  try { await audit(opts.actor ?? 'system', opts.actor ? 'Admin' : 'system', 'DAILY_JOB', rep.report); } catch (e) { console.error('daily job audit failed', e); }
  return rep;
}

/** The 20:00 IST job: alert if today's price (a trading day) is not on record. */
export async function runPriceJob(opts: { now?: Date } = {}): Promise<JobReport> {
  const today = todayIst(opts.now ?? new Date());
  const lines: string[] = [];
  const settings = await loadSettings();
  const ok = await step(lines, 'price check', () => checkPrice(settings, today, 'evening'));
  const rep = finish('PRICE_JOB', today, lines, ok);
  try { await audit('system', 'system', 'PRICE_JOB', rep.report); } catch (e) { console.error('price job audit failed', e); }
  return rep;
}

/** Every 15 minutes: continue a window announcement still in progress. Cheap when there is none. */
export async function runAnnounceJob(opts: { now?: Date; budgetMs?: number } = {}): Promise<JobReport> {
  const started = Date.now();
  const today = todayIst(opts.now ?? new Date());
  const pending = await db().collection(COL.jobs).where('status', '==', 'running').limit(5).get();
  if (pending.empty) return finish('ANNOUNCE_JOB', today, ['announcement: nothing in progress'], true);
  const lines: string[] = [];
  const settings = await loadSettings();
  const ok = await step(lines, 'announcement', () =>
    runWindowOpenCampaigns(settings, today, started + (opts.budgetMs ?? 240_000)));
  const rep = finish('ANNOUNCE_JOB', today, lines, ok);
  try { await audit('system', 'system', 'ANNOUNCE_JOB', rep.report); } catch (e) { console.error('announce job audit failed', e); }
  return rep;
}
