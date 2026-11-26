import 'server-only';
import {
  PARTNER_STATUS, canEditOptions, count, paymentReference, fmvErrorMessage, inr, inr2, monthYear, num, prettyDate,
  price, round2, submitBlocker, taxDueDateFor, trim, validateDemat, validateExercisePaymentAmount,
  validateLines, validateMobile, validatePan, validatePaymentDate, validateSignature, validateTaxPaymentEntry,
  validateUtr, type LineRequest,
} from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { sendTemplate } from '@/lib/mail';
import type {
  ApplicationDoc, ApplicationLineDoc, EmployeeDoc, PartnerRequestDoc, TaxPaymentDoc, UserDoc,
} from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import {
  appRef, effectiveRate, getApplication, isPartnerRequestLive, lineRefsOf, linesCol, linesOf, newApplicationDoc, nextApplicationId,
  nextTaxSeq, progressOf, taxPaidTotal, taxPaymentsCol, taxPaymentsOf,
} from '../applications';
import { UserError, toActionResult, type ActionResult } from '../core/errors';
import { buildNoticeModel } from '../core/notice';
import { renderNoticePdf } from '../core/noticePdf';
import { AppWriter, repriceInto } from '../appWriter';
import { uid, type Tx } from '../db';
import { emailFor, employeeRef } from '../employees';
import { requireAttachable, saveGeneratedFile, supersede } from '../files';
import { priceForPayment } from '../fmv';
import { partnerLogins, partnerNotifyEmails, requireSelectablePartner } from '../partners';
import { partnerRequestOf, partnerRequestRef } from '../partnerRequests';
import { loadSettings, type Settings } from '../settings';
import { ensureWindow } from '../windows';
import {
  STALE_MESSAGE, assertEditable, assertMayAct, assertRev, balances, liveApp, loadState, priceOptions, requireActiveApp,
  type ParticipantState,
} from './state';

/* ================= plumbing ================= */

/** Which version of which application the page was showing. */
export interface Expect {
  appId: string;
  rev: number;
}

type Effect = () => Promise<unknown>;

interface Outcome {
  message: string;
  /** A refusal that still wrote something (legacy saveDemat: partial save, then the problems). */
  error?: string;
  appId?: string;
  effects: Effect[];
}

/**
 * Run one participant mutation: settings and the month's window first, then
 * a transaction that re-reads everything, re-checks every rule and writes.
 * Audit entries and emails run after the commit; their failure is logged and
 * never undoes the change.
 */
async function run(user: UserDoc, label: string, body: (tx: Tx, st: ParticipantState, now: string) => Promise<Outcome>): Promise<ActionResult> {
  try {
    if (user.role !== 'Employee') throw new UserError('This screen is for plan participants.');
    const settings = await loadSettings();
    const today = todayIst();
    await ensureWindow(today, settings.portal, user.userId);
    const out = await db().runTransaction(async (tx) => {
      const st = await loadState(user.userId, settings, today, tx);
      return body(tx, st, nowIso());
    });
    for (const effect of out.effects) {
      try { await effect(); } catch (e) { console.error(label + ': follow-up failed', e); }
    }
    if (out.error) return { ok: false, error: out.error };
    return { ok: true, message: out.message, appId: out.appId };
  } catch (e) {
    // Another tab created the same application (or line) first: the create lost the race.
    if ((e as { code?: unknown })?.code === 6) return { ok: false, error: STALE_MESSAGE };
    return toActionResult(e, label);
  }
}

const RESIGN_NOTE = ' Because the notice had already been signed, the signature has been cleared — sign it again in step 5.';

function notifyAddress(user: UserDoc, emp: EmployeeDoc): string {
  return trim(user.notifyEmail) || emailFor(emp);
}

function windowLabel(st: ParticipantState): string {
  return st.window?.label || monthYear(st.windowId + '-01');
}

/* ================= quote ================= */

export interface Quote {
  totalOptions: number;
  totalShares: number;
  exerciseAmount: number;
  perquisiteAmount: number;
  taxRatePercent: number;
  taxAmount: number;
  taxMethod: 'Sheet' | 'Flat' | 'None';
  taxEffectivePercent: number;
  taxBreakdown: unknown;
  fmv: number | null;
  fmvDate: string;
  fmvFixed: boolean;
  lines: { grantId: string; planName: string; multiplier: number; options: number; shares: number; lineExerciseAmount: number; linePerquisite: number }[];
}

/** EmployeeApi.quote: live figures for the options form, saving nothing. */
export async function quoteFor(user: UserDoc, lines: LineRequest[], latest: { fmv: number; date: string } | null):
  Promise<{ ok: true; quote: Quote } | { ok: false; error: string }> {
  try {
    const settings = await loadSettings();
    const st = await loadState(user.userId, settings, todayIst());
    const app = liveApp(st);
    const validated = validateLines(lines, balances(st, app ? app.appId : ''), settings.portal);
    if (!validated.ok) return { ok: false, error: validated.error };
    const fixed = !!app && app.fmvValue > 0;
    const source = fixed ? { fmv: app!.fmvValue, date: app!.fmvDate, fixed: true } : latest ? { ...latest, fixed: false } : null;
    const priced = price(validated.lines, source ? source.fmv : null, st.employee.taxRatePercent ?? 0,
      priceOptions(st, app ? app.appId : ''));
    return {
      ok: true,
      quote: {
        totalOptions: priced.totalOptions, totalShares: priced.totalShares, exerciseAmount: priced.exerciseAmount,
        perquisiteAmount: priced.perquisiteAmount, taxRatePercent: priced.taxRatePercent, taxAmount: priced.taxAmount,
        taxMethod: priced.taxMethod, taxEffectivePercent: priced.taxEffectivePercent, taxBreakdown: priced.taxBreakdown,
        fmv: source ? source.fmv : null, fmvDate: source ? source.date : '', fmvFixed: source ? source.fixed : false,
        lines: priced.lines.map((l) => ({
          grantId: l.grantId, planName: l.planName, multiplier: l.multiplier, options: l.options, shares: l.shares,
          lineExerciseAmount: l.lineExerciseAmount, linePerquisite: l.linePerquisite,
        })),
      },
    };
  } catch (e) {
    const r = toActionResult(e, 'quote');
    return { ok: false, error: r.ok ? '' : r.error };
  }
}

