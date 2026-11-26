/**
 * AppStore.view: everything a screen needs about one application, as plain
 * serialisable data. Pure — the caller supplies the documents and file
 * metadata. Shared by the participant, admin and partner screens.
 */
import {
  indicativeQuote, round2, trim, type FlatTaxRounding, type IndicativeQuote, type Progress, type TaxContext,
} from '@/domain';
import type {
  ApplicationDoc, ApplicationLineDoc, EmployeeDoc, GrantDoc, PartnerRequestDoc, SectionKey, TaxPaymentDoc,
} from '@/lib/schema';
import { effectiveRate, progressOf, taxPaidTotal } from './applications';
import { emailFor } from './employees';

export interface FileRef {
  fileId: string;
  name: string;
  label: string;
  contentType: string;
  sizeKb: number;
  uploadedAt: string;
}

export interface LineView {
  grantId: string;
  planName: string;
  multiplier: number;
  grantDate: string;
  options: number;
  shares: number;
  exercisePrice: number;
  lineExerciseAmount: number;
  perquisitePerShare: number;
  linePerquisite: number;
}

export interface PartnerRequestView {
  requestId: string;
  partnerId: string;
  partner: string;
  status: string;
  amount: number;
  utr: string;
  date: string;
  paidAmount: number;
  bank: string;
  proof: FileRef | null;
  fedBy: string;
  fedAt: string;
  remarks: string;
}

export interface TaxPaymentView {
  paymentId: string;
  seq: number;
  paidBy: 'Self' | 'FundPartner';
  fundPartnerName: string;
  utr: string;
  date: string;
  amount: number;
  bank: string;
  proof: FileRef | null;
  enteredBy: string;
  enteredAt: string;
}

export interface AppView {
  appId: string;
  windowId: string;
  windowLabel: string;
  windowCloseDate: string;
  employeeId: string;
  employeeName: string;
  employmentStatus: string;
  status: ApplicationDoc['status'];
  progress: Progress;
  lines: LineView[];
  totalOptions: number;
  totalShares: number;
  exercisePrice: number;
  exerciseAmount: number;
  fmvDate: string;
  fmvValue: number;
  perquisiteAmount: number;
  taxRatePercent: number;
  taxAmount: number;
  taxMethod: ApplicationDoc['taxMethod'];
  taxBreakdown: unknown;
  taxEffectivePercent: number;
  effectiveRate: number;
  taxDueDate: string;
  taxFrozenAt: string;
  indicative: IndicativeQuote | null;
  prefilled: { pan: boolean; address: boolean; mobile: boolean; demat: boolean };
  applicant: ApplicationDoc['applicant'] & { email: string };
  demat: ApplicationDoc['demat'] & { pan: string; cml: FileRef | null; panCard: FileRef | null; source: string };
  exercisePayment: Omit<ApplicationDoc['exercisePayment'], 'proofFileId'> & { proof: FileRef | null };
  tax: {
    mode: ApplicationDoc['taxMode'];
    fundPartnerId: string;
    fundPartnerName: string;
    due: number;
    paidTotal: number;
    remaining: number;
    payments: TaxPaymentView[];
    partnerRequest: PartnerRequestView | null;
  };
  notice: { signatureName: string; signedAt: string; place: string; pdf: FileRef | null };
  review: ApplicationDoc['review'] & { remarks: ApplicationDoc['adminRemarks']; reviewedBy: string; reviewedAt: string };
  createdAt: string;
  updatedAt: string;
  submittedAt: string;
  approvedAt: string;
  editable: boolean;
  rev: number;
}

export interface ViewInput {
  app: ApplicationDoc;
  lines: readonly ApplicationLineDoc[];
  payments: readonly TaxPaymentDoc[];
  partnerRequest: PartnerRequestDoc | null;
  employee: EmployeeDoc | null;
  grants: readonly GrantDoc[];
  window: { label: string; closeDate: string } | null;
  files: ReadonlyMap<string, FileRef>;
  /** For the indicative figure before the FMV is fixed. */
  latest: { fmv: number; date: string } | null;
  taxContext: TaxContext | undefined;
  flatRounding: FlatTaxRounding;
}

/** Every file id an application refers to (to fetch their metadata in one go). */
export function fileIdsOf(app: ApplicationDoc, payments: readonly TaxPaymentDoc[], pr: PartnerRequestDoc | null): string[] {
  return [
    app.cmlFileId, app.panFileId, app.exercisePayment.proofFileId, app.notice.fileId,
    ...payments.map((p) => p.proofFileId), pr?.payment.proofFileId ?? '',
  ].filter(Boolean);
}

