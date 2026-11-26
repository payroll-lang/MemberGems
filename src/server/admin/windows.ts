import 'server-only';
import { accessBar, monthYear, prettyDate, toDateKey, trim, windowKey } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { sendTemplate } from '@/lib/mail';
import { COL, type UserDoc, type WindowDoc } from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { UserError, type ActionResult } from '../core/errors';
import { emailFor } from '../employees';
import { loadSettings } from '../settings';
import { ensureWindow, getWindow, normalizeWindow, stateOf, windowRef } from '../windows';
import { grantTotalsByEmployee } from './core/queue';
import { allEmployees, allUsers, grantFigures, listWindows } from './data';
import { runAdmin } from './run';
import { emailSwitches } from './views';

/** Exercise windows. Legacy created and closed them automatically and had no edit screen. */

export async function loadWindows(): Promise<{ windows: WindowDoc[]; today: string; counts: Record<string, number> }> {
  const [windows, apps] = await Promise.all([listWindows(), db().collection(COL.applications).select('windowId').get()]);
  const counts: Record<string, number> = {};
  apps.docs.forEach((d) => { const w = windowKey(d.get('windowId')); counts[w] = (counts[w] || 0) + 1; });
  return { windows, today: todayIst(), counts };
}

export function saveWindow(user: UserDoc, input: { windowId: string; label: string; openDate: string; closeDate: string; taxDueDate: string; status: string; remarks: string }): Promise<ActionResult> {
  return runAdmin(user, 'saveWindow', async () => {
    const id = windowKey(trim(input.windowId));
    const open = toDateKey(input.openDate), close = toDateKey(input.closeDate), due = toDateKey(input.taxDueDate);
    if (!open || !close || !due) throw new UserError('Enter the opening, closing and tax due dates.');
    if (close < open) throw new UserError('The window cannot close before it opens.');
    const status = trim(input.status);
    if (status !== 'Open' && status !== 'Closed') throw new UserError('Status must be Open or Closed.');
    const before = await db().runTransaction(async (tx) => {
      const snap = await tx.get(windowRef(id));
      if (!snap.exists) throw new UserError('Window ' + id + ' was not found.');
      const w = normalizeWindow(snap.data(), snap.id);
      const patch: Partial<WindowDoc> = {
        label: trim(input.label) || w.label || monthYear(id + '-01'), openDate: open, closeDate: close, taxDueDate: due, status,
        remarks: trim(input.remarks),
      };
      if (status === 'Closed' && w.status !== 'Closed') patch.closedAt = nowIso();
      if (status === 'Open') patch.closedAt = '';
      tx.update(windowRef(id), patch);
      return w;
    });
    const next: Record<string, string> = { label: trim(input.label) || before.label, openDate: open, closeDate: close, taxDueDate: due, status, remarks: trim(input.remarks) };
    const diff = Object.keys(next).filter((k) => String(before[k as keyof WindowDoc] ?? '') !== next[k])
      .map((k) => k + ' ' + (String(before[k as keyof WindowDoc] ?? '') || '—') + ' → ' + (next[k] || '—'));
    return {
      message: 'Window ' + id + ' updated.' + (diff.length ? '' : ' (No change.)') +
        (due !== before.taxDueDate ? ' Applications already priced keep the due date fixed by their payment date.' : ''),
      effects: [() => audit(user.userId, 'Admin', 'WINDOW_UPDATED', id + ': ' + (diff.join('; ') || 'no change'))],
    };
  });
}

/** Create a month's window with the configured days (what the daily job does on the 1st). */
export function createWindow(user: UserDoc, month: string): Promise<ActionResult> {
  return runAdmin(user, 'createWindow', async () => {
    const id = windowKey(trim(month));
    if (!/^\d{4}-\d{2}$/.test(id)) throw new UserError('Choose a month.');
    if (await getWindow(id)) throw new UserError('Window ' + id + ' already exists — edit it below.');
    const settings = await loadSettings();
    const w = await ensureWindow(id + '-01', settings.portal, user.userId);
    return {
      message: 'Window ' + w.windowId + ' created: ' + prettyDate(w.openDate) + ' to ' + prettyDate(w.closeDate) + ', tax due ' + prettyDate(w.taxDueDate) + '.',
      effects: [() => audit(user.userId, 'Admin', 'WINDOW_CREATED', w.windowId + ' ' + w.openDate + '–' + w.closeDate)],
    };
  });
}

export const ANNOUNCE_BATCH = 100;

/**
 * AdminApi.announceWindow: email everyone with something exercisable who may
 * act, that this month's window is open. Gated by BULK_EMAILS_ENABLED and
 * batched (the client calls again with the cursor until done). Each email has
 * the same de-duplication key as the scheduled announcement, so a person is
 * never told twice however the two overlap.
 */
export function announceWindow(user: UserDoc, input: { cursor: string }): Promise<ActionResult> {
  return runAdmin(user, 'announceWindow', async () => {
    const settings = await loadSettings();
    if (!emailSwitches(settings.config).bulk) {
      throw new UserError('Bulk participant emails are switched off, so nothing was sent. This announcement would email every ' +
        'participant with exercisable options. To send it, set BULK_EMAILS_ENABLED to true in Settings, press this again, ' +
        'then set it back to false.');
    }
    const today = todayIst();
    const win = await getWindow(today.slice(0, 7));
    if (!win || !stateOf(win, today).open) throw new UserError('This month’s window is not open, so there is nothing to announce.');
    const [employees, grants, users] = await Promise.all([allEmployees(), grantFigures(), allUsers()]);
    const totals = grantTotalsByEmployee(grants, settings.portal);
    const userById = new Map(users.map((u) => [u.userId.toUpperCase(), u]));
    const candidates = employees
      .filter((e) => (totals.get(e.employeeId)?.exercisable ?? 0) > 0 && !accessBar(e, settings.portal))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    const cursor = trim(input.cursor);
    const rest = candidates.filter((e) => !cursor || e.employeeId > cursor);
    const slice = rest.slice(0, ANNOUNCE_BATCH);
    let sent = 0;
    const skipped: string[] = [];
    for (const e of slice) {
      const u = userById.get(e.employeeId);
      const to = emailFor(e) || (u ? trim(u.notifyEmail) || trim(u.loginEmails?.[0]) : '');
      if (!to) { skipped.push(e.employeeId + ' — no email'); continue; }
      const ok = await sendTemplate('window_open', to, {
        name: e.name, windowLabel: win.label || monthYear(win.windowId + '-01'), openDate: prettyDate(win.openDate),
        closeDate: prettyDate(win.closeDate), taxDueDate: prettyDate(win.taxDueDate),
        available: totals.get(e.employeeId)?.exercisable ?? 0, exercisePrice: settings.portal.exercisePrice, appId: win.windowId,
      }, { dedupeKey: 'window_open:' + win.windowId + ':' + e.employeeId });
      if (ok) sent++; else skipped.push(e.employeeId + ' — not sent (already announced, or mail is off)');
    }
    const next = slice.length ? slice[slice.length - 1].employeeId : cursor;
    const done = rest.length <= slice.length;
    const processed = candidates.length - rest.length + slice.length;
    return {
      message: sent + ' participant(s) emailed in this batch (' + processed + ' of ' + candidates.length + ')' + (done ? '. Done.' : '.'),
      data: { sent, skipped, total: candidates.length, processed, cursor: next, done },
      effects: [() => audit(user.userId, 'Admin', 'WINDOW_ANNOUNCED', win.windowId + ': ' + sent + ' emailed, ' + skipped.length + ' skipped (' + processed + ' of ' + candidates.length + ')')],
    };
  });
}