/* ================= 1. options ================= */

export function saveOptions(user: UserDoc, input: { expect: Expect; lines: LineRequest[]; silent?: boolean }): Promise<ActionResult> {
  return run(user, 'saveOptions', async (tx, st, now) => {
    assertMayAct(st);
    const live = liveApp(st);
    assertRev(live, input.expect);
    if (live) assertEditable(live);
    const isNew = !live;
    const base = live ?? newApplicationDoc({
      appId: nextApplicationId(st.apps, st.employee.employeeId, st.windowId),
      windowId: st.windowId, employee: st.employee, exercisePrice: st.settings.portal.exercisePrice,
      window: st.window, now,
    });
    // Reads first: the lines being replaced and the partner request.
    const oldLines = isNew ? [] : await lineRefsOf(base.appId, tx);
    const pr = isNew ? null : await partnerRequestOf(base.appId, tx);

    const w = new AppWriter(base, isNew);
    const editable = canEditOptions({
      fmvValue: base.fmvValue, exercisePaymentUTR: base.exercisePayment.utr,
      reviewExercisePayment: base.review.exercisePayment, appId: base.appId,
    });
    if (!editable.ok) throw new UserError(editable.error);
    if (editable.clearFmv) {
      // Cleared before pricing, so the new options are not valued at the old day's FMV.
      w.set('fmvValue', 0);
      w.set('fmvDate', '');
    }

    const validated = validateLines(input.lines, balances(st, base.appId), st.settings.portal);
    if (!validated.ok) throw new UserError(validated.error);
    const priced = price(validated.lines, w.doc.fmvValue || null, w.doc.taxRatePercent, priceOptions(st, base.appId));

    oldLines.forEach((ref) => tx.delete(ref));
    priced.lines.forEach((l) => {
      const ref = linesCol(base.appId).doc(uid('L-'));
      const line: ApplicationLineDoc = {
        lineId: ref.id, appId: base.appId, grantId: l.grantId, planName: l.planName, multiplier: l.multiplier,
        optionsExercised: l.options, sharesAllotted: l.shares, exercisePrice: l.exercisePrice,
        lineExerciseAmount: l.lineExerciseAmount, perquisitePerShare: l.perquisitePerShare,
        linePerquisite: l.linePerquisite, updatedAt: now,
      };
      tx.set(ref, line);
    });
    w.set('totalOptions', priced.totalOptions);
    w.set('totalShares', priced.totalShares);
    w.set('exerciseAmount', priced.exerciseAmount);
    w.set('perquisiteAmount', priced.perquisiteAmount);
    w.set('taxAmount', priced.taxAmount);
    w.set('taxMethod', priced.taxMethod);
    w.set('taxBreakdown', priced.taxBreakdown);
    w.touch('options');
    const resigned = w.clearSignatureFor('options', tx, now);
    w.write(tx, now);
    if (pr && pr.status === PARTNER_STATUS.ASSIGNED && pr.taxAmount !== priced.taxAmount) {
      tx.update(partnerRequestRef(pr.requestId), { taxAmount: priced.taxAmount });
    }

    const app = w.doc;
    const emp = st.employee;
    const repeat = st.apps.filter((a) => a.windowId === st.windowId && a.status === 'Approved').length;
    return {
      appId: app.appId,
      message: 'Saved. ' + count(priced.totalOptions) + ' options → ' + count(priced.totalShares) +
        ' equity shares; exercise amount payable is ' + inr(priced.exerciseAmount) + '.' + (resigned ? RESIGN_NOTE : ''),
      effects: [
        ...(isNew ? [() => audit(user.userId, 'Employee', 'APP_CREATED', st.windowId + (repeat ? ' (repeat after ' + repeat + ' approved)' : ''), app.appId)] : []),
        () => audit(user.userId, 'Employee', 'OPTIONS_SAVED',
          priced.totalOptions + ' options → ' + priced.totalShares + ' shares across ' + priced.lines.length + ' grant(s)', app.appId),
        ...(input.silent ? [] : [() => sendTemplate('options_saved', notifyAddress(user, emp), {
          name: emp.name, appId: app.appId, windowLabel: windowLabel(st), totalOptions: priced.totalOptions,
          totalShares: priced.totalShares, exerciseAmount: priced.exerciseAmount,
          paymentReference: paymentReference(st.settings.portal, emp),
        }, { appId: app.appId })]),
      ],
    };
  });
}

/* ================= 2. applicant, demat & PAN ================= */

export interface DematInputFields {
  designation: string;
  address: string;
  nationality: string;
  mobile: string;
  dematDPName: string;
  dematAccountName: string;
  dematDPId: string;
  dematClientId: string;
  dematAccountType: string;
  pan: string;
  cmlFileId: string;
  panFileId: string;
}

