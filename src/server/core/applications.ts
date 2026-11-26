/**
 * Pure helpers around an application document (AppStore.gs): reading a doc
 * tolerantly, the application reference, progress, and the blank draft.
 */
import {
  PARTNER_STATUS, STATUS, isLiveStatus, num, progress, round2, trim, windowKey,
  type HoldingApplication, type HoldingLine, type Numeric, type PriorApplication, type Progress,
} from '@/domain';
import type {
  ApplicationDoc, ApplicationLineDoc, DematDetails, EmployeeDoc, PartnerRequestDoc, ReviewState, SectionKey,
  TaxPaymentDoc, WindowDoc,
} from '@/lib/schema';

export const SECTION_KEYS: SectionKey[] = ['options', 'demat', 'exercisePayment', 'taxPayment', 'notice'];

/** Wizard stage → the review section it belongs to. */
export const REVIEW_OF_STAGE: Record<string, SectionKey | undefined> = {
  options: 'options', demat: 'demat', exercise: 'exercisePayment', tax: 'taxPayment', notice: 'notice',
};

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const s = (v: unknown): string => trim(v);
const n = (v: unknown): number => num(v as Numeric, 0);

export function emptyDemat(): DematDetails {
  return { dpName: '', dpId: '', clientId: '', accountName: '', accountType: '' };
}

export function dematFrom(v: unknown): DematDetails {
  const d = o(v);
  const t = s(d.accountType).toUpperCase();
  return {
    dpName: s(d.dpName), dpId: s(d.dpId), clientId: s(d.clientId), accountName: s(d.accountName),
    accountType: t === 'NSDL' || t === 'CDSL' ? t : '',
  };
}

function reviewState(v: unknown): ReviewState {
  const x = s(v);
  return x === 'Verified' || x === 'Sent Back' ? x : 'Pending';
}

/** A Firestore application document with every field present. */
export function normalizeApplication(raw: unknown, id?: string): ApplicationDoc {
  const a = o(raw);
  const ap = o(a.applicant);
  const ex = o(a.exercisePayment);
  const nt = o(a.notice);
  const rv = o(a.review);
  const taxMode = s(a.taxMode);
  const taxMethod = s(a.taxMethod);
  return {
    appId: s(a.appId) || s(id),
    windowId: windowKey(a.windowId),
    employeeId: s(a.employeeId).toUpperCase(),
    status: (s(a.status) || STATUS.DRAFT) as ApplicationDoc['status'],
    totalOptions: n(a.totalOptions),
    totalShares: n(a.totalShares),
    exercisePrice: n(a.exercisePrice),
    exerciseAmount: n(a.exerciseAmount),
    fmvDate: s(a.fmvDate),
    fmvValue: n(a.fmvValue),
    perquisiteAmount: n(a.perquisiteAmount),
    taxRatePercent: n(a.taxRatePercent),
    taxAmount: n(a.taxAmount),
    taxMethod: (taxMethod === 'Sheet' || taxMethod === 'Flat' || taxMethod === 'None' ? taxMethod : '') as ApplicationDoc['taxMethod'],
    taxBreakdown: typeof a.taxBreakdown === 'string' ? safeJson(a.taxBreakdown) : (a.taxBreakdown ?? null),
    taxFrozenAt: s(a.taxFrozenAt),
    applicant: {
      address: s(ap.address), nationality: s(ap.nationality), mobile: s(ap.mobile),
      designation: s(ap.designation), pan: s(ap.pan).toUpperCase(),
    },
    demat: dematFrom(a.demat),
    dematSource: s(a.dematSource),
    cmlFileId: s(a.cmlFileId),
    panFileId: s(a.panFileId),
    exercisePayment: {
      utr: s(ex.utr), date: s(ex.date), amount: n(ex.amount), bank: s(ex.bank), proofFileId: s(ex.proofFileId),
    },
    taxMode: (taxMode === 'Self' || taxMode === 'FundPartner' ? taxMode : '') as ApplicationDoc['taxMode'],
    fundPartnerId: s(a.fundPartnerId),
    fundPartnerName: s(a.fundPartnerName),
    taxDueDate: s(a.taxDueDate),
    taxPaidAmount: n(a.taxPaidAmount),
    taxPaymentCount: n(a.taxPaymentCount),
    notice: { signatureName: s(nt.signatureName), signedAt: s(nt.signedAt), place: s(nt.place), fileId: s(nt.fileId) },
    review: {
      options: reviewState(rv.options), demat: reviewState(rv.demat), exercisePayment: reviewState(rv.exercisePayment),
      taxPayment: reviewState(rv.taxPayment), notice: reviewState(rv.notice),
    },
    adminRemarks: Array.isArray(a.adminRemarks)
      ? (a.adminRemarks as unknown[]).map((r) => {
        const x = o(r);
        const sec = s(x.section) as SectionKey;
        return { at: s(x.at), by: s(x.by), text: s(x.text), ...(SECTION_KEYS.includes(sec) ? { section: sec } : {}) };
      })
      : [],
    reviewedBy: s(a.reviewedBy),
    reviewedAt: s(a.reviewedAt),
    approvedAt: s(a.approvedAt),
    submittedAt: s(a.submittedAt),
    createdAt: s(a.createdAt),
    updatedAt: s(a.updatedAt),
    rev: n(a.rev),
  };
}

