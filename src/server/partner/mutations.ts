import 'server-only';
import { PARTNER_STATUS, inr, prettyDate, prettyStamp, round2, trim } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { sendTemplate, sendToAdmins } from '@/lib/mail';
import type {
  ApplicationDoc, EmployeeDoc, FileDoc, PartnerRequestDoc, ReviewState, SectionKey, TaxPaymentDoc, UserDoc,
} from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { appRef, getApplication, nextTaxSeq, taxPaidTotal, taxPaymentsCol, taxPaymentsOf } from '../applications';
import { UserError, toActionResult, type ActionResult } from '../core/errors';
import { uid, type Tx } from '../db';
import { getEmployee } from '../employees';
import { requireAttachable, supersede } from '../files';
import { getPartnerRequest, partnerRequestRef } from '../partnerRequests';
import { employeeNotifyEmail } from '../jobs/recipients';
import {
  checkDeclineReason, checkPartnerDemat, isPartnerEditable, planPayment, problemsMessage, submitAllProblems,
  type CheckedDemat, type PartnerDematInput, type PartnerPaymentInput,
} from './rules';

/**
 * The fund partner's writes (PartnerApi.saveDemat / savePayment / submitAll /
 * decline). Each runs in one Firestore transaction that re-reads the request
 * and the application, re-checks that the request is this partner's and still
 * open, and writes the request, the application (with its revision raised)
 * and the tax-payment rows together. Audit entries and emails follow the
 * commit; their failure never undoes it.
 */

export interface PartnerContext {
  user: UserDoc;
  partnerId: string;
  partnerName: string;
}

export function partnerContext(user: UserDoc): PartnerContext {
  if (user.role !== 'FundPartner') throw new UserError('This screen is for fund partners.');
  const partnerId = trim(user.fundPartnerId);
  const partnerName = trim(user.fundPartnerName);
  if (!partnerId || !partnerName) throw new UserError('Your login is not linked to a fund partner. Contact the ESOP team.');
  return { user, partnerId, partnerName };
}

type Effect = () => Promise<unknown>;
interface Outcome { message: string; effects: Effect[] }

async function run(user: UserDoc, label: string, body: (tx: Tx, ctx: PartnerContext, now: string, today: string) => Promise<Outcome>): Promise<ActionResult> {
  try {
    const ctx = partnerContext(user);
    const today = todayIst();
    const out = await db().runTransaction((tx) => body(tx, ctx, nowIso(), today));
    for (const effect of out.effects) {
      try { await effect(); } catch (e) { console.error('partner ' + label + ': follow-up failed', e); }
    }
    return { ok: true, message: out.message };
  } catch (e) {
    return toActionResult(e, 'partner ' + label);
  }
}

interface Loaded { pr: PartnerRequestDoc; app: ApplicationDoc; emp: EmployeeDoc | null }

/** PartnerApi.requireRequest, plus: the application must still be routed to this partner. */
async function loadRequest(tx: Tx, ctx: PartnerContext, requestId: string): Promise<Loaded> {
  const key = trim(requestId);
  const pr = key && !key.includes('/') ? await getPartnerRequest(key, tx) : null;
  if (!pr || pr.fundPartnerId !== ctx.partnerId) throw new UserError('Request ' + key + ' is not assigned to ' + ctx.partnerName + '.');
  const app = await getApplication(pr.appId, tx);
  if (!app) throw new UserError('The application for request ' + key + ' is no longer on record. Contact the ESOP team.');
  const emp = await getEmployee(app.employeeId, tx);
  return { pr, app, emp };
}

function assertOpen(l: Loaded, refusal: string): void {
  if (!isPartnerEditable(l.pr.status)) {
    throw new UserError('This request is ' + l.pr.status.toLowerCase() + ' ' + refusal);
  }
  if (l.app.taxMode !== 'FundPartner' || l.app.fundPartnerId !== l.pr.fundPartnerId) {
    throw new UserError('This request is no longer active: the participant has changed how the tax on ' + l.app.appId +
      ' is paid. Contact the ESOP team if you think this is wrong.');
  }
}

