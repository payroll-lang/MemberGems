/**
 * The monthly export (AdminApi.exportWindow): one row per grant line, the 39
 * legacy columns in their legacy order. Downstream allotment and payroll
 * processes read these headings, so they must not change. Pure.
 */
import { inr, instantMs, istStamp, num, prettyDate, toDateKey, trim } from '@/domain';
import type { ApplicationDoc, ApplicationLineDoc, EmployeeDoc, PartnerRequestDoc, TaxPaymentDoc } from '@/lib/schema';
import { emailFor } from '../../core/employees';

export const EXPORT_COLUMNS = [
  'Window', 'AppID', 'Status', 'EmployeeID', 'Name', 'Designation', 'EmploymentStatus', 'Email', 'PAN',
  'GrantID', 'Plan', 'Multiplier', 'Options', 'Shares', 'ExercisePrice', 'ExerciseAmount', 'FMVDate', 'FMV',
  'PerquisitePerShare', 'Perquisite', 'TaxRatePercent', 'TaxOnApplication', 'TaxMode', 'FundPartner', 'ExerciseUTR',
  'ExercisePaymentDate', 'TaxPaidAmount', 'TaxPaymentCount', 'TaxUTRs', 'TaxPaymentDate', 'DematAccountType',
  'DematSuppliedBy', 'DPID', 'ClientID', 'DematAccountName', 'NoticeSignedAt', 'NoticePlace', 'ApprovedAt', 'FolderURL',
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];
export type ExportRow = Record<ExportColumn, string | number>;

/** Columns written as text, so "01234567" stays a code and not a number. */
export const TEXT_COLUMNS: readonly ExportColumn[] = ['EmployeeID', 'PAN', 'GrantID', 'ExerciseUTR', 'DPID', 'ClientID', 'AppID', 'Window'];

export interface ExportInput {
  windowId: string;
  app: ApplicationDoc;
  employee: EmployeeDoc | null;
  lines: readonly ApplicationLineDoc[];
  payments: readonly TaxPaymentDoc[];
  partnerRequest: PartnerRequestDoc | null;
  /** Where the application's documents are (legacy: its Drive folder; now the admin detail page). */
  folderUrl: string;
}

/**
 * The legacy TaxPaymentDate column read an application field the new model
 * does not have; it is the latest remittance date, else the partner's.
 */
function taxPaymentDate(payments: readonly TaxPaymentDoc[], pr: PartnerRequestDoc | null): string {
  const dates = payments.map((p) => toDateKey(p.paymentDate)).filter(Boolean).sort();
  if (dates.length) return dates[dates.length - 1];
  return pr ? toDateKey(pr.payment.date) : '';
}

/** Timestamps as the legacy sheet wrote them: 'yyyy-MM-dd HH:mm:ss' IST. */
export function sheetStamp(v: unknown): string {
  const ms = instantMs(v);
  return ms === null ? '' : istStamp(ms);
}

export function exportRowsFor(input: ExportInput): ExportRow[] {
  const { app: a, employee: emp, payments, partnerRequest: pr } = input;
  const taxUtrs = payments.map((r) => trim(r.utr) + ' (' + inr(r.amount) + ' on ' + prettyDate(r.paymentDate) + ')').join('; ');
  return input.lines.map((l) => ({
    Window: input.windowId,
    AppID: a.appId,
    Status: a.status,
    EmployeeID: a.employeeId,
    Name: emp?.name ?? '',
    Designation: trim(a.applicant.designation) || emp?.designation || '',
    EmploymentStatus: emp?.employmentStatus ?? '',
    Email: emp ? emailFor(emp) : '',
    PAN: a.applicant.pan,
    GrantID: l.grantId,
    Plan: l.planName,
    Multiplier: num(l.multiplier, 1),
    Options: num(l.optionsExercised, 0),
    Shares: num(l.sharesAllotted, 0),
    ExercisePrice: num(l.exercisePrice, 0),
    ExerciseAmount: num(l.lineExerciseAmount, 0),
    FMVDate: toDateKey(a.fmvDate),
    FMV: num(a.fmvValue, 0),
    PerquisitePerShare: num(l.perquisitePerShare, 0),
    Perquisite: num(l.linePerquisite, 0),
    TaxRatePercent: num(a.taxRatePercent, 0),
    TaxOnApplication: num(a.taxAmount, 0),
    TaxMode: a.taxMode,
    FundPartner: a.fundPartnerName,
    ExerciseUTR: a.exercisePayment.utr,
    ExercisePaymentDate: toDateKey(a.exercisePayment.date),
    TaxPaidAmount: num(a.taxPaidAmount, 0),
    TaxPaymentCount: num(a.taxPaymentCount, 0),
    TaxUTRs: taxUtrs,
    TaxPaymentDate: taxPaymentDate(payments, pr),
    DematAccountType: a.demat.accountType,
    DematSuppliedBy: trim(a.dematSource) || 'Participant',
    DPID: a.demat.dpId,
    ClientID: a.demat.clientId,
    DematAccountName: a.demat.accountName,
    NoticeSignedAt: sheetStamp(a.notice.signedAt),
    NoticePlace: a.notice.place,
    ApprovedAt: sheetStamp(a.approvedAt),
    FolderURL: input.folderUrl,
  }));
}
