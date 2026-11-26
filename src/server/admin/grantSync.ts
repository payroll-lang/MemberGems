import 'server-only';
import { num, trim } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { COL, type EmployeeDoc, type UserDoc } from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { UserError, type ActionResult } from '../core/errors';
import { emailFor } from '../employees';
import { loadSettings } from '../settings';
import {
  loginEmailSync, nothingToWriteMessage, planEmployeeUpserts, ReportError, rollupGrantReport, type GrantReportResult, type GrantReportSummary,
} from './core/grantReport';
import { allEmployees, allUsers } from './data';
import { checkImportPath, readImportGrid } from './imports';
import { runAdmin } from './run';

/**
 * The grant report sync (GrantSync.run): read the uploaded "Vest wise
 * Report", roll it up, preview it (dry run), then replace the grants and
 * upsert the participants. Sign-in addresses of participant logins follow
 * the record.
 */

export interface GrantSyncPreview {
  summary: GrantReportSummary;
  sheet: string;
  effect: {
    grantsNow: number;
    grantsRemoved: number;
    employeesCreated: number;
    employeesUpdated: number;
    employeesMissingTaxRate: number;
    employeesMissingEmail: number;
    loginsToUpdate: number;
  };
  path: string;
}

async function rollup(path: string): Promise<{ r: GrantReportResult; sheet: string }> {
  const settings = await loadSettings();
  const { grid, sheet } = await readImportGrid(path, 'Vest wise Report');
  const headerRow = num(settings.config.REPORT_HEADER_ROW, 4) || 4;
  try {
    return { r: rollupGrantReport(grid, { settings: settings.portal, today: todayIst(), syncedAt: nowIso(), headerRow }), sheet };
  } catch (e) {
    if (e instanceof ReportError) throw new UserError(e.message);
    throw e;
  }
}

async function plan(r: GrantReportResult, now: string) {
  const [employees, users, grantIds] = await Promise.all([
    allEmployees(), allUsers(), db().collection(COL.grants).select().get(),
  ]);
  const existing = new Map(employees.map((e) => [e.employeeId, e]));
  const upserts = planEmployeeUpserts(existing, r.employees, now);
  const keep = new Set(r.grants.map((g) => g.grantId));
  const stale = grantIds.docs.filter((d) => !keep.has(d.id)).map((d) => d.ref);
  // What every participant record will hold after the sync, for the logins.
  const after = new Map<string, Pick<EmployeeDoc, 'employeeId' | 'emailOverride' | 'accessEmail' | 'secondaryEmail'>>(existing);
  upserts.creates.forEach((e) => after.set(e.employeeId, e));
  upserts.updates.forEach((u) => { const e = after.get(u.employeeId); if (e) after.set(u.employeeId, { ...e, ...(u.patch as Partial<EmployeeDoc>) }); });
  const logins: { userId: string; patch: { loginEmails: string[]; notifyEmail: string } }[] = [];
  users.filter((u) => u.role === 'Employee').forEach((u) => {
    const e = after.get(u.userId.toUpperCase());
    const p = e ? loginEmailSync(u, e) : null;
    if (p) logins.push({ userId: u.userId, patch: p });
  });
  return { upserts, stale, logins, grantsNow: grantIds.size };
}

export function previewGrantSync(user: UserDoc, path: string): Promise<ActionResult> {
  return runAdmin(user, 'previewGrantSync', async () => {
    const p = checkImportPath('grantReport', path);
    const { r, sheet } = await rollup(p);
    const pl = await plan(r, nowIso());
    const preview: GrantSyncPreview = {
      summary: r.summary, sheet, path: p,
      effect: {
        grantsNow: pl.grantsNow, grantsRemoved: pl.stale.length, employeesCreated: pl.upserts.created, employeesUpdated: pl.upserts.updated,
        employeesMissingTaxRate: pl.upserts.missingRate, employeesMissingEmail: pl.upserts.missingEmail, loginsToUpdate: pl.logins.length,
      },
    };
    return {
      message: 'Checked — nothing has been written yet. ' + r.summary.grantRows + ' grants for ' + r.summary.employees +
        ' participants (report as on ' + r.summary.reportAsOn + ').',
      data: preview,
    };
  });
}

export function runGrantSync(user: UserDoc, path: string): Promise<ActionResult> {
  return runAdmin(user, 'runGrantSync', async () => {
    const p = checkImportPath('grantReport', path);
    const settings = await loadSettings();
    const { r } = await rollup(p);
    if (!r.grants.length) throw new UserError(nothingToWriteMessage(r.summary, settings.portal));
    const now = nowIso();
    const pl = await plan(r, now);

    // New grants are written before stale ones are removed, so a participant
    // never sees an empty balance part-way through.
    const fs = db();
    const w = fs.bulkWriter();
    w.onWriteError((err) => err.failedAttempts < 5);
    let failed = 0;
    const track = (t: Promise<unknown>) => { t.catch(() => { failed++; }); };
    r.grants.forEach((g) => track(w.set(fs.collection(COL.grants).doc(g.grantId), g)));
    pl.upserts.creates.forEach((e) => track(w.create(fs.collection(COL.employees).doc(e.employeeId), e)));
    pl.upserts.updates.forEach((u) => track(w.update(fs.collection(COL.employees).doc(u.employeeId), u.patch)));
    pl.logins.forEach((l) => track(w.update(fs.collection(COL.users).doc(l.userId), l.patch)));
    await w.flush();
    if (failed) {
      await w.close();
      throw new UserError(failed + ' write(s) failed, so the old grants were kept alongside the new ones. Run the sync again.');
    }
    pl.stale.forEach((ref) => track(w.delete(ref)));
    await w.close();

    const s = r.summary;
    await audit(user.userId, 'Admin', 'GRANTS_SYNCED',
      s.grantRows + ' grants, ' + s.employees + ' employees, report as on ' + s.reportAsOn + ', ' + s.warnings.length + ' warning(s); ' +
      pl.stale.length + ' grants removed, ' + pl.upserts.created + ' participants created, ' + pl.upserts.updated + ' updated, ' +
      pl.logins.length + ' login address(es) updated; file ' + p + (failed ? '; ' + failed + ' deletes failed' : ''));
    return {
      message: s.grantRows + ' grants synced for ' + s.employees + ' participants (report as on ' + s.reportAsOn + '). ' +
        pl.upserts.created + ' participant(s) created, ' + pl.upserts.updated + ' updated, ' + pl.stale.length + ' old grant(s) removed.' +
        (pl.upserts.missingRate ? ' ' + pl.upserts.missingRate + ' participant(s) have no tax rate yet.' : '') +
        (failed ? ' ' + failed + ' old grant(s) could not be removed — run the sync again.' : ''),
      data: { summary: s },
    };
  });
}

/** For the sync screen: what is loaded now. */
export async function grantSyncStatus(): Promise<{ grants: number; reportAsOn: string; lastSyncedAt: string; participants: number; withoutEmail: number }> {
  const [one, count, employees] = await Promise.all([
    db().collection(COL.grants).limit(1).get(), db().collection(COL.grants).count().get(), allEmployees(),
  ]);
  const g = one.docs[0]?.data();
  return {
    grants: count.data().count, reportAsOn: trim(g?.reportAsOn), lastSyncedAt: trim(g?.lastSyncedAt),
    participants: employees.length, withoutEmail: employees.filter((e) => !emailFor(e)).length,
  };
}
