/**
 * Section completion, the current stage and who may change what
 * (AppStore.progress, isEditableByEmployee; EmployeeApi.saveOptions/submit;
 * agreed rule changes for send-back, repricing and re-signing).
 */
import { PARTNER_STATUS, REVIEW, SECTIONS, STAGES, STATUS, TAX_MODE, type SectionKey, type StageKey } from './config';
import { num, trim, type Numeric } from './util';

export interface ProgressInput {
  status: string;
  totalOptions: Numeric;
  dematDPId: unknown;
  dematClientId: unknown;
  cmlFileId: unknown;
  panFileId: unknown;
  panNumber: unknown;
  applicantAddress: unknown;
  applicantNationality: unknown;
  applicantMobile: unknown;
  exercisePaymentUTR: unknown;
  exercisePaymentDate: unknown;
  exerciseProofFileId: unknown;
  fmvValue: Numeric;
  noticeSignedAt: unknown;
  taxMode: unknown;
  taxAmount: Numeric;
  taxMethod: unknown;
  /** Sum of the TaxPayments rows (2 dp). */
  taxPaidTotal: number;
  /** Status of the latest partner request, or null. */
  partnerRequestStatus: string | null;
}

export type StageDone = Record<StageKey, boolean>;

export interface Progress {
  done: StageDone;
  stage: StageKey;
  pendingLabels: string[];
  complete: boolean;
}

const has = (v: unknown): boolean => !!trim(v);

/** AppStore.progress */
export function progress(a: ProgressInput): Progress {
  const taxMode = trim(a.taxMode);
  const done: StageDone = {
    options: num(a.totalOptions, 0) > 0,
    demat: has(a.dematDPId) && has(a.dematClientId) && has(a.cmlFileId) && has(a.panFileId) &&
      has(a.panNumber) && has(a.applicantAddress) && has(a.applicantNationality) && has(a.applicantMobile),
    exercise: has(a.exercisePaymentUTR) && has(a.exercisePaymentDate) && has(a.exerciseProofFileId) &&
      num(a.fmvValue, 0) > 0,
    tax: false,
    notice: has(a.noticeSignedAt),
    submit: ([STATUS.SUBMITTED, STATUS.UNDER_REVIEW, STATUS.APPROVED] as string[]).indexOf(trim(a.status)) >= 0
  };

  const due = num(a.taxAmount, 0);
  const paid = a.taxPaidTotal;
  if (taxMode === TAX_MODE.SELF) {
    done.tax = due > 0 && paid + 1 >= due;
  } else if (taxMode === TAX_MODE.PARTNER) {
    const prs = trim(a.partnerRequestStatus);
    done.tax = (prs === PARTNER_STATUS.PAID || prs === PARTNER_STATUS.VERIFIED) && paid + 1 >= due;
  }
  if (!done.tax && trim(a.taxMethod) === 'Sheet' && due === 0 && num(a.fmvValue, 0) > 0) done.tax = true;

  let stage: StageKey = 'submit';
  for (const s of STAGES) {
    if (s.key === 'submit') break;
    if (!done[s.key]) { stage = s.key; break; }
  }
  const pendingLabels = STAGES.filter((s) => s.key !== 'submit' && !done[s.key]).map((s) => s.label as string);
  return { done, stage, pendingLabels, complete: pendingLabels.length === 0 };
}

/** AppStore.isEditableByEmployee: Draft or Sent Back. */
export function isEditableByEmployee(status: unknown): boolean {
  const s = trim(status);
  return s === STATUS.DRAFT || s === STATUS.SENT_BACK;
}

/** Statuses still in play (one per participant per window). */
export function isLiveStatus(status: unknown): boolean {
  const s = trim(status);
  return s === STATUS.DRAFT || s === STATUS.SUBMITTED || s === STATUS.UNDER_REVIEW || s === STATUS.SENT_BACK;
}

/**
 * saveOptions: once the exercise amount is paid the options are fixed,
 * unless the ESOP team sent the payment back — then the pinned FMV is
 * cleared before repricing.
 */
export function canEditOptions(a: { fmvValue: Numeric; exercisePaymentUTR: unknown; reviewExercisePayment: unknown; appId?: string }):
  { ok: true; clearFmv: boolean } | { ok: false; error: string } {
  const paidAlready = num(a.fmvValue, 0) > 0 || has(a.exercisePaymentUTR);
  const sentBack = trim(a.reviewExercisePayment) === REVIEW.BACK;
  if (paidAlready && !sentBack) {
    return {
      ok: false,
      error: 'The exercise amount for ' + trim(a.appId) + ' has already been paid, ' +
        'so the options are now fixed. The fair market value is set by the trading day before that ' +
        'payment and has to apply to the whole application. To change the number of options, ask ' +
        'the ESOP team to send the exercise payment back to you — this step then opens again.'
    };
  }
  return { ok: true, clearFmv: paidAlready && sentBack };
}

/** AGREED CHANGE: an Approved or Rejected application cannot be sent back (legacy allowed it — bug 8). */
export function canSendBack(status: unknown): boolean {
  const s = trim(status);
  return s !== STATUS.APPROVED && s !== STATUS.REJECTED;
}

/**
 * AGREED CHANGE: perquisite and tax are frozen once submitted. Automatic
 * repricing (tax-sheet load, rate or price change) only touches Draft and
 * Sent Back; anything else needs an explicit, audited admin reprice.
 * Legacy repriced everything not Approved/Rejected (bug 10).
 */
export function canAutoReprice(status: unknown): boolean {
  return isEditableByEmployee(status);
}

/**
 * AGREED CHANGE: editing any section other than the notice after signing
 * clears the signature, so the notice must be signed again (bug 11).
 */
export function editClearsSignature(section: SectionKey, noticeSignedAt: unknown): boolean {
  return section !== 'notice' && has(noticeSignedAt);
}

/** submit: sections the ESOP team sent back that have not been touched since. */
export function sectionsStillSentBack(review: Partial<Record<SectionKey, unknown>>): string[] {
  return SECTIONS.filter((s) => trim(review[s.key]) === REVIEW.BACK).map((s) => s.label);
}

/** submit's gate, in legacy order: incomplete sections, then unresolved send-backs. */
export function submitBlocker(p: Progress, review: Partial<Record<SectionKey, unknown>>): string {
  if (!p.complete) return 'Still to finish before you can submit: ' + p.pendingLabels.join(', ') + '.';
  const back = sectionsStillSentBack(review);
  if (back.length) {
    return 'The ESOP team sent these back and they have not been corrected yet: ' +
      back.join(', ') + '. Correct and save each one, then submit again.';
  }
  return '';
}
