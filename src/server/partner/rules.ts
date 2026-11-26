/**
 * The fund partner's rules (PartnerApi.gs), pure so they are unit tested.
 * The mutations in ./mutations.ts read, call these, then write.
 */
import {
  PARTNER_STATUS, inr, num, trim, validateDemat, validatePaymentDate, validateUtr, type DematType,
} from '@/domain';
import type { PartnerRequestDoc } from '@/lib/schema';

/** A partner may change a request only while it is Assigned or Sent Back. */
export const PARTNER_EDITABLE: readonly string[] = [PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK];

export function isPartnerEditable(status: string): boolean {
  return PARTNER_EDITABLE.includes(trim(status));
}

export interface PartnerDematInput {
  accountType: string;
  dpName: string;
  accountName: string;
  dpId: string;
  clientId: string;
  /** A newly uploaded CML (partnerCml), or ''. */
  cmlFileId: string;
}

export interface PartnerPaymentInput {
  utr: string;
  paymentDate: string;
  amount: string;
  bank: string;
  /** A newly uploaded proof (partnerTaxProof), or ''. */
  proofFileId: string;
}

export interface CheckedDemat {
  dpName: string;
  accountName: string;
  dpId: string;
  clientId: string;
  accountType: DematType;
}

export const CML_REQUIRED = 'Attach the client master list (CML) for the demat account — the shares are allotted against it.';

/**
 * saveDemat's checks: the participant's rules for the identifiers, the DP
 * name defaulting to the partner's own, and a CML on file or attached now.
 */
export function checkPartnerDemat(input: PartnerDematInput, partnerName: string, hasCml: boolean):
  { ok: true; value: CheckedDemat } | { ok: false; errors: string[] } {
  const dpName = trim(input.dpName) || trim(partnerName);
  const errors: string[] = [];
  const dm = validateDemat({
    dematDPName: dpName, dematAccountName: trim(input.accountName), dematDPId: trim(input.dpId),
    dematClientId: trim(input.clientId), dematAccountType: trim(input.accountType),
  });
  if (!dm.ok) errors.push(dm.error);
  if (!hasCml) errors.push(CML_REQUIRED);
  if (!dm.ok || errors.length) return { ok: false, errors };
  return { ok: true, value: { dpName, accountName: trim(input.accountName), ...dm.value } };
}

/** The legacy multi-problem message: "3 things to fix:\n\n• …\n• …". */
export function problemsMessage(problems: readonly string[]): string {
  return (problems.length === 1 ? '' : problems.length + ' things to fix:\n\n') + problems.map((p) => '• ' + p).join('\n');
}

/**
 * submitAll: every problem with the account AND the payment, found before
 * anything is written, reported at once.
 */
export function submitAllProblems(input: {
  demat: PartnerDematInput; payment: PartnerPaymentInput; partnerName: string;
  hasCml: boolean; hasProof: boolean; due: number; today: string;
}): { problems: string[]; paid: number } {
  const problems: string[] = [];
  const dm = checkPartnerDemat(input.demat, input.partnerName, input.hasCml);
  if (!dm.ok) problems.push(...dm.errors);

  const utr = validateUtr(trim(input.payment.utr));
  if (!utr.ok) problems.push(utr.error);
  if (!trim(input.payment.paymentDate)) {
    problems.push('Enter the date on which the tax was paid.');
  } else {
    const d = validatePaymentDate(input.payment.paymentDate, 'tax payment', input.today);
    if (!d.ok) problems.push(d.error);
  }
  if (!input.hasProof) {
    problems.push('Attach the payment advice or bank statement for this transfer — the ESOP team verifies the UTR against it.');
  }
  const due = num(input.due, 0);
  const paid = num(input.payment.amount, 0) || due;
  if (paid + 1 < due) {
    problems.push('The amount paid (' + inr(paid) + ') is short of the tax due (' + inr(due) + '). Pay the balance before submitting.');
  }
  return { problems, paid };
}

/**
 * savePayment: the request's payment fields after this save. With
 * `finalise` the legacy checks apply (account first, UTR, date, proof,
 * amount not short) and a blank amount means the tax due. Throws a message.
 */
