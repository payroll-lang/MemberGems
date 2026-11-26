import 'server-only';
import { isEnabled, type FmvPoint, type GrantBalance, type WindowState } from '@/domain';
import type { WindowDoc } from '@/lib/schema';
import { todayIst } from '@/lib/time';
import { getApplication, linesOf, taxPaymentsOf } from '../applications';
import { buildNoticeModel, noticeHtml } from '../core/notice';
import { buildAppView, fileIdsOf, type AppView } from '../core/view';
import { emailFor } from '../employees';
import { fileMetas } from '../files';
import { latestPrice } from '../fmv';
import { partnerRequestsForApp } from '../partnerRequests';
import { balances, loadState, taxContext } from '../participant/state';
import { loadSettings } from '../settings';
import { getWindow, stateOf } from '../windows';
import { filterQueue, grantTotalsByEmployee, queueRow, queueTotals, statusCounts, QUEUE_STATUSES, type QueueFilters, type QueueRow } from './core/queue';
import {
  allApplications, allEmployees, allPartnerRequests, auditForApp, employeesById, grantFigures, latestRequestByApp, listWindows,
  taxSheetState, type AuditRow,
} from './data';

/* ================= the queue ================= */

export interface QueueView {
  rows: QueueRow[];
  windows: { windowId: string; label: string; status: string }[];
  counts: Record<string, number>;
  statuses: readonly string[];
  currentWindow: { windowId: string; label: string; openDate: string; closeDate: string; taxDueDate: string; status: string; state: WindowState };
  latestFmv: FmvPoint | null;
  health: {
    grantRows: number;
    reportAsOn: string;
    lastSyncedAt: string;
    participantsWithoutTaxRate: number;
    lotSize: number;
    lotScope: string;
    emailsOff: boolean;
    bulkEmailsOff: boolean;
    enabledCount: number;
  };
  totals: ReturnType<typeof queueTotals>;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  return s ? s === 'true' || s === 'yes' || s === '1' : dflt;
}

export function emailSwitches(config: Record<string, string>): { emails: boolean; bulk: boolean; inviteAuto: boolean } {
  return {
    emails: bool(config.EMAILS_ENABLED, true),
    bulk: bool(config.BULK_EMAILS_ENABLED, false),
    inviteAuto: String(config.INVITE_EMAILS ?? '').trim().toLowerCase() === 'auto',
  };
}

/** AdminApi.queue */
export async function loadQueue(filters: QueueFilters): Promise<QueueView> {
  const settings = await loadSettings();
  const today = todayIst();
  const [apps, prs, windows, latest, current, grants, employees, sheet] = await Promise.all([
    allApplications(), allPartnerRequests(), listWindows(), latestPrice(), getWindow(today.slice(0, 7)),
    grantFigures(), allEmployees(), taxSheetState(),
  ]);
  const empById = new Map(employees.map((e) => [e.employeeId, e]));
  const prByApp = latestRequestByApp(prs);
  const rows = filterQueue(apps.map((a) => queueRow(a, empById.get(a.employeeId), prByApp.get(a.appId))), filters);

  const totals = grantTotalsByEmployee(grants, settings.portal);
  const noRate = employees.filter((e) => !e.taxRatePercent && !sheet.covered.has(e.employeeId) && (totals.get(e.employeeId)?.vested ?? 0) > 0).length;
  const sw = emailSwitches(settings.config);
  const w: WindowDoc | null = current;
  return {
    rows,
    windows: windows.map((x) => ({ windowId: x.windowId, label: x.label || x.windowId, status: x.status })),
    counts: statusCounts(apps),
    statuses: QUEUE_STATUSES,
    currentWindow: {
      windowId: today.slice(0, 7), label: w?.label ?? today.slice(0, 7), openDate: w?.openDate ?? '', closeDate: w?.closeDate ?? '',
      taxDueDate: w?.taxDueDate ?? '', status: w?.status ?? 'missing', state: stateOf(w, today),
    },
    latestFmv: latest,
    health: {
      grantRows: grants.length,
      reportAsOn: grants[0]?.reportAsOn ?? '',
      lastSyncedAt: grants[0]?.lastSyncedAt ?? '',
      participantsWithoutTaxRate: noRate,
      lotSize: settings.portal.optionLotSize,
      lotScope: settings.portal.lotScope,
      emailsOff: !sw.emails,
      bulkEmailsOff: !sw.bulk,
      enabledCount: settings.portal.eligibleEmployeeIds.length,
    },
    totals: queueTotals(rows),
  };
}

/* ================= one application ================= */

export interface AdminDetail {
  view: AppView;
  noticeHtml: string;
  grants: GrantBalance[];
  trail: AuditRow[];
  partnerRequests: { requestId: string; partner: string; status: string; assignedAt: string; taxAmount: number; remarks: string }[];
  employee: {
    employeeId: string; name: string; email: string; designation: string; employmentStatus: string; separationDate: string;
    blocked: boolean; blockedReason: string; enabled: boolean; taxRatePercent: number | null; pan: string;
  } | null;
  /** The employee record is missing: the view is built without it. */
  missingEmployee: boolean;
  latestFmv: FmvPoint | null;
  windowState: WindowState;
}

/** AdminApi.detail without the side effect (openForReview does that, audited). */
export async function loadAdminDetail(appId: string): Promise<AdminDetail | null> {
  const app = await getApplication(appId);
  if (!app) return null;
  const settings = await loadSettings();
  const today = todayIst();
  const [lines, payments, prs, latest, win, trail] = await Promise.all([
    linesOf(app.appId), taxPaymentsOf(app.appId), partnerRequestsForApp(app.appId), latestPrice(), getWindow(app.windowId),
    auditForApp(app.appId),
  ]);
  const pr = prs.length ? prs[prs.length - 1] : null;
  const files = await fileMetas(fileIdsOf(app, payments, pr));
  let st: Awaited<ReturnType<typeof loadState>> | null = null;
  try {
    st = await loadState(app.employeeId, settings, today);
  } catch {
    st = null;
  }
  const view = buildAppView({
    app, lines, payments, partnerRequest: pr, employee: st?.employee ?? null, grants: st?.grants ?? [],
    window: win ? { label: win.label, closeDate: win.closeDate } : null,
    files, latest: latest ? { fmv: latest.fmv, date: latest.date } : null,
    taxContext: st ? taxContext(st, app.appId) : undefined, flatRounding: settings.portal.flatTaxRounding,
  });
  const html = st && lines.length ? noticeHtml(buildNoticeModel({
    app, employee: st.employee, email: emailFor(st.employee), lines, grants: st.grants,
    windowLabel: view.windowLabel, settings, today,
  })) : '';
  const e = st?.employee;
  return {
    view,
    noticeHtml: html,
    grants: st ? balances(st, app.appId) : [],
    trail,
    partnerRequests: prs.map((r) => ({ requestId: r.requestId, partner: r.fundPartnerName, status: r.status, assignedAt: r.assignedAt, taxAmount: r.taxAmount, remarks: r.remarks })),
    employee: e ? {
      employeeId: e.employeeId, name: e.name, email: emailFor(e), designation: e.designation, employmentStatus: e.employmentStatus || 'Active',
      separationDate: e.separationDate, blocked: e.blocked, blockedReason: e.blockedReason, enabled: isEnabled(e, settings.portal),
      taxRatePercent: e.taxRatePercent, pan: e.pan,
    } : null,
    missingEmployee: !e,
    latestFmv: latest,
    windowState: stateOf(win, today),
  };
}

export { employeesById };