function safeJson(v: string): unknown {
  if (!v.trim()) return null;
  try { return JSON.parse(v); } catch { return null; }
}

export function normalizeLine(raw: unknown, id?: string): ApplicationLineDoc {
  const l = o(raw);
  return {
    lineId: s(l.lineId) || s(id),
    appId: s(l.appId),
    grantId: s(l.grantId),
    planName: s(l.planName),
    multiplier: num(l.multiplier as Numeric, 1) || 1,
    optionsExercised: n(l.optionsExercised),
    sharesAllotted: n(l.sharesAllotted),
    exercisePrice: n(l.exercisePrice),
    lineExerciseAmount: n(l.lineExerciseAmount),
    perquisitePerShare: n(l.perquisitePerShare),
    linePerquisite: n(l.linePerquisite),
    updatedAt: s(l.updatedAt),
  };
}

export function normalizeTaxPayment(raw: unknown, id?: string): TaxPaymentDoc {
  const t = o(raw);
  return {
    paymentId: s(t.paymentId) || s(id),
    appId: s(t.appId),
    employeeId: s(t.employeeId),
    seq: n(t.seq),
    paidBy: s(t.paidBy) === 'FundPartner' ? 'FundPartner' : 'Self',
    fundPartnerName: s(t.fundPartnerName),
    utr: s(t.utr),
    paymentDate: s(t.paymentDate),
    amount: n(t.amount),
    bank: s(t.bank),
    proofFileId: s(t.proofFileId),
    enteredBy: s(t.enteredBy),
    enteredAt: s(t.enteredAt),
    remarks: s(t.remarks),
  };
}

export function sortTaxPayments(rows: TaxPaymentDoc[]): TaxPaymentDoc[] {
  return [...rows].sort((a, b) => a.seq - b.seq);
}

export function taxPaidTotal(rows: readonly TaxPaymentDoc[]): number {
  return round2(rows.reduce((acc, r) => acc + num(r.amount, 0), 0));
}

/** AppStore.nextTaxSeq */
export function nextTaxSeq(rows: readonly TaxPaymentDoc[]): number {
  const sorted = sortTaxPayments([...rows]);
  return sorted.length ? num(sorted[sorted.length - 1].seq, sorted.length) + 1 : 1;
}

/** The application reference: APP-YYYYMM-EMPID, with -n from the second in a window. */
export function applicationIdFor(windowId: string, employeeId: string, seq: number): string {
  const base = 'APP-' + windowKey(windowId).replace('-', '') + '-' + trim(employeeId).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return seq > 1 ? base + '-' + seq : base;
}

function createdMs(a: ApplicationDoc): number {
  const t = Date.parse(a.createdAt);
  return isNaN(t) ? 0 : t;
}

/** AppStore.allInWindow: this participant's applications in a window, oldest first. */
export function allInWindow(apps: readonly ApplicationDoc[], employeeId: string, windowId: string): ApplicationDoc[] {
  const emp = trim(employeeId).toUpperCase();
  const win = windowKey(windowId);
  return apps.filter((a) => a.employeeId.toUpperCase() === emp && windowKey(a.windowId) === win)
    .sort((a, b) => createdMs(a) - createdMs(b) || a.appId.localeCompare(b.appId));
}

/** AppStore.activeInWindow: the one still in play, if any. */
export function activeInWindow(apps: readonly ApplicationDoc[], employeeId: string, windowId: string): ApplicationDoc | null {
  return allInWindow(apps, employeeId, windowId).filter((a) => isLiveStatus(a.status))[0] ?? null;
}

/** AppStore.forWindow(create=false): the one in play, else the most recent in the window. */
export function currentInWindow(apps: readonly ApplicationDoc[], employeeId: string, windowId: string): ApplicationDoc | null {
  const mine = allInWindow(apps, employeeId, windowId);
  return mine.filter((a) => isLiveStatus(a.status))[0] ?? (mine.length ? mine[mine.length - 1] : null);
}

/** The reference the next application in this window gets. */
export function nextApplicationId(apps: readonly ApplicationDoc[], employeeId: string, windowId: string): string {
  const mine = allInWindow(apps, employeeId, windowId);
  const taken = new Set(apps.map((a) => a.appId));
  let seq = mine.length + 1;
  let id = applicationIdFor(windowId, employeeId, seq);
  // A gap or an imported oddity must never make us reuse a reference.
  while (taken.has(id)) id = applicationIdFor(windowId, employeeId, ++seq);
  return id;
}