export function saveDemat(user: UserDoc, input: { expect: Expect; finalise: boolean; fields: DematInputFields }): Promise<ActionResult> {
  return run(user, 'saveDemat', async (tx, st, now) => {
    assertMayAct(st);
    const app = requireActiveApp(st);
    assertRev(app, input.expect);
    assertEditable(app);
    const f = input.fields;
    const emp = st.employee;
    const partnerHeld = !!app.dematSource;

    // Reads: the uploads being attached.
    const newCml = f.cmlFileId && f.cmlFileId !== app.cmlFileId && !partnerHeld
      ? await requireAttachable(f.cmlFileId, { ownerEmployeeId: emp.employeeId, appId: app.appId, purposes: ['cml'] }, tx) : null;
    const newPan = f.panFileId && f.panFileId !== app.panFileId
      ? await requireAttachable(f.panFileId, { ownerEmployeeId: emp.employeeId, appId: app.appId, purposes: ['pan'] }, tx) : null;

    const w = new AppWriter(app, false);
    const applicant = {
      ...app.applicant,
      designation: trim(f.designation), address: trim(f.address), nationality: trim(f.nationality),
      mobile: trim(f.mobile), pan: trim(f.pan).toUpperCase(),
    };
    // Once a fund partner has set the allotment account only they can change it.
    const demat = partnerHeld ? app.demat : {
      dpName: trim(f.dematDPName), accountName: trim(f.dematAccountName), dpId: trim(f.dematDPId).toUpperCase(),
      clientId: trim(f.dematClientId).toUpperCase(),
      accountType: (['NSDL', 'CDSL'].includes(trim(f.dematAccountType).toUpperCase()) ? trim(f.dematAccountType).toUpperCase() : '') as ApplicationDoc['demat']['accountType'],
    };
    const cmlFileId = newCml ? newCml.fileId : app.cmlFileId;
    const panFileId = newPan ? newPan.fileId : app.panFileId;

    const problems: string[] = [];
    if (input.finalise) {
      // pick(): what was entered, else what the master holds.
      if (!applicant.address) applicant.address = emp.address;
      if (applicant.address.length < 12) problems.push('Enter your full postal address — it appears on the exercise notice.');
      applicant.nationality = applicant.nationality || emp.nationality || 'Indian';
      const mob = validateMobile(applicant.mobile || emp.mobile);
      if (mob.ok) applicant.mobile = mob.value; else problems.push(mob.error);
      applicant.designation = applicant.designation || emp.designation;
      if (!applicant.designation) problems.push('Enter your designation.');
      const dm = validateDemat({
        dematDPName: demat.dpName, dematAccountName: demat.accountName, dematDPId: demat.dpId,
        dematClientId: demat.clientId, dematAccountType: demat.accountType || emp.demat.accountType,
      });
      if (dm.ok) {
        if (!partnerHeld) Object.assign(demat, { dpId: dm.value.dpId, clientId: dm.value.clientId, accountType: dm.value.accountType });
      } else problems.push(dm.error);
      const pan = validatePan(applicant.pan || emp.pan);
      if (pan.ok) applicant.pan = pan.value; else problems.push(pan.error);
      if (!cmlFileId) problems.push('Upload your client master report (CML) from your broker or depository participant.');
      if (!panFileId) problems.push('Upload a scan or photograph of your PAN card.');
    }

    w.set('applicant', applicant);
    w.set('demat', demat);
    if (newCml) {
      if (app.cmlFileId) supersede(tx, app.cmlFileId, now);
      w.set('cmlFileId', newCml.fileId);
    }
    if (newPan) {
      if (app.panFileId) supersede(tx, app.panFileId, now);
      w.set('panFileId', newPan.fileId);
    }

    if (problems.length) {
      // Whatever they supplied is kept; the section stays open.
      w.clearSignatureFor('demat', tx, now);
      w.write(tx, now);
      return {
        appId: app.appId, message: '', effects: [],
        error: problems.length === 1 ? problems[0] : 'These are still needed before this section can be submitted:\n• ' + problems.join('\n• '),
      };
    }

    w.touch('demat');
    const resigned = w.clearSignatureFor('demat', tx, now);
    w.write(tx, now);

    if (input.finalise) {
      // Carry the confirmed details back to the master, pre-filled next window.
      const empPatch: Record<string, unknown> = {};
      if (applicant.pan && emp.pan !== applicant.pan) empPatch.pan = applicant.pan;
      if (applicant.address && emp.address !== applicant.address) empPatch.address = applicant.address;
      if (applicant.mobile && emp.mobile !== applicant.mobile) empPatch.mobile = applicant.mobile;
      if (applicant.nationality && emp.nationality !== applicant.nationality) empPatch.nationality = applicant.nationality;
      if (!partnerHeld) {
        const merged = { ...emp.demat };
        let changed = false;
        (['dpName', 'dpId', 'clientId', 'accountName', 'accountType'] as const).forEach((k) => {
          if (demat[k] && emp.demat[k] !== demat[k]) { (merged as Record<string, string>)[k] = demat[k]; changed = true; }
        });
        if (changed) empPatch.demat = merged;
      }
      if (Object.keys(empPatch).length) tx.set(employeeRef(emp.employeeId), { ...empPatch, updatedAt: now }, { merge: true });
    }

    return {
      appId: app.appId,
      message: (input.finalise
        ? 'Details submitted. Shares will be credited to this demat account, so check the identifiers once more.'
        : 'Saved. You can come back and finish this section later.') + (resigned ? RESIGN_NOTE : ''),
      effects: [
        () => audit(user.userId, 'Employee', input.finalise ? 'DEMAT_SUBMITTED' : 'DEMAT_SAVED', '', app.appId),
        ...(input.finalise ? [() => sendTemplate('demat_saved', notifyAddress(user, emp), {
          name: emp.name, appId: app.appId, dpName: demat.dpName, dpId: demat.dpId, clientId: demat.clientId, pan: applicant.pan,
        }, { appId: app.appId })] : []),
      ],
    };
  });
}

