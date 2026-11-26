import 'server-only';
import {
  balanceTotals, indicativeGain, lotSize, paymentReference, prettyDate,
  type BalanceTotals, type FmvPoint, type GrantBalance, type LotScope,
} from '@/domain';
import type { ApplicationDoc, EmployeeDoc } from '@/lib/schema';
import { todayIst } from '@/lib/time';
import { getApplication, linesOf, taxPaymentsOf } from '../applications';
import { UserError } from '../core/errors';
import { buildNoticeModel, noticeHtml } from '../core/notice';
import { buildAppView, fileIdsOf, type AppView } from '../core/view';
import { emailFor } from '../employees';
import { fileMetas } from '../files';
import { latestPrice } from '../fmv';
import { activePartners, partnerLogins } from '../partners';
import { partnerRequestOf } from '../partnerRequests';
import { loadSettings, type Settings } from '../settings';
import { ensureWindow, getWindow } from '../windows';
import { balances, barOf, currentApp, liveApp, loadState, taxContext, windowViewOf, type ParticipantState } from './state';

export interface EmployeeSummary {
  employeeId: string;
  name: string;
  designation: string;
  email: string;
  mobile: string;
  address: string;
  nationality: string;
  pan: string;
  employmentStatus: string;
  prettySeparationDate: string;
  taxRatePercent: number;
}

export interface HistoryRow {
  appId: string;
  windowId: string;
  status: string;
  totalOptions: number;
  totalShares: number;
  exerciseAmount: number;
  taxAmount: number;
  submittedAt: string;
  updatedAt: string;
}

export interface Dashboard {
  today: string;
  blocked: boolean;
  blockedReason: string;
  employee: EmployeeSummary;
  window: { windowId: string; label: string; openDate: string; closeDate: string; taxDueDate: string; isOpen: boolean; reason: string };
  grants: GrantBalance[];
  totals: BalanceTotals;
  indicativeGain: number;
  latestFmv: FmvPoint | null;
  lotSize: number;
  lotScope: LotScope;
  exercisePrice: number;
  fundPartners: { partnerId: string; name: string }[];
  paymentReference: string;
  bankDetails: { exercise: string; tax: string };
  supportEmail: string;
  /** The application in play this window, else the latest one in it. */
  application: AppView | null;
  /** True when `application` is the one in play (Draft / Submitted / Under Review / Sent Back). */
  applicationIsLive: boolean;
  applicationsThisWindow: number;
  canStartAnother: boolean;
  history: HistoryRow[];
}

function summary(e: EmployeeDoc): EmployeeSummary {
  return {
    employeeId: e.employeeId, name: e.name, designation: e.designation, email: emailFor(e), mobile: e.mobile,
    address: e.address, nationality: e.nationality || 'Indian', pan: e.pan,
    employmentStatus: e.employmentStatus || 'Active', prettySeparationDate: prettyDate(e.separationDate),
    taxRatePercent: e.taxRatePercent ?? 0,
  };
}

/** One application as the participant's screens show it. */
export async function appViewFor(st: ParticipantState, app: ApplicationDoc, latest: FmvPoint | null): Promise<AppView> {
  const [lines, payments, pr, win] = await Promise.all([
    linesOf(app.appId), taxPaymentsOf(app.appId), partnerRequestOf(app.appId),
    app.windowId === st.windowId ? Promise.resolve(st.window) : getWindow(app.windowId),
  ]);
  const files = await fileMetas(fileIdsOf(app, payments, pr));
  return buildAppView({
    app, lines, payments, partnerRequest: pr, employee: st.employee, grants: st.grants,
    window: win ? { label: win.label, closeDate: win.closeDate } : null,
    files, latest: latest ? { fmv: latest.fmv, date: latest.date } : null,
    taxContext: taxContext(st, app.appId), flatRounding: st.settings.portal.flatTaxRounding,
  });
}

/** Make sure this month's window exists, then read the participant. */
export async function participantState(employeeId: string, settings?: Settings): Promise<ParticipantState> {
  const s = settings ?? (await loadSettings());
  const today = todayIst();
  await ensureWindow(today, s.portal, employeeId);
  return loadState(employeeId, s, today);
}