/** AppStore.forWindow's new row, pre-filled from the employee master. */
export function newApplicationDoc(input: {
  appId: string; windowId: string; employee: EmployeeDoc; exercisePrice: number;
  window: Pick<WindowDoc, 'taxDueDate'> | null; now: string;
}): ApplicationDoc {
  const e = input.employee;
  const demat = dematFrom(e.demat);
  return {
    appId: input.appId,
    windowId: windowKey(input.windowId),
    employeeId: trim(e.employeeId).toUpperCase(),
    status: 'Draft',
    totalOptions: 0, totalShares: 0,
    exercisePrice: input.exercisePrice,
    exerciseAmount: 0,
    fmvDate: '', fmvValue: 0, perquisiteAmount: 0,
    taxRatePercent: num(e.taxRatePercent, 0),
    taxAmount: 0, taxMethod: '', taxBreakdown: null, taxFrozenAt: '',
    applicant: {
      address: trim(e.address), nationality: trim(e.nationality) || 'Indian', mobile: trim(e.mobile),
      designation: trim(e.designation), pan: trim(e.pan).toUpperCase(),
    },
    demat: { ...demat, accountName: demat.accountName || trim(e.name) },
    dematSource: '', cmlFileId: '', panFileId: '',
    exercisePayment: { utr: '', date: '', amount: 0, bank: '', proofFileId: '' },
    taxMode: '', fundPartnerId: '', fundPartnerName: '',
    taxDueDate: input.window ? trim(input.window.taxDueDate) : '',
    taxPaidAmount: 0, taxPaymentCount: 0,
    notice: { signatureName: '', signedAt: '', place: '', fileId: '' },
    review: { options: 'Pending', demat: 'Pending', exercisePayment: 'Pending', taxPayment: 'Pending', notice: 'Pending' },
    adminRemarks: [],
    reviewedBy: '', reviewedAt: '', approvedAt: '', submittedAt: '',
    createdAt: input.now, updatedAt: input.now,
    rev: 0,
  };
}

/** AppStore.progress for a Firestore application. */
export function progressOf(a: ApplicationDoc, paidTotal: number, partnerRequestStatus: string | null): Progress {
  return progress({
    status: a.status,
    totalOptions: a.totalOptions,
    dematDPId: a.demat.dpId,
    dematClientId: a.demat.clientId,
    cmlFileId: a.cmlFileId,
    panFileId: a.panFileId,
    panNumber: a.applicant.pan,
    applicantAddress: a.applicant.address,
    applicantNationality: a.applicant.nationality,
    applicantMobile: a.applicant.mobile,
    exercisePaymentUTR: a.exercisePayment.utr,
    exercisePaymentDate: a.exercisePayment.date,
    exerciseProofFileId: a.exercisePayment.proofFileId,
    fmvValue: a.fmvValue,
    noticeSignedAt: a.notice.signedAt,
    taxMode: a.taxMode,
    taxAmount: a.taxAmount,
    taxMethod: a.taxMethod,
    taxPaidTotal: paidTotal,
    partnerRequestStatus,
  });
}

/** AppStore.effectiveRate: the tax as a percentage of the perquisite. */
export function effectiveRate(a: Pick<ApplicationDoc, 'taxMethod' | 'perquisiteAmount' | 'taxAmount' | 'taxRatePercent'>): number {
  if (a.taxMethod === 'Sheet' && a.perquisiteAmount > 0) return Math.round(a.taxAmount / a.perquisiteAmount * 10000) / 100;
  return a.taxRatePercent;
}

/** The latest partner request of an application (legacy: last row). */
export function latestPartnerRequest(rows: readonly PartnerRequestDoc[]): PartnerRequestDoc | null {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => trim(a.assignedAt).localeCompare(trim(b.assignedAt)))[rows.length - 1];
}

/** A request the participant has actually committed to (not declined, not withdrawn). */
export function isPartnerRequestLive(pr: PartnerRequestDoc | null): boolean {
  return !!pr && pr.status !== PARTNER_STATUS.DECLINED && pr.status !== PARTNER_STATUS.WITHDRAWN;
}

/** For computeGrantBalances. */
export function holdingApps(apps: readonly ApplicationDoc[]): HoldingApplication[] {
  return apps.map((a) => ({ appId: a.appId, status: a.status, windowId: a.windowId, approvedAt: a.approvedAt, reviewedAt: a.reviewedAt }));
}

export function holdingLines(lines: readonly (ApplicationLineDoc & { appId: string })[]): HoldingLine[] {
  return lines.map((l) => ({ appId: l.appId, grantId: l.grantId, optionsExercised: l.optionsExercised }));
}

/** For the sheet tax engine (perquisite approved since the payroll date). */
export function priorApps(apps: readonly ApplicationDoc[]): PriorApplication[] {
  return apps.map((a) => ({ appId: a.appId, status: a.status, approvedAt: a.approvedAt, perquisiteAmount: a.perquisiteAmount }));
}

/** Which applications can hold options (so whose lines must be read). */
export function appsThatMayHold(apps: readonly ApplicationDoc[], today: string): ApplicationDoc[] {
  const thisWindow = today.slice(0, 7);
  return apps.filter((a) => {
    if (a.status === STATUS.REJECTED) return false;
    if ((a.status === STATUS.DRAFT || a.status === STATUS.SENT_BACK) && windowKey(a.windowId) < thisWindow) return false;
    return true;
  });
}