/* ================= 3. exercise payment ================= */

export interface ExerciseInputFields {
  utr: string;
  paymentDate: string;
  amount: string;
  bank: string;
  proofFileId: string;
}

export function saveExercisePayment(user: UserDoc, input: { expect: Expect; finalise: boolean; fields: ExerciseInputFields }): Promise<ActionResult> {
  return run(user, 'saveExercisePayment', async (tx, st, now) => {
    assertMayAct(st);
    const app = requireActiveApp(st);
    assertRev(app, input.expect);
    assertEditable(app);
    if (app.totalOptions <= 0) throw new UserError('Record the options you wish to exercise before entering the payment.');
    const f = input.fields;
    const emp = st.employee;
    const settings = st.settings;

    // Reads.
    const proof = f.proofFileId && f.proofFileId !== app.exercisePayment.proofFileId
      ? await requireAttachable(f.proofFileId, { ownerEmployeeId: emp.employeeId, appId: app.appId, purposes: ['exerciseProof'] }, tx) : null;
    let pinned: { date: string; fmvDate: string; fmv: number } | null = null;
    if (trim(f.paymentDate)) {
      const paid = validatePaymentDate(f.paymentDate, 'exercise payment', st.today);
      if (!paid.ok) throw new UserError(paid.error);
      const fmv = await priceForPayment(paid.value, settings.holidays, tx);
      if (!fmv.ok) {
        // AGREED CHANGE: no fallback to an older price. Nothing is saved; the ESOP team is told.
        const missing = fmv.reason === 'PRICE_MISSING' ? fmv.date : '';
        return {
          message: '', error: fmvErrorMessage(fmv), effects: missing && settings.adminEmails.length ? [
            () => sendTemplate('price_load_failed', settings.adminEmails.join(','), {
              detail: 'No price is on record for ' + prettyDate(missing) + ', the trading day before an exercise payment dated ' +
                prettyDate(paid.value) + ' (' + app.appId + '). The participant cannot record the payment until it is entered.',
              date: missing, appId: app.appId,
            }, { appId: app.appId, dedupeKey: 'price-missing-' + missing }),
          ] : [],
        };
      }
      pinned = { date: paid.value, fmvDate: fmv.date, fmv: fmv.fmv };
    }
    const lines = pinned ? await linesOf(app.appId, tx) : [];
    const pr = pinned ? await partnerRequestOf(app.appId, tx) : null;

    const w = new AppWriter(app, false);
    const ex = {
      ...app.exercisePayment,
      utr: trim(f.utr).toUpperCase(),
      bank: trim(f.bank),
      amount: num(f.amount, 0),
      ...(proof ? { proofFileId: proof.fileId } : {}),
      ...(pinned ? { date: pinned.date } : {}),
    };

    if (input.finalise) {
      const utr = validateUtr(ex.utr);
      if (!utr.ok) throw new UserError(utr.error);
      ex.utr = utr.value;
      if (!ex.date) throw new UserError('Enter the date on which you transferred the exercise amount.');
      if (!ex.proofFileId) throw new UserError('Upload the payment advice or bank statement showing this transfer.');
      const amt = validateExercisePaymentAmount(ex.amount, app.exerciseAmount);
      if (!amt.ok) throw new UserError(amt.error);
      ex.amount = amt.value;
    }

    if (proof && app.exercisePayment.proofFileId) supersede(tx, app.exercisePayment.proofFileId, now);
    w.set('exercisePayment', ex);

    if (pinned) {
      // Saving the date fixes the FMV, and so the perquisite, the tax and its due date.
      w.set('fmvDate', pinned.fmvDate);
      w.set('fmvValue', pinned.fmv);
      w.set('taxDueDate', taxDueDateFor(pinned.date, settings.portal));
      repriceInto(w, { grants: st.grants, defaultExercisePrice: settings.portal.exercisePrice, priceOptions: priceOptions(st, app.appId) }, lines, tx, now);
      if (pr && pr.status === PARTNER_STATUS.ASSIGNED && pr.taxAmount !== w.doc.taxAmount) {
        tx.update(partnerRequestRef(pr.requestId), { taxAmount: w.doc.taxAmount });
      }
    }
    w.touch('exercisePayment');
    const resigned = w.clearSignatureFor('exercisePayment', tx, now);
    w.write(tx, now);

    const a = w.doc;
    return {
      appId: a.appId,
      message: (pinned
        ? 'Saved. FMV of ' + inr2(a.fmvValue) + ' applied from ' + prettyDate(a.fmvDate) + ' — perquisite ' +
          inr(a.perquisiteAmount) + ' on ' + count(a.totalShares) + ' shares, tax payable ' + inr(a.taxAmount) +
          ' by ' + prettyDate(a.taxDueDate) + '.'
        : 'Saved.') + (resigned ? RESIGN_NOTE : ''),
      effects: [
        () => audit(user.userId, 'Employee', input.finalise ? 'EXERCISE_PAYMENT_SUBMITTED' : 'EXERCISE_PAYMENT_SAVED',
          'utr ' + a.exercisePayment.utr + ' fmv ' + a.fmvValue, a.appId),
        ...(input.finalise ? [() => sendTemplate('exercise_payment_received', notifyAddress(user, emp), {
          name: emp.name, appId: a.appId, totalOptions: a.totalOptions, totalShares: a.totalShares,
          exerciseAmount: a.exerciseAmount, utr: a.exercisePayment.utr, paymentDate: prettyDate(a.exercisePayment.date),
          fmvDate: prettyDate(a.fmvDate), fmv: a.fmvValue, perquisite: a.perquisiteAmount, taxRate: effectiveRate(a),
          tax: a.taxAmount, taxDueDate: prettyDate(a.taxDueDate),
        }, { appId: a.appId })] : []),
      ],
    };
  });
}