/** A partner upload for this request: right purpose, application and request, confirmed, not replaced. */
async function requirePartnerFile(fileId: string, l: Loaded, purpose: 'partnerCml' | 'partnerTaxProof', tx: Tx): Promise<FileDoc> {
  const f = await requireAttachable(fileId, { ownerEmployeeId: l.pr.employeeId, appId: l.pr.appId, purposes: [purpose] }, tx);
  if (f.requestId !== l.pr.requestId) throw new UserError('That upload does not belong to this request. Please upload the file again.');
  return f;
}

/** Collects the patches to the request and the application so each is written once. */
class Writes {
  pr: Record<string, unknown> = {};
  app: Record<string, unknown> = {};
  review: Partial<Record<SectionKey, ReviewState>> = {};
  constructor(readonly l: Loaded) {}
  commit(tx: Tx, now: string) {
    if (Object.keys(this.pr).length) tx.update(partnerRequestRef(this.l.pr.requestId), this.pr);
    if (Object.keys(this.review).length) this.app.review = { ...this.l.app.review, ...this.review };
    tx.update(appRef(this.l.app.appId), { ...this.app, rev: (this.l.app.rev || 0) + 1, updatedAt: now });
  }
}

/* ================= demat ================= */

function applyDemat(w: Writes, ctx: PartnerContext, d: CheckedDemat, newCml: FileDoc | null, tx: Tx, now: string): void {
  const { pr, app } = w.l;
  const cmlId = newCml ? newCml.fileId : pr.partnerDemat.cmlFileId;
  if (newCml && pr.partnerDemat.cmlFileId && pr.partnerDemat.cmlFileId !== newCml.fileId) supersede(tx, pr.partnerDemat.cmlFileId, now);
  w.pr.partnerDemat = { ...d, cmlFileId: cmlId, providedBy: ctx.user.userId, providedAt: now };
  // Keep the participant's own account the first time it is displaced, so
  // going back to paying the tax themselves restores what they entered.
  if (!app.dematSource && !(pr.employeeDemat && pr.employeeDemat.dpId)) {
    w.pr.employeeDemat = { ...app.demat, cmlFileId: app.cmlFileId };
  }
  // The application carries the account the shares actually go to: what the
  // registrar is given. Changing it has to be re-checked.
  w.app.demat = { dpName: d.dpName, dpId: d.dpId, clientId: d.clientId, accountName: d.accountName, accountType: d.accountType };
  w.app.dematSource = ctx.partnerName;
  w.app.cmlFileId = cmlId || app.cmlFileId;
  w.review.demat = 'Pending';
}

function dematEffects(ctx: PartnerContext, l: Loaded, d: CheckedDemat): Effect[] {
  const { app, emp } = l;
  const name = emp?.name ?? '';
  return [
    () => audit(ctx.user.userId, 'FundPartner', 'PARTNER_DEMAT_SET', ctx.partnerName + ' ' + d.accountType + ' ' + d.dpId + ' / ' + d.clientId, app.appId),
    async () => emp && sendTemplate('partner_demat_set_employee', await employeeNotifyEmail(emp), {
      name, appId: app.appId, partner: ctx.partnerName, dpName: d.dpName, dpId: d.dpId, clientId: d.clientId,
      accountType: d.accountType, accountName: d.accountName, totalShares: app.totalShares,
    }, { appId: app.appId }),
    () => sendToAdmins('partner_demat_set_admin', {
      partner: ctx.partnerName, appId: app.appId, employeeName: name, employeeId: app.employeeId, dpId: d.dpId,
      clientId: d.clientId, accountType: d.accountType, accountName: d.accountName, totalShares: app.totalShares,
    }, { appId: app.appId }),
  ];
}

