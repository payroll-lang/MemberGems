import 'server-only';
import { FieldPath } from 'firebase-admin/firestore';
import { accessBar, computeGrantBalances, inr2, prettyDate } from '@/domain';
import { db } from '@/lib/firebase';
import { bulkEmailsEnabled, sendTemplateResult, type SendResult } from '@/lib/mail';
import { COL, type EmployeeDoc, type JobStateDoc, type WindowDoc } from '@/lib/schema';
import { addMinutes, nowIso } from '@/lib/time';
import { applicationsForEmployee, appsThatMayHold, holdingApps, holdingLines, linesForApps } from '../applications';
import { normalizeEmployee } from '../employees';
import { grantRecord, grantsForEmployee } from '../grants';
import type { Settings } from '../settings';
import { getWindow } from '../windows';
import { dedupeKeys } from './plan';
import { employeeNotifyEmails } from './recipients';

/**
 * The window announcement (Triggers.openAndAnnounce), sent in bounded
 * batches so no single invocation runs past the function time limit.
 *
 * The campaign is a jobs/{window_open-YYYY-MM} document holding a cursor (the
 * last employee id handled, in document-id order) and counts. Each run takes
 * a short lease on it, handles pages of employees until its deadline, saves
 * the cursor after every page and lets go. The next run (the 15-minute
 * announce job, or tomorrow's daily job) carries on from the cursor. Every
 * email also has its own dedupe key, so a page re-done after a crash sends
 * nothing twice.
 */

const PAGE = 40;
const CONCURRENCY = 8;
const LEASE_MINUTES = 6;

function jobRef(jobId: string) {
  return db().collection(COL.jobs).doc(jobId);
}

async function takeLease(jobId: string, owner: string): Promise<JobStateDoc | null> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(jobRef(jobId));
    const job = snap.data() as JobStateDoc | undefined;
    if (!job || job.status !== 'running') return null;
    if (job.leaseUntil && job.leaseUntil > nowIso()) return null;
    tx.update(jobRef(jobId), { leaseUntil: nowIso(addMinutes(new Date(), LEASE_MINUTES)), leaseOwner: owner });
    return job;
  });
}

/** How many options this participant could exercise today (Domain.grantsFor(...).exercisable). */
async function exercisableOptions(emp: EmployeeDoc, settings: Settings, today: string): Promise<number> {
  const [grants, apps] = await Promise.all([grantsForEmployee(emp.employeeId), applicationsForEmployee(emp.employeeId)]);
  if (!grants.length) return 0;
  const holders = appsThatMayHold(apps, today).map((a) => a.appId);
  const linesBy = await linesForApps(holders);
  const balances = computeGrantBalances({
    grants: grants.map(grantRecord), applications: holdingApps(apps), lines: holdingLines([...linesBy.values()].flat()),
    excludeAppId: '', today, settings: settings.portal,
  });
  return balances.reduce((a, g) => a + g.exercisableOptions, 0);
}

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (at < items.length) {
      const i = at++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

type Outcome = SendResult | 'ineligible';

async function announcePage(emps: EmployeeDoc[], window: WindowDoc, settings: Settings, today: string): Promise<Outcome[]> {
  const addresses = await employeeNotifyEmails(emps);
  return pool(emps, CONCURRENCY, async (e): Promise<Outcome> => {
    try {
      // Never announce a window to somebody it is not open to (blocked, or not on the enabled list).
      if (accessBar(e, settings.portal)) return 'ineligible';
      const available = await exercisableOptions(e, settings, today);
      if (available <= 0) return 'ineligible';
      return await sendTemplateResult('window_open', addresses.get(e.employeeId) ?? '', {
        name: e.name, windowLabel: window.label, openDate: prettyDate(window.openDate), closeDate: prettyDate(window.closeDate),
        taxDueDate: prettyDate(window.taxDueDate), available, exercisePrice: settings.portal.exercisePrice,
        exercisePriceText: inr2(settings.portal.exercisePrice), appId: window.windowId,
      }, { appId: window.windowId, dedupeKey: dedupeKeys.windowOpen(window.windowId, e.employeeId) });
    } catch (err) {
      console.error('window_open for ' + e.employeeId + ' failed', err);
      return 'failed';
    }
  });
}

async function runOne(jobId: string, settings: Settings, today: string, deadlineMs: number): Promise<string> {
  const owner = Math.random().toString(36).slice(2);
  const job = await takeLease(jobId, owner);
  if (!job) return 'announcement ' + jobId + ': another run is working on it';
  const ref = jobRef(jobId);
  const window = await getWindow(job.windowId);
  if (!window || window.status === 'Closed' || today > window.closeDate) {
    await ref.update({ status: 'abandoned', leaseUntil: '', updatedAt: nowIso(), finishedAt: nowIso(), lastMessage: 'window no longer open' });
    return 'announcement ' + job.windowId + ': window no longer open, stopped at ' + (job.cursor || 'the start');
  }

  let { cursor, sent, skipped, failed, considered } = job;
  let pages = 0;
  let done = false;
  while (Date.now() < deadlineMs) {
    let q = db().collection(COL.employees).orderBy(FieldPath.documentId()).limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) { done = true; break; }
    const emps = snap.docs.map((d) => normalizeEmployee(d.data(), d.id));
    const outcomes = await announcePage(emps, window, settings, today);
    outcomes.forEach((o) => {
      if (o === 'ineligible') return;
      considered++;
      if (o === 'sent') sent++;
      else if (o === 'failed') failed++;
      else skipped++;
    });
    cursor = snap.docs[snap.docs.length - 1].id;
    pages++;
    await ref.update({
      cursor, sent, skipped, failed, considered, updatedAt: nowIso(),
      leaseUntil: nowIso(addMinutes(new Date(), LEASE_MINUTES)),
    });
    if (snap.size < PAGE) { done = true; break; }
  }
  const msg = sent + ' sent, ' + skipped + ' not sent (already sent, suppressed or no address), ' + failed + ' failed, of ' + considered + ' eligible';
  await ref.update({
    leaseUntil: '', updatedAt: nowIso(), lastMessage: msg,
    ...(done ? { status: 'done', finishedAt: nowIso() } : {}),
  });
  return 'announcement ' + job.windowId + ': ' + (done ? 'complete — ' : 'in progress after ' + pages + ' page(s), resumes next run — ') + msg;
}

/** Work on every announcement still running, until the deadline. */
export async function runWindowOpenCampaigns(settings: Settings, today: string, deadlineMs: number): Promise<string> {
  const snap = await db().collection(COL.jobs).where('status', '==', 'running').limit(5).get();
  const jobs = snap.docs.map((d) => d.data() as JobStateDoc).filter((j) => j.kind === 'window_open');
  if (!jobs.length) return 'announcement: nothing in progress';
  if (!bulkEmailsEnabled(settings)) return 'announcement: paused — BULK_EMAILS_ENABLED=false';
  const out: string[] = [];
  for (const j of jobs) {
    if (Date.now() >= deadlineMs) { out.push('announcement ' + j.windowId + ': no time left this run'); continue; }
    out.push(await runOne(j.jobId, settings, today, deadlineMs));
  }
  return out.join('\n');
}