/* ================= 4. tax ================= */

export function chooseTaxMode(user: UserDoc, input: { expect: Expect; mode: string; partnerId: string }): Promise<ActionResult> {
  return run(user, 'chooseTaxMode', async (tx, st, now) => {
    assertMayAct(st);
    const app = requireActiveApp(st);
    assertRev(app, input.expect);
    assertEditable(app);
    if (app.taxAmount <= 0) {
      throw new UserError('Your tax amount is not fixed yet. Record the exercise payment first — the FMV depends on its date.');
    }
    const mode = trim(input.mode);
    if (mode !== 'Self' && mode !== 'FundPartner') throw new UserError('Choose how the tax will be paid.');
    const emp = st.employee;

    // Reads.
    const pr = await partnerRequestOf(app.appId, tx);
    const payments = await taxPaymentsOf(app.appId, tx);
    const partner = mode === 'FundPartner' ? await requireSelectablePartner(input.partnerId, tx) : null;
    const logins = partner ? await partnerLogins(partner.partnerId, tx) : [];

    const partnerPaid = !!pr && ([PARTNER_STATUS.PAID, PARTNER_STATUS.VERIFIED, PARTNER_STATUS.SENT_BACK] as string[]).includes(pr.status);
    const w = new AppWriter(app, false);

    if (mode === 'Self') {
      // FIX (review item 13): once the partner has recorded a payment the route cannot silently change.
      if (partnerPaid) {
        throw new UserError(pr!.fundPartnerName + ' has already recorded a payment against this application, so the ' +
          'route cannot be changed here. Write to the ESOP team if it has to change.');
      }
      w.set('taxMode', 'Self');
      w.set('fundPartnerId', '');
      w.set('fundPartnerName', '');
      if (pr && pr.status === PARTNER_STATUS.ASSIGNED) {
        tx.update(partnerRequestRef(pr.requestId), {
          status: PARTNER_STATUS.WITHDRAWN, remarks: 'Participant chose to pay the tax directly on ' + prettyDate(st.today),
        });
      }
      // Paying it themselves means their own demat account again.
      restoreOwnDemat(w, pr, emp);
      w.touch('taxPayment');
      const resigned = w.clearSignatureFor('taxPayment', tx, now);
      w.write(tx, now);
      return {
        appId: app.appId,
        message: 'You will pay the tax directly. Transfer ' + inr(app.taxAmount) +
          ' and upload the UTR and payment date below by ' + prettyDate(app.taxDueDate) + '.' + (resigned ? RESIGN_NOTE : ''),
        effects: [() => audit(user.userId, 'Employee', 'TAX_MODE_SELF', '', app.appId)],
      };
    }

    const p = partner!;
    const selfPaid = payments.filter((x) => x.paidBy === 'Self');
    if (selfPaid.length) {
      throw new UserError('You have already recorded ' + selfPaid.length + ' tax payment' + (selfPaid.length === 1 ? '' : 's') +
        ' yourself. Remove ' + (selfPaid.length === 1 ? 'it' : 'them') + ' first if a fund partner is to pay instead.');
    }
    if (partnerPaid) {
      throw new UserError(pr!.fundPartnerName + ' has already recorded a payment against this application, so the ' +
        'route cannot be changed here. Write to the ESOP team if it has to change.');
    }
    // Checked before anything is written: without a login nobody can act on the request.
    if (!logins.length) {
      throw new UserError(p.name + ' is not set up in the portal yet, so they cannot act on this. ' +
        'Please contact the ESOP team, or choose to pay the tax yourself for now.');
    }

    w.set('taxMode', 'FundPartner');
    w.set('fundPartnerId', p.partnerId);
    w.set('fundPartnerName', p.name);
    const reuse = pr && pr.status === PARTNER_STATUS.ASSIGNED ? pr : null;
    const requestId = reuse ? reuse.requestId : uid('FP-');
    // A different partner: whatever account the previous one set no longer applies.
    if (!reuse || reuse.fundPartnerId !== p.partnerId) restoreOwnDemat(w, pr, emp);
    if (reuse) {
      const switched = reuse.fundPartnerId !== p.partnerId;
      tx.update(partnerRequestRef(requestId), {
        fundPartnerId: p.partnerId, fundPartnerName: p.name, taxAmount: app.taxAmount,
        status: PARTNER_STATUS.ASSIGNED, assignedAt: now, remarks: '',
        ...(switched ? {
          partnerDemat: { dpName: '', dpId: '', clientId: '', accountName: '', accountType: '', cmlFileId: '', providedBy: '', providedAt: '' },
          employeeDemat: null,
        } : {}),
      });
    } else {
      const doc: PartnerRequestDoc = {
        requestId, appId: app.appId, employeeId: emp.employeeId, fundPartnerId: p.partnerId, fundPartnerName: p.name,
        taxAmount: app.taxAmount, status: PARTNER_STATUS.ASSIGNED, assignedAt: now,
        payment: { utr: '', date: '', amount: 0, bank: '', proofFileId: '' }, fedBy: '', fedAt: '', remarks: '',
        partnerDemat: { dpName: '', dpId: '', clientId: '', accountName: '', accountType: '', cmlFileId: '', providedBy: '', providedAt: '' },
        employeeDemat: null,
      };
      tx.create(partnerRequestRef(requestId), doc);
    }
    w.touch('taxPayment');
    const resigned = w.clearSignatureFor('taxPayment', tx, now);
    w.write(tx, now);

    const notify = partnerNotifyEmails(p, logins);
    return {
      appId: app.appId,
      message: p.name + ' has been notified and will enter the demat account and payment details. ' +
        'You will be emailed when they do.' + (resigned ? RESIGN_NOTE : ''),
      effects: [
        () => audit(user.userId, 'Employee', 'TAX_MODE_PARTNER', p.name + ' (' + requestId + ')', app.appId),
        () => sendTemplate('partner_assigned_employee', notifyAddress(user, emp), {
          name: emp.name, appId: app.appId, partner: p.name, tax: app.taxAmount, taxDueDate: prettyDate(app.taxDueDate),
        }, { appId: app.appId }),
        ...(notify.length ? [() => sendTemplate('partner_assigned_partner', notify.join(','), {
          partner: p.name, requestId, appId: app.appId, employeeName: emp.name, employeeId: emp.employeeId,
          totalOptions: app.totalOptions, totalShares: app.totalShares, perquisite: app.perquisiteAmount,
          tax: app.taxAmount, taxDueDate: prettyDate(app.taxDueDate),
        }, { appId: app.appId })] : []),
      ],
    };
  });
}