/** "Save just the account": the allotment account on its own. */
export function savePartnerDemat(user: UserDoc, input: { requestId: string; demat: PartnerDematInput }): Promise<ActionResult> {
  return run(user, 'saveDemat', async (tx, ctx, now) => {
    const l = await loadRequest(tx, ctx, input.requestId);
    assertOpen(l, 'and the demat account can no longer be changed. Contact the ESOP team.');
    const newCml = trim(input.demat.cmlFileId) && input.demat.cmlFileId !== l.pr.partnerDemat.cmlFileId
      ? await requirePartnerFile(input.demat.cmlFileId, l, 'partnerCml', tx) : null;
    const checked = checkPartnerDemat(input.demat, ctx.partnerName, !!(newCml || l.pr.partnerDemat.cmlFileId));
    if (!checked.ok) throw new UserError(checked.errors.length === 1 ? checked.errors[0] : problemsMessage(checked.errors));
    const w = new Writes(l);
    applyDemat(w, ctx, checked.value, newCml, tx, now);
    w.commit(tx, now);
    const d = checked.value;
    return {
      message: 'Demat account recorded. The shares for this exercise will be allotted to ' + d.dpId + ' / ' + d.clientId + '.',
      effects: dematEffects(ctx, l, d),
    };
  });
}

/* ================= payment ================= */

/**
 * The partner's payment becomes a tax-payment row on the application (one
 * row per partner request: an upsert, not an append) and the totals are
 * refreshed, so the admin screen and the export read every remittance from
 * one place.
 */
function mirrorPayment(w: Writes, ctx: PartnerContext, pay: PartnerRequestDoc['payment'], payments: TaxPaymentDoc[], tx: Tx, now: string): void {
  const { app } = w.l;
  const partnerRows = payments.filter((r) => r.paidBy === 'FundPartner');
  const mirror = {
    appId: app.appId, employeeId: app.employeeId, paidBy: 'FundPartner' as const, fundPartnerName: ctx.partnerName,
    utr: pay.utr, paymentDate: pay.date, amount: pay.amount, bank: pay.bank, proofFileId: pay.proofFileId,
    enteredBy: ctx.user.userId, enteredAt: now, remarks: 'Paid by fund partner',
  };
  let after: TaxPaymentDoc[];
  if (partnerRows.length) {
    const row: TaxPaymentDoc = { ...partnerRows[0], ...mirror };
    tx.set(taxPaymentsCol(app.appId).doc(row.paymentId), row);
    after = payments.map((p) => (p.paymentId === row.paymentId ? row : p));
  } else {
    const ref = taxPaymentsCol(app.appId).doc(uid('TP-'));
    const row: TaxPaymentDoc = { paymentId: ref.id, seq: nextTaxSeq(payments), ...mirror };
    tx.create(ref, row);
    after = [...payments, row];
  }
  w.app.taxPaidAmount = taxPaidTotal(after);
  w.app.taxPaymentCount = after.length;
  w.review.taxPayment = 'Pending';
}

function paymentEffects(ctx: PartnerContext, l: Loaded, pay: PartnerRequestDoc['payment']): Effect[] {
  const { app, emp } = l;
  const name = emp?.name ?? '';
  const data = { partner: ctx.partnerName, appId: app.appId, amount: pay.amount, utr: pay.utr, paymentDate: prettyDate(pay.date) };
  return [
    () => audit(ctx.user.userId, 'FundPartner', 'PARTNER_PAYMENT_FED', ctx.partnerName + ' utr ' + pay.utr + ' ' + inr(pay.amount), app.appId),
    async () => emp && sendTemplate('partner_payment_fed_employee', await employeeNotifyEmail(emp), { name, ...data }, { appId: app.appId }),
    () => sendToAdmins('partner_payment_fed_admin', { ...data, employeeName: name, employeeId: app.employeeId }, { appId: app.appId }),
  ];
}

