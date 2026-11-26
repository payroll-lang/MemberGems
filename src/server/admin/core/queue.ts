/**
 * The verification queue (AdminApi.queue) and the participants list
 * (AdminApi.employees) built from documents already read. Pure.
 */
import { PARTNER_STATUS, STATUS, isBlocked, num, stepFor, trim, type PortalSettings } from '@/domain';
import type { ApplicationDoc, EmployeeDoc, GrantDoc, PartnerRequestDoc, UserDoc } from '@/lib/schema';
import { progressOf } from '../../core/applications';
import { emailFor } from '../../core/employees';

export const QUEUE_STATUSES = [STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.SENT_BACK, STATUS.DRAFT, STATUS.APPROVED, STATUS.REJECTED] as const;

const RANK: Record<string, number> = {
  [STATUS.SUBMITTED]: 0, [STATUS.UNDER_REVIEW]: 1, [STATUS.SENT_BACK]: 2, [STATUS.DRAFT]: 3, [STATUS.APPROVED]: 4, [STATUS.REJECTED]: 5,
};

export interface QueueRow {
  appId: string;
  windowId: string;
  employeeId: string;
  employeeName: string;
  employmentStatus: string;
  status: string;
  pendingLabels: string[];
  totalOptions: number;
  totalShares: number;
  exerciseAmount: number;
  perquisiteAmount: number;
  taxAmount: number;
  taxMode: string;
  fundPartnerName: string;
  submittedAt: string;
  updatedAt: string;
  verifiedSections: number;
  sentBackSections: number;
  partnerStatus: string;
  /** The partner has done their part but the participant has not submitted. */
  awaitingParticipant: boolean;
  docsPresent: number;
}

export interface QueueFilters {
  windowId?: string;
  status?: string;
  search?: string;
}

export function queueRow(a: ApplicationDoc, emp: EmployeeDoc | undefined, pr: PartnerRequestDoc | undefined): QueueRow {
  const prog = progressOf(a, a.taxPaidAmount, pr ? pr.status : null);
  const reviews = Object.values(a.review);
  return {
    appId: a.appId, windowId: a.windowId, employeeId: a.employeeId, employeeName: emp?.name ?? '',
    employmentStatus: emp?.employmentStatus || 'Active', status: a.status, pendingLabels: prog.pendingLabels,
    totalOptions: a.totalOptions, totalShares: a.totalShares, exerciseAmount: a.exerciseAmount,
    perquisiteAmount: a.perquisiteAmount, taxAmount: a.taxAmount, taxMode: a.taxMode, fundPartnerName: a.fundPartnerName,
    submittedAt: a.submittedAt, updatedAt: a.updatedAt,
    verifiedSections: reviews.filter((v) => v === 'Verified').length,
    sentBackSections: reviews.filter((v) => v === 'Sent Back').length,
    partnerStatus: pr ? pr.status : '',
    awaitingParticipant: !!pr && pr.status === PARTNER_STATUS.PAID && (a.status === STATUS.DRAFT || a.status === STATUS.SENT_BACK),
    docsPresent: [a.cmlFileId, a.panFileId, a.exercisePayment.proofFileId, a.notice.fileId].filter(Boolean).length +
      (a.taxPaymentCount > 0 ? 1 : 0),
  };
}

/** Filter, then sort: by status rank (Submitted first), then most recently updated. */
export function filterQueue(rows: readonly QueueRow[], f: QueueFilters): QueueRow[] {
  const win = trim(f.windowId);
  const status = trim(f.status);
  const q = trim(f.search).toLowerCase();
  let out = rows.slice();
  if (win) out = out.filter((r) => r.windowId === win);
  if (status) out = out.filter((r) => r.status === status);
  if (q) {
    out = out.filter((r) => r.employeeId.toLowerCase().includes(q) || r.employeeName.toLowerCase().includes(q) ||
      r.appId.toLowerCase().includes(q));
  }
  const ms = (s: string) => { const t = Date.parse(s); return isNaN(t) ? 0 : t; };
  out.sort((a, b) => ((RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)) || ms(b.updatedAt) - ms(a.updatedAt));
  return out;
}

export function queueTotals(rows: readonly QueueRow[]) {
  return {
    options: rows.reduce((a, r) => a + r.totalOptions, 0),
    shares: rows.reduce((a, r) => a + r.totalShares, 0),
    exerciseAmount: rows.reduce((a, r) => a + r.exerciseAmount, 0),
    perquisite: rows.reduce((a, r) => a + r.perquisiteAmount, 0),
    tax: rows.reduce((a, r) => a + r.taxAmount, 0),
  };
}