/**
 * The shares go to the participant's own account again: put back what a
 * partner's account displaced (the snapshot on the request, else the master).
 * The CML has to be attached again if there is no snapshot of it.
 */
function restoreOwnDemat(w: AppWriter, pr: PartnerRequestDoc | null, emp: EmployeeDoc): void {
  if (!w.doc.dematSource) return;
  const own = pr?.employeeDemat ?? null;
  const d = own ?? emp.demat;
  w.set('dematSource', '');
  w.set('demat', { dpName: d.dpName, dpId: d.dpId, clientId: d.clientId, accountName: d.accountName, accountType: d.accountType });
  w.set('cmlFileId', own ? own.cmlFileId : '');
  w.touch('demat');
}

export interface TaxPaymentFields {
  utr: string;
  paymentDate: string;
  amount: string;
  bank: string;
  proofFileId: string;
}

/** One tax remittance; the tax may be paid in instalments, each with its own UTR and proof. */
export function addTaxPayment(user: UserDoc, input: { expect: Expect; fields: TaxPaymentFields }): Promise<ActionResult> {
  return run(user, 'addTaxPayment', async (tx, st, now) => {
    assertMayAct(st);
    const app = requireActiveApp(st);
    assertRev(app, input.expect);
    assertEditable(app);
    if (app.taxMode !== 'Self') {
      throw new UserError('You have chosen to route the tax through ' + (app.fundPartnerName || 'a fund partner') +
        '. Switch to paying it yourself if you would rather record your own payments.');
    }
    const due = app.taxAmount;
    if (due <= 0) throw new UserError('Your tax amount is not fixed yet. Record the exercise payment first.');
    const f = input.fields;
    const emp = st.employee;

    const utr = validateUtr(f.utr);
    if (!utr.ok) throw new UserError(utr.error);
    const paidOn = validatePaymentDate(f.paymentDate, 'tax payment', st.today);
    if (!paidOn.ok) throw new UserError(paidOn.error);

    // Reads.
    const payments = await taxPaymentsOf(app.appId, tx);
    const entry = validateTaxPaymentEntry({
      due, alreadyPaid: taxPaidTotal(payments), amount: f.amount, utr: utr.value,
      existing: payments.map((p) => ({ utr: p.utr, amount: p.amount, paymentDate: p.paymentDate })),
    });
    if (!entry.ok) throw new UserError(entry.error);
    if (!trim(f.proofFileId)) throw new UserError('Upload the payment advice or bank statement for this transfer.');
    const proof = await requireAttachable(f.proofFileId, { ownerEmployeeId: emp.employeeId, appId: app.appId, purposes: ['taxProof'] }, tx);

    const seq = nextTaxSeq(payments);
    const ref = taxPaymentsCol(app.appId).doc(uid('TP-'));
    const row: TaxPaymentDoc = {
      paymentId: ref.id, appId: app.appId, employeeId: emp.employeeId, seq, paidBy: 'Self', fundPartnerName: '',
      utr: utr.value, paymentDate: paidOn.value, amount: entry.value.amount, bank: trim(f.bank),
      proofFileId: proof.fileId, enteredBy: user.userId, enteredAt: now, remarks: '',
    };
    tx.create(ref, row);

    const total = round2(taxPaidTotal(payments) + row.amount);
    const countNow = payments.length + 1;
    const w = new AppWriter(app, false);
    w.set('taxPaidAmount', total);
    w.set('taxPaymentCount', countNow);
    w.touch('taxPayment');
    // A late payment is recorded, not refused — the ESOP team has to be able to see it was late.
    if (app.taxDueDate && paidOn.value > app.taxDueDate) {
      w.set('adminRemarks', [...app.adminRemarks, {
        at: now, by: 'system', section: 'taxPayment',
        text: 'Tax entry ' + seq + ' of ' + inr(row.amount) + ' paid ' + prettyDate(paidOn.value) +
          ', after the due date of ' + prettyDate(app.taxDueDate) + '.',
      }]);
    }
    const resigned = w.clearSignatureFor('taxPayment', tx, now);
    w.write(tx, now);

    const settled = total + 1 >= due;
    return {
      appId: app.appId,
      message: (settled
        ? 'Tax fully recorded — ' + inr(total) + ' across ' + countNow + ' payment' + (countNow === 1 ? '' : 's') +
          '. Next: sign the exercise notice.'
        : inr(row.amount) + ' recorded. ' + inr(Math.max(0, due - total)) + ' of ' + inr(due) + ' still to pay.') +
        (resigned ? RESIGN_NOTE : ''),
      effects: [
        () => audit(user.userId, 'Employee', 'TAX_PAYMENT_ADDED',
          'entry ' + seq + ' utr ' + row.utr + ' ' + inr(row.amount) + ' (total ' + inr(total) + ' of ' + inr(due) + ')', app.appId),
        ...(settled ? [() => sendTemplate('tax_payment_received', notifyAddress(user, emp), {
          name: emp.name, appId: app.appId, amount: total, utr: countNow > 1 ? countNow + ' payments' : row.utr,
          paymentDate: prettyDate(row.paymentDate),
        }, { appId: app.appId })] : []),
      ],
    };
  });
}