function applyFinalPayment(w: Writes, ctx: PartnerContext, pay: PartnerRequestDoc['payment'], payments: TaxPaymentDoc[], tx: Tx, now: string): void {
  w.pr.payment = pay;
  w.pr.status = PARTNER_STATUS.PAID;
  w.pr.fedBy = ctx.user.userId;
  w.pr.fedAt = now;
  mirrorPayment(w, ctx, pay, payments, tx, now);
}

/**
 * The payment fields. `finalise` false is "Save without submitting": the
 * request keeps what was typed, nobody is told, the ESOP team sees nothing.
 */
export function savePartnerPayment(user: UserDoc, input: { requestId: string; payment: PartnerPaymentInput; finalise: boolean }): Promise<ActionResult> {
  return run(user, 'savePayment', async (tx, ctx, now, today) => {
    const l = await loadRequest(tx, ctx, input.requestId);
    assertOpen(l, 'and can no longer be edited.');
    const newProof = trim(input.payment.proofFileId) && input.payment.proofFileId !== l.pr.payment.proofFileId
      ? await requirePartnerFile(input.payment.proofFileId, l, 'partnerTaxProof', tx) : null;
    const payments = await taxPaymentsOf(l.app.appId, tx);
    const planned = planPayment({
      current: l.pr.payment, entered: input.payment, newProofFileId: newProof ? newProof.fileId : '', finalise: input.finalise,
      due: l.pr.taxAmount, today, dematRecorded: !!(l.pr.partnerDemat.dpId && l.pr.partnerDemat.clientId),
    });
    if (!planned.ok) throw new UserError(planned.error);
    if (newProof && l.pr.payment.proofFileId && !payments.some((p) => p.proofFileId === l.pr.payment.proofFileId)) {
      supersede(tx, l.pr.payment.proofFileId, now);
    }
    const w = new Writes(l);
    if (input.finalise) applyFinalPayment(w, ctx, planned.payment, payments, tx, now);
    else w.pr.payment = planned.payment;
    if (input.finalise) w.commit(tx, now);
    else tx.update(partnerRequestRef(l.pr.requestId), w.pr);
    return input.finalise
      ? { message: 'Payment recorded. The employee and the ESOP team have been notified.', effects: paymentEffects(ctx, l, planned.payment) }
      : {
        message: 'Saved, but NOT yet submitted — the ESOP team cannot see it until you record the payment as made.',
        effects: [() => audit(ctx.user.userId, 'FundPartner', 'PARTNER_PAYMENT_SAVED', '', l.app.appId)],
      };
  });
}

/**
 * "Submit the account and payment" (PartnerApi.submitAll): everything is
 * checked before anything is written and every problem is reported at once;
 * then the account and the payment are recorded in one transaction.
 */
export function submitPartnerRequest(user: UserDoc, input: { requestId: string; demat: PartnerDematInput; payment: PartnerPaymentInput }): Promise<ActionResult> {
  return run(user, 'submitAll', async (tx, ctx, now, today) => {
    const l = await loadRequest(tx, ctx, input.requestId);
    assertOpen(l, 'and can no longer be edited. Contact the ESOP team.');
    const newCml = trim(input.demat.cmlFileId) && input.demat.cmlFileId !== l.pr.partnerDemat.cmlFileId
      ? await requirePartnerFile(input.demat.cmlFileId, l, 'partnerCml', tx) : null;
    const newProof = trim(input.payment.proofFileId) && input.payment.proofFileId !== l.pr.payment.proofFileId
      ? await requirePartnerFile(input.payment.proofFileId, l, 'partnerTaxProof', tx) : null;
    const payments = await taxPaymentsOf(l.app.appId, tx);

    const { problems, paid } = submitAllProblems({
      demat: input.demat, payment: input.payment, partnerName: ctx.partnerName,
      hasCml: !!(newCml || l.pr.partnerDemat.cmlFileId), hasProof: !!(newProof || l.pr.payment.proofFileId),
      due: l.pr.taxAmount, today,
    });
    if (problems.length) throw new UserError(problemsMessage(problems));

    const checked = checkPartnerDemat(input.demat, ctx.partnerName, true);
    if (!checked.ok) throw new UserError(problemsMessage(checked.errors));
    const planned = planPayment({
      current: l.pr.payment, entered: { ...input.payment, amount: String(paid) }, newProofFileId: newProof ? newProof.fileId : '',
      finalise: true, due: l.pr.taxAmount, today, dematRecorded: true,
    });
    if (!planned.ok) throw new UserError(planned.error);
    if (newProof && l.pr.payment.proofFileId && !payments.some((p) => p.proofFileId === l.pr.payment.proofFileId)) {
      supersede(tx, l.pr.payment.proofFileId, now);
    }

    const w = new Writes(l);
    applyDemat(w, ctx, checked.value, newCml, tx, now);
    applyFinalPayment(w, ctx, planned.payment, payments, tx, now);
    w.commit(tx, now);
    return {
      message: 'Payment recorded. The employee and the ESOP team have been notified.',
      effects: [...dematEffects(ctx, l, checked.value), ...paymentEffects(ctx, l, planned.payment)],
    };
  });
}