export function statusCounts(apps: readonly Pick<ApplicationDoc, 'status'>[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(QUEUE_STATUSES.map((s) => [s, 0]));
  apps.forEach((a) => { counts[a.status] = (counts[a.status] || 0) + 1; });
  return counts;
}

/* ================= participants ================= */

export interface GrantTotals {
  grants: number;
  vested: number;
  unvested: number;
  exercisable: number;
  shares: number;
  plans: Record<string, number>;
}

/** Per participant: vested, and exercisable after the lot rule (AdminApi.employees totals). */
export function grantTotalsByEmployee(grants: readonly GrantDoc[], settings: PortalSettings): Map<string, GrantTotals> {
  const out = new Map<string, GrantTotals>();
  grants.forEach((g) => {
    const k = g.employeeId.toUpperCase();
    const t = out.get(k) ?? { grants: 0, vested: 0, unvested: 0, exercisable: 0, shares: 0, plans: {} };
    const mult = num(g.multiplier, 1) || 1;
    const step = stepFor(mult, settings);
    const ex = Math.floor((num(g.vestedOptions, 0) + 1e-9) / step) * step;
    t.grants++;
    t.vested += num(g.vestedOptions, 0);
    t.unvested += num(g.unvestedOptions, 0);
    t.exercisable += ex;
    t.shares += ex * mult;
    t.plans[g.planName] = mult;
    out.set(k, t);
  });
  return out;
}

export type ParticipantFilter = '' | 'exercisable' | 'noTaxRate' | 'noLogin' | 'blocked' | 'prefilled' | 'noDetails';
export const PARTICIPANT_FILTERS: { value: ParticipantFilter; label: string }[] = [
  { value: '', label: 'Everyone' },
  { value: 'exercisable', label: 'Something exercisable' },
  { value: 'noTaxRate', label: 'Exercisable, no tax basis' },
  { value: 'noLogin', label: 'Exercisable, no login' },
  { value: 'noDetails', label: 'Exercisable, no PAN or demat on file' },
  { value: 'prefilled', label: 'PAN or demat on file' },
  { value: 'blocked', label: 'Blocked' },
];

export interface ParticipantRow {
  employeeId: string;
  name: string;
  designation: string;
  email: string;
  pan: string;
  hasDemat: boolean;
  employmentStatus: string;
  separationDate: string;
  blocked: boolean;
  blockedReason: string;
  ctc: number | null;
  taxRatePercent: number | null;
  taxBasis: 'sheet' | 'flat' | 'none';
  grants: number;
  vested: number;
  exercisable: number;
  shares: number;
  plans: string;
  hasLogin: boolean;
  loginStatus: string;
  lastLoginAt: string;
  enabled: boolean;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function participantRows(input: {
  employees: readonly EmployeeDoc[];
  totals: ReadonlyMap<string, GrantTotals>;
  users: ReadonlyMap<string, Pick<UserDoc, 'status' | 'lastLoginAt'>>;
  /** Employees the loaded tax sheet can price. */
  sheetCovered: ReadonlySet<string>;
  enabledIds: readonly string[];
}): ParticipantRow[] {
  const enabled = new Set(input.enabledIds);
  return input.employees.map((e) => {
    const k = e.employeeId.toUpperCase();
    const t = input.totals.get(k) ?? { grants: 0, vested: 0, unvested: 0, exercisable: 0, shares: 0, plans: {} };
    const u = input.users.get(k);
    return {
      employeeId: e.employeeId, name: e.name, designation: e.designation, email: emailFor(e), pan: e.pan,
      hasDemat: !!(e.demat.dpId && e.demat.clientId), employmentStatus: e.employmentStatus || 'Active',
      separationDate: e.separationDate, blocked: isBlocked({ employeeId: k, blocked: e.blocked }), blockedReason: e.blockedReason,
      ctc: e.ctc, taxRatePercent: e.taxRatePercent,
      taxBasis: input.sheetCovered.has(k) ? 'sheet' : num(e.taxRatePercent, 0) ? 'flat' : 'none',
      grants: t.grants, vested: r6(t.vested), exercisable: r6(t.exercisable), shares: Math.round(t.shares),
      plans: Object.keys(t.plans).map((p) => p + ' ×' + t.plans[p]).join(', '),
      hasLogin: !!u, loginStatus: u?.status ?? '', lastLoginAt: u?.lastLoginAt ?? '',
      enabled: !enabled.size || enabled.has(k),
    };
  });
}

export function filterParticipants(rows: readonly ParticipantRow[], search: string, only: ParticipantFilter): ParticipantRow[] {
  const q = trim(search).toLowerCase();
  let out = rows.slice();
  if (q) out = out.filter((r) => r.employeeId.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q));
  if (only === 'exercisable') out = out.filter((r) => r.exercisable > 0);
  if (only === 'noTaxRate') out = out.filter((r) => r.exercisable > 0 && r.taxBasis === 'none');
  if (only === 'noLogin') out = out.filter((r) => r.exercisable > 0 && !r.hasLogin);
  if (only === 'blocked') out = out.filter((r) => r.blocked);
  if (only === 'prefilled') out = out.filter((r) => r.hasDemat || !!r.pan);
  if (only === 'noDetails') out = out.filter((r) => r.exercisable > 0 && !r.hasDemat && !r.pan);
  out.sort((a, b) => b.exercisable - a.exercisable || a.name.localeCompare(b.name));
  return out;
}

export function participantSummary(rows: readonly ParticipantRow[]) {
  return {
    participants: rows.length,
    withExercisable: rows.filter((r) => r.exercisable > 0).length,
    withoutTaxRate: rows.filter((r) => r.exercisable > 0 && r.taxBasis === 'none').length,
    onTaxSheet: rows.filter((r) => r.taxBasis === 'sheet').length,
    withoutLogin: rows.filter((r) => r.exercisable > 0 && !r.hasLogin).length,
    withoutEmail: rows.filter((r) => r.exercisable > 0 && !r.email).length,
    blocked: rows.filter((r) => r.blocked).length,
    withDemat: rows.filter((r) => r.hasDemat).length,
    withPan: rows.filter((r) => !!r.pan).length,
  };
}