/** Remove a tax entry keyed wrongly, until the ESOP team has verified the section. */
export function deleteTaxPayment(user: UserDoc, input: { expect: Expect; paymentId: string }): Promise<ActionResult> {
  return run(user, 'deleteTaxPayment', async (tx, st, now) => {
    assertMayAct(st);
    const app = requireActiveApp(st);
    assertRev(app, input.expect);
    assertEditable(app);
    if (app.review.taxPayment === 'Verified') {
      throw new UserError('The ESOP team has already verified your tax payments, so they can no longer be changed.');
    }
    const payments = await taxPaymentsOf(app.appId, tx);
    const row = payments.find((p) => p.paymentId === trim(input.paymentId));
    if (!row) throw new UserError('That tax payment is not on this application.');
    if (row.paidBy !== 'Self') {
      throw new UserError('That payment was recorded by ' + (row.fundPartnerName || 'a fund partner') + ', so only the ESOP team can change it.');
    }
    tx.delete(taxPaymentsCol(app.appId).doc(row.paymentId));
    // The proof is kept for the audit trail, marked as no longer in use.
    if (row.proofFileId) supersede(tx, row.proofFileId, now);
    const rest = payments.filter((p) => p.paymentId !== row.paymentId);
    const total = taxPaidTotal(rest);
    const w = new AppWriter(app, false);
    w.set('taxPaidAmount', total);
    w.set('taxPaymentCount', rest.length);
    w.touch('taxPayment');
    const resigned = w.clearSignatureFor('taxPayment', tx, now);
    w.write(tx, now);
    return {
      appId: app.appId,
      message: 'Removed. ' + inr(Math.max(0, app.taxAmount - total)) + ' of ' + inr(app.taxAmount) + ' still to pay.' +
        (resigned ? RESIGN_NOTE : ''),
      effects: [() => audit(user.userId, 'Employee', 'TAX_PAYMENT_REMOVED', 'utr ' + row.utr + ' ' + inr(row.amount), app.appId)],
    };
  });
}

/* ================= 5. notice ================= */

export function signNotice(user: UserDoc, input: { expect: Expect; signatureName: string; place: string; accepted: boolean }): Promise<ActionResult> {
  return run(user, 'signNotice', async (tx, st, now) => {
    assertMayAct(st);
    const app = liveApp(st);
    if (!app) throw new UserError('Start an application first.');
    assertRev(app, input.expect);
    assertEditable(app);
    const emp = st.employee;
    const lines = await linesOf(app.appId, tx);
    if (!lines.length) throw new UserError('Record the options you wish to exercise before signing.');
    const payments = await taxPaymentsOf(app.appId, tx);
    const pr = await partnerRequestOf(app.appId, tx);
    const prog = progressOf(app, taxPaidTotal(payments), pr ? pr.status : null);
    if (!prog.done.demat) {
      throw new UserError('Complete your applicant, demat and PAN details before signing — they appear in section A of the notice.');
    }
    if (!prog.done.exercise) {
      throw new UserError('Record the exercise payment before signing — the notice states the amount paid and its UTR.');
    }
    const sig = validateSignature({ accepted: input.accepted, place: input.place, signatureName: input.signatureName, expectedName: emp.name });
    if (!sig.ok) throw new UserError(sig.error);

    const w = new AppWriter(app, false);
    if (app.notice.fileId) supersede(tx, app.notice.fileId, now);
    w.set('notice', { signatureName: sig.value.signatureName, signedAt: now, place: sig.value.place, fileId: '' });
    w.touch('notice');
    w.write(tx, now);

    const signed = w.doc;
    return {
      appId: app.appId,
      message: 'Notice signed and filed. A copy has been emailed to you.',
      effects: [
        () => audit(user.userId, 'Employee', 'NOTICE_SIGNED', 'as "' + sig.value.signatureName + '" at ' + sig.value.place, app.appId),
        async () => {
          let pdfFileId = '';
          try {
            pdfFileId = await fileNoticePdf({ app: signed, employee: emp, lines, st, uploadedBy: user.userId });
          } catch (e) {
            console.error('notice pdf failed for ' + app.appId, e);
          }
          await sendTemplate('notice_signed', notifyAddress(user, emp), {
            name: emp.name, appId: app.appId, signatureName: sig.value.signatureName, signedAt: now,
            totalOptions: signed.totalOptions, totalShares: signed.totalShares, attachFileIds: pdfFileId ? [pdfFileId] : [],
          }, { appId: app.appId });
        },
      ],
    };
  });
}