/** Partners a participant may choose: active, with at least one active login. */
export async function selectablePartners(): Promise<{ partnerId: string; name: string }[]> {
  const list = await activePartners();
  const withLogins = await Promise.all(list.map(async (p) => ((await partnerLogins(p.partnerId)).length ? p : null)));
  return withLogins.filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ partnerId: p.partnerId, name: p.name }));
}

/** EmployeeApi.dashboard */
export async function loadDashboard(employeeId: string): Promise<Dashboard> {
  const settings = await loadSettings();
  const st = await participantState(employeeId, settings);
  const [latest, partners] = await Promise.all([latestPrice(), selectablePartners()]);
  const live = liveApp(st);
  const current = currentApp(st);
  const grants = balances(st, live ? live.appId : '');
  const totals = balanceTotals(grants);
  const bar = barOf(st);
  const win = windowViewOf(st);
  const w = st.window;
  const e = st.employee;

  return {
    today: st.today,
    blocked: !!bar,
    blockedReason: bar,
    employee: summary(e),
    window: {
      windowId: st.windowId, label: w?.label ?? st.windowId, openDate: w?.openDate ?? '', closeDate: w?.closeDate ?? '',
      taxDueDate: w?.taxDueDate ?? '', isOpen: win.open, reason: win.reason,
    },
    grants,
    totals,
    indicativeGain: latest ? indicativeGain(grants, latest.fmv) : 0,
    latestFmv: latest,
    lotSize: lotSize(settings.portal),
    lotScope: settings.portal.lotScope,
    exercisePrice: settings.portal.exercisePrice,
    fundPartners: partners,
    paymentReference: paymentReference(settings.portal, e),
    bankDetails: { exercise: settings.text.COMPANY_BANK_DETAILS, tax: settings.text.TAX_BANK_DETAILS },
    supportEmail: settings.text.SUPPORT_EMAIL,
    application: current ? await appViewFor(st, current, latest) : null,
    applicationIsLive: !!live,
    applicationsThisWindow: st.apps.filter((a) => a.windowId === st.windowId).length,
    canStartAnother: win.open && !bar && !live && totals.exercisable > 0,
    history: st.apps.map((a) => ({
      appId: a.appId, windowId: a.windowId, status: a.status, totalOptions: a.totalOptions, totalShares: a.totalShares,
      exerciseAmount: a.exerciseAmount, taxAmount: a.taxAmount, submittedAt: a.submittedAt, updatedAt: a.updatedAt,
    })),
  };
}

export interface ApplicationDetail {
  view: AppView;
  noticeHtml: string;
}

/**
 * EmployeeApi.applicationById: one of the participant's own applications, in
 * full, with the notice as it stands. The ownership check is the security of
 * it — references are guessable.
 */
export async function loadOwnApplication(employeeId: string, appId: string): Promise<ApplicationDetail> {
  const app = await getApplication(appId);
  if (!app || app.employeeId !== employeeId.trim().toUpperCase()) throw new UserError('That application is not on your record.');
  const settings = await loadSettings();
  const st = await loadState(employeeId, settings, todayIst());
  const latest = await latestPrice();
  const view = await appViewFor(st, app, latest);
  const lines = await linesOf(app.appId);
  const html = lines.length ? noticeHtml(buildNoticeModel({
    app, employee: st.employee, email: emailFor(st.employee), lines, grants: st.grants,
    windowLabel: view.windowLabel, settings, today: st.today,
  })) : '';
  return { view, noticeHtml: html };
}

/** EmployeeApi.getNotice for the application in play this window. */
export async function loadCurrentNotice(employeeId: string): Promise<{ html: string; expectedName: string; app: ApplicationDoc } | null> {
  const settings = await loadSettings();
  const st = await loadState(employeeId, settings, todayIst());
  const app = liveApp(st) ?? currentApp(st);
  if (!app) return null;
  const lines = await linesOf(app.appId);
  if (!lines.length) return null;
  const html = noticeHtml(buildNoticeModel({
    app, employee: st.employee, email: emailFor(st.employee), lines, grants: st.grants,
    windowLabel: st.window?.label ?? app.windowId, settings, today: st.today,
  }));
  return { html, expectedName: st.employee.name, app };
}