export function buildAppView(input: ViewInput): AppView {
  const { app: a, employee: emp } = input;
  const file = (id: string) => (id ? input.files.get(id) ?? null : null);
  const grantsById = new Map(input.grants.map((g) => [g.grantId, g]));
  const lines: LineView[] = input.lines.map((l) => {
    const g = grantsById.get(l.grantId);
    return {
      grantId: l.grantId,
      planName: l.planName || g?.planName || '',
      multiplier: l.multiplier || g?.multiplier || 1,
      grantDate: g?.grantDate ?? '',
      options: l.optionsExercised,
      shares: l.sharesAllotted,
      exercisePrice: l.exercisePrice,
      lineExerciseAmount: l.lineExerciseAmount,
      perquisitePerShare: l.perquisitePerShare,
      linePerquisite: l.linePerquisite,
    };
  });
  const paid = taxPaidTotal(input.payments);
  const pr = input.partnerRequest;
  const prog = progressOf(a, paid, pr ? pr.status : null);
  const rate = a.taxRatePercent || (emp?.taxRatePercent ?? 0);

  return {
    appId: a.appId,
    windowId: a.windowId,
    windowLabel: input.window?.label || a.windowId,
    windowCloseDate: input.window?.closeDate ?? '',
    employeeId: a.employeeId,
    employeeName: emp?.name ?? '',
    employmentStatus: emp ? emp.employmentStatus || 'Active' : '',
    status: a.status,
    progress: prog,
    lines,
    totalOptions: a.totalOptions,
    totalShares: a.totalShares,
    exercisePrice: a.exercisePrice,
    exerciseAmount: a.exerciseAmount,
    fmvDate: a.fmvDate,
    fmvValue: a.fmvValue,
    perquisiteAmount: a.perquisiteAmount,
    taxRatePercent: a.taxRatePercent,
    taxAmount: a.taxAmount,
    taxMethod: a.taxMethod,
    taxBreakdown: a.taxBreakdown ?? null,
    taxEffectivePercent: a.perquisiteAmount > 0 ? Math.round(a.taxAmount / a.perquisiteAmount * 10000) / 100 : 0,
    effectiveRate: effectiveRate(a),
    taxDueDate: a.taxDueDate,
    taxFrozenAt: a.taxFrozenAt,
    indicative: indicativeQuote({
      fixedFmvValue: a.fmvValue,
      latest: input.latest,
      lines: lines.map((l) => ({
        grantId: l.grantId, options: l.options, shares: l.shares, multiplier: l.multiplier,
        exercisePrice: l.exercisePrice, lineExerciseAmount: l.lineExerciseAmount,
      })),
      taxRatePercent: rate,
      opts: { tax: input.taxContext, flatRounding: input.flatRounding },
    }),
    prefilled: emp
      ? { pan: !!emp.pan, address: !!emp.address, mobile: !!emp.mobile, demat: !!(emp.demat.dpId && emp.demat.clientId) }
      : { pan: false, address: false, mobile: false, demat: false },
    applicant: { ...a.applicant, email: emp ? emailFor(emp) : '' },
    demat: { ...a.demat, pan: a.applicant.pan, cml: file(a.cmlFileId), panCard: file(a.panFileId), source: a.dematSource },
    exercisePayment: {
      utr: a.exercisePayment.utr, date: a.exercisePayment.date, amount: a.exercisePayment.amount,
      bank: a.exercisePayment.bank, proof: file(a.exercisePayment.proofFileId),
    },
    tax: {
      mode: a.taxMode,
      fundPartnerId: a.fundPartnerId,
      fundPartnerName: a.fundPartnerName,
      due: a.taxAmount,
      paidTotal: paid,
      remaining: Math.max(0, round2(a.taxAmount - paid)),
      payments: input.payments.map((p) => ({
        paymentId: p.paymentId, seq: p.seq, paidBy: p.paidBy, fundPartnerName: p.fundPartnerName, utr: p.utr,
        date: p.paymentDate, amount: p.amount, bank: p.bank, proof: file(p.proofFileId),
        enteredBy: p.enteredBy, enteredAt: p.enteredAt,
      })),
      partnerRequest: pr
        ? {
          requestId: pr.requestId, partnerId: pr.fundPartnerId, partner: pr.fundPartnerName, status: pr.status,
          amount: pr.taxAmount, utr: pr.payment.utr, date: pr.payment.date, paidAmount: pr.payment.amount,
          bank: pr.payment.bank, proof: file(pr.payment.proofFileId), fedBy: pr.fedBy, fedAt: pr.fedAt, remarks: pr.remarks,
        }
        : null,
    },
    notice: { signatureName: a.notice.signatureName, signedAt: a.notice.signedAt, place: a.notice.place, pdf: file(a.notice.fileId) },
    review: { ...a.review, remarks: a.adminRemarks, reviewedBy: a.reviewedBy, reviewedAt: a.reviewedAt },
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    submittedAt: a.submittedAt,
    approvedAt: a.approvedAt,
    editable: a.status === 'Draft' || a.status === 'Sent Back',
    rev: a.rev,
  };
}

/** Has the ESOP team sent this wizard stage back? */
export function stageSentBack(review: Partial<Record<SectionKey, string>> | undefined, stage: string): boolean {
  const map: Record<string, SectionKey> = { options: 'options', demat: 'demat', exercise: 'exercisePayment', tax: 'taxPayment', notice: 'notice' };
  const key = map[stage];
  return !!(review && key && trim(review[key]) === 'Sent Back');
}