/**
 * Render the signed notice to PDF, store it, and record it on the
 * application — only if the signature it shows is still the current one.
 */
async function fileNoticePdf(input: {
  app: ApplicationDoc; employee: EmployeeDoc; lines: ApplicationLineDoc[]; st: ParticipantState; uploadedBy: string;
}): Promise<string> {
  const { app, st } = input;
  const model = buildNoticeModel({
    app, employee: input.employee, email: emailFor(input.employee), lines: input.lines, grants: st.grants,
    windowLabel: windowLabel(st), settings: st.settings, today: st.today,
  });
  const bytes = await renderNoticePdf(model);
  const file = await saveGeneratedFile({
    ownerEmployeeId: app.employeeId, appId: app.appId, purpose: 'notice', bytes, contentType: 'application/pdf',
    name: 'Exercise Notice — ' + app.appId + '.pdf', uploadedBy: input.uploadedBy,
  });
  await recordNoticeFile(app.appId, app.notice.signedAt, file.fileId);
  return file.fileId;
}

/** Attach a generated notice PDF unless the application was re-signed or unsigned meanwhile. */
export async function recordNoticeFile(appId: string, signedAt: string, fileId: string): Promise<boolean> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(appRef(appId));
    const cur = snap.data() as ApplicationDoc | undefined;
    const now = nowIso();
    if (!cur || cur.notice?.signedAt !== signedAt) {
      supersede(tx, fileId, now);
      return false;
    }
    tx.update(appRef(appId), { 'notice.fileId': fileId, rev: (Number(cur.rev) || 0) + 1, updatedAt: now });
    return true;
  });
}

/**
 * Re-create the notice PDF for an application already signed (for the admin
 * portal, or when the PDF failed at signing).
 */
export async function regenerateNoticePdf(appId: string, actor: string, settings?: Settings): Promise<string> {
  const app = await getApplication(appId);
  if (!app || !app.notice.signedAt) throw new UserError('That application has not been signed.');
  const s = settings ?? (await loadSettings());
  const st = await loadState(app.employeeId, s, todayIst());
  const lines = await linesOf(appId);
  return fileNoticePdf({ app, employee: st.employee, lines, st, uploadedBy: actor });
}

/* ================= 6. submit ================= */

export function submitApplication(user: UserDoc, input: { expect: Expect }): Promise<ActionResult> {
  return run(user, 'submit', async (tx, st, now) => {
    assertMayAct(st);
    const app = liveApp(st);
    if (!app) throw new UserError('There is nothing to submit yet.');
    assertRev(app, input.expect);
    assertEditable(app);
    const payments = await taxPaymentsOf(app.appId, tx);
    const pr = await partnerRequestOf(app.appId, tx);
    const lines = await linesOf(app.appId, tx);
    const blocker = submitBlocker(progressOf(app, taxPaidTotal(payments), pr ? pr.status : null), app.review);
    if (blocker) throw new UserError(blocker);
    // Re-validate against live balances: the vesting report may have been re-synced meanwhile.
    const check = validateLines(lines.map((l) => ({ grantId: l.grantId, options: l.optionsExercised })),
      balances(st, app.appId), st.settings.portal);
    if (!check.ok) throw new UserError(check.error);

    const w = new AppWriter(app, false);
    w.set('status', 'Submitted');
    w.set('submittedAt', now);
    // AGREED CHANGE: perquisite and tax are frozen from here; only an explicit admin reprice changes them.
    w.set('taxFrozenAt', now);
    w.write(tx, now);

    const emp = st.employee;
    const payload = {
      name: emp.name, employeeName: emp.name, employeeId: emp.employeeId, appId: app.appId, windowLabel: windowLabel(st),
      totalOptions: app.totalOptions, totalShares: app.totalShares, exerciseAmount: app.exerciseAmount,
      perquisite: app.perquisiteAmount, tax: app.taxAmount,
      taxMode: app.taxMode === 'FundPartner' ? app.fundPartnerName : 'Paid directly by the participant',
      partnerRequestLive: isPartnerRequestLive(pr),
    };
    const admins = st.settings.adminEmails;
    return {
      appId: app.appId,
      message: 'Application submitted for verification. You will be emailed once the ESOP team has reviewed it.',
      effects: [
        () => audit(user.userId, 'Employee', 'APP_SUBMITTED', app.totalOptions + ' options / ' + app.totalShares + ' shares', app.appId),
        () => sendTemplate('application_submitted_employee', notifyAddress(user, emp), payload, { appId: app.appId }),
        ...(admins.length ? [() => sendTemplate('application_submitted_admin', admins.join(','), payload, { appId: app.appId })] : []),
      ],
    };
  });
}