/* ================= decline ================= */

/**
 * The partner turns the request down. The participant gets their position
 * back: the tax route is cleared, their own demat account and CML are
 * restored if the partner's had replaced them, and any remittance mirrored
 * from this partner goes. Options, exercise payment and notice stand.
 */
export function declinePartnerRequest(user: UserDoc, input: { requestId: string; reason: string }): Promise<ActionResult> {
  return run(user, 'decline', async (tx, ctx, now) => {
    const l = await loadRequest(tx, ctx, input.requestId);
    assertOpen(l, 'and can no longer be declined.');
    const reason = checkDeclineReason(input.reason);
    if (!reason.ok) throw new UserError(reason.error);
    const { pr, app, emp } = l;
    const payments = await taxPaymentsOf(app.appId, tx);

    const w = new Writes(l);
    w.app.taxMode = '';
    w.app.fundPartnerId = '';
    w.app.fundPartnerName = '';
    w.review.taxPayment = 'Pending';
    if (app.dematSource) {
      const own = pr.employeeDemat;
      const d = own ?? emp?.demat ?? { dpName: '', dpId: '', clientId: '', accountName: '', accountType: '' as const };
      w.app.dematSource = '';
      w.app.demat = { dpName: d.dpName, dpId: d.dpId, clientId: d.clientId, accountName: d.accountName, accountType: d.accountType };
      w.app.cmlFileId = own ? own.cmlFileId : '';
      w.review.demat = 'Pending';
    }
    // A remittance mirrored from this partner was never the participant's, so it goes.
    const partnerRows = payments.filter((r) => r.paidBy === 'FundPartner');
    partnerRows.forEach((r) => tx.delete(taxPaymentsCol(app.appId).doc(r.paymentId)));
    const rest = payments.filter((r) => r.paidBy !== 'FundPartner');
    w.app.taxPaidAmount = round2(taxPaidTotal(rest));
    w.app.taxPaymentCount = rest.length;

    w.pr.status = PARTNER_STATUS.DECLINED;
    w.pr.remarks = 'Declined by ' + ctx.user.userId + ' on ' + prettyStamp(now) + ': ' + reason.value;
    w.commit(tx, now);

    const data = {
      name: emp?.name ?? '', appId: app.appId, partner: ctx.partnerName, reason: reason.value, taxAmount: pr.taxAmount,
      taxDueDate: prettyDate(app.taxDueDate), employeeName: emp?.name ?? '', employeeId: app.employeeId,
    };
    return {
      message: 'Declined. The participant has been told why and can choose another route.',
      effects: [
        () => audit(ctx.user.userId, 'FundPartner', 'PARTNER_DECLINED', ctx.partnerName + ' — ' + reason.value, app.appId),
        async () => emp && sendTemplate('partner_declined_employee', await employeeNotifyEmail(emp), data, { appId: app.appId }),
        () => sendToAdmins('partner_declined_admin', data, { appId: app.appId }),
      ],
    };
  });
}