export function planPayment(input: {
  current: PartnerRequestDoc['payment']; entered: PartnerPaymentInput; newProofFileId: string;
  finalise: boolean; due: number; today: string; dematRecorded: boolean;
}): { ok: true; payment: PartnerRequestDoc['payment'] } | { ok: false; error: string } {
  const e = input.entered;
  const pay = { ...input.current };
  pay.utr = trim(e.utr).toUpperCase();
  pay.bank = trim(e.bank);
  if (trim(e.amount) !== '') pay.amount = num(e.amount, 0);
  if (trim(e.paymentDate)) {
    const d = validatePaymentDate(e.paymentDate, 'tax payment', input.today);
    if (!d.ok) return { ok: false, error: d.error };
    pay.date = d.value;
  }
  if (input.newProofFileId) pay.proofFileId = input.newProofFileId;

  if (input.finalise) {
    if (!input.dematRecorded) {
      return {
        ok: false,
        error: 'Record the demat account first — the shares from this exercise are allotted into the account held with you, ' +
          'and the ESOP team needs it before allotment.',
      };
    }
    const utr = validateUtr(pay.utr);
    if (!utr.ok) return { ok: false, error: utr.error };
    pay.utr = utr.value;
    if (!pay.date) return { ok: false, error: 'Enter the date on which the tax was paid.' };
    if (!pay.proofFileId) return { ok: false, error: 'Upload the payment advice or bank statement for this transfer.' };
    const due = num(input.due, 0);
    if (!pay.amount) pay.amount = due;
    else if (pay.amount + 1 < due) {
      return {
        ok: false,
        error: 'The amount paid (' + inr(pay.amount) + ') is short of the tax due (' + inr(due) +
          '). Pay the balance before marking this complete.',
      };
    }
  }
  return { ok: true, payment: pay };
}

export const DECLINE_REASON_MIN = 5;

export function checkDeclineReason(reason: string): { ok: true; value: string } | { ok: false; error: string } {
  const r = trim(reason);
  if (r.length < DECLINE_REASON_MIN) {
    return { ok: false, error: 'Give the participant a reason — they are shown it, and it is what they act on.' };
  }
  return { ok: true, value: r.slice(0, 1000) };
}

/** Whether the partner's account differs from the one the participant entered (the warning on the form). */
export function dematMismatch(own: { dpId: string; clientId: string } | null, partner: { dpId: string; clientId: string }): boolean {
  if (!own || !trim(own.dpId) || !trim(partner.dpId) || !trim(partner.clientId)) return false;
  return trim(own.dpId).toUpperCase() !== trim(partner.dpId).toUpperCase() ||
    trim(own.clientId).toUpperCase() !== trim(partner.clientId).toUpperCase();
}

/** Worklist order: sent back, assigned, fed, verified, declined; then by due date. */
export function sortRequests<T extends { status: string; taxDueDate: string }>(rows: T[]): T[] {
  const rank: Record<string, number> = {
    [PARTNER_STATUS.SENT_BACK]: 0, [PARTNER_STATUS.ASSIGNED]: 1, [PARTNER_STATUS.PAID]: 2,
    [PARTNER_STATUS.VERIFIED]: 3, [PARTNER_STATUS.DECLINED]: 4,
  };
  return [...rows].sort((a, b) =>
    (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || String(a.taxDueDate).localeCompare(String(b.taxDueDate)));
}

export interface PartnerSummary {
  awaitingPayment: number;
  awaitingAmount: number;
  overdue: number;
  fedNotVerified: number;
  verified: number;
}

/** The dashboard figures (PartnerApi.dashboard summary). */
export function partnerSummary(rows: readonly { status: string; taxAmount: number; taxDueDate: string }[], today: string): PartnerSummary {
  const open = rows.filter((r) => isPartnerEditable(r.status));
  return {
    awaitingPayment: open.length,
    awaitingAmount: Math.round(open.reduce((a, r) => a + num(r.taxAmount, 0), 0) * 100) / 100,
    overdue: open.filter((r) => r.taxDueDate && r.taxDueDate < today).length,
    fedNotVerified: rows.filter((r) => r.status === PARTNER_STATUS.PAID).length,
    verified: rows.filter((r) => r.status === PARTNER_STATUS.VERIFIED).length,
  };
}
