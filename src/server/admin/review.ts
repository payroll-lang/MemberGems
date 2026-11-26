import 'server-only';
import { PARTNER_STATUS, STATUS, canAutoReprice, canSendBack, inr, num, prettyDate, trim } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { sendTemplate } from '@/lib/mail';
import { COL, type ApplicationDoc, type FmvDoc, type PartnerRequestDoc, type SectionKey, type UserDoc } from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { getApplication, linesOf, progressOf, taxPaidTotal, taxPaymentsOf } from '../applications';
import { AppWriter, repriceInto } from '../appWriter';
import { SECTION_KEYS } from '../core/applications';
import { UserError, type ActionResult } from '../core/errors';
import { assertRev } from '../core/guards';
import { getDoc, type Tx } from '../db';
import { getEmployee } from '../employees';
import { partnerRequestOf, partnerRequestRef } from '../partnerRequests';
import { loadState, priceOptions } from '../participant/state';
import { loadSettings, type Settings } from '../settings';
import { SECTION_LABEL, SECTION_DONE, assertReviewable, isSectionKey, isVerdict, labels, unverifiedSections } from './core/review';
import { inTx, participantAddress, runAdmin, type Effect, type Expect, type Outcome } from './run';

/**
 * The ESOP team's decisions on one application (AdminApi reviewSection,
 * reviewMany, approve, sendBack, reject), plus the explicit reprice. Each is
 * one transaction that re-reads the application, checks the page was showing
 * the current version, re-checks the rule, writes, and raises `rev`.
 */

interface AppCtx {
  tx: Tx;
  app: ApplicationDoc;
  pr: PartnerRequestDoc | null;
  paid: number;
  now: string;
}

function withApp(user: UserDoc, label: string, expect: Expect, body: (c: AppCtx) => Promise<Outcome>): Promise<ActionResult> {
  return runAdmin(user, label, () => inTx(async (tx) => {
    const app = await getApplication(expect.appId, tx);
    if (!app) throw new UserError('Application ' + trim(expect.appId) + ' was not found.');
    assertRev(app, expect);
    const pr = await partnerRequestOf(app.appId, tx);
    const payments = await taxPaymentsOf(app.appId, tx);
    return body({ tx, app, pr, paid: taxPaidTotal(payments), now: nowIso() });
  }));
}

function appendRemark(app: ApplicationDoc, by: string, at: string, text: string, section?: SectionKey): ApplicationDoc['adminRemarks'] {
  return [...app.adminRemarks, { at, by, text, ...(section ? { section } : {}) }];
}

function prStatusPatch(pr: PartnerRequestDoc | null, app: ApplicationDoc, section: SectionKey, verdict: string, remarks: string):
  Record<string, unknown> | null {
  if (!pr || section !== 'taxPayment' || app.taxMode !== 'FundPartner') return null;
  if (pr.status === PARTNER_STATUS.DECLINED || pr.status === PARTNER_STATUS.WITHDRAWN) return null;
  if (verdict === 'Sent Back') return { status: PARTNER_STATUS.SENT_BACK, remarks: remarks || 'Sent back by the ESOP team for correction' };
  if (verdict === 'Verified') return { status: PARTNER_STATUS.VERIFIED };
  // Reopened: a verified payment is back to "fed", waiting on the team again.
  if (verdict === 'Pending' && pr.status === PARTNER_STATUS.VERIFIED) return { status: PARTNER_STATUS.PAID };
  return null;
}

/* ================= opening the file ================= */

/**
 * AdminApi.detail's side effect, kept and audited: opening a Submitted
 * application puts it Under Review, so the participant and the other
 * reviewers can see someone has it.
 */
export async function openForReview(user: UserDoc, appId: string): Promise<boolean> {
  if (user.role !== 'Admin') return false;
  const changed = await inTx(async (tx) => {
    const app = await getApplication(appId, tx);
    if (!app || app.status !== STATUS.SUBMITTED) return false;
    const w = new AppWriter(app, false);
    w.set('status', 'Under Review');
    w.set('reviewedBy', user.userId);
    w.write(tx, nowIso());
    return true;
  });
  if (changed) await audit(user.userId, 'Admin', 'REVIEW_OPENED', '', appId);
  return changed;
}

/* ================= one section ================= */

export function reviewSection(user: UserDoc, input: { expect: Expect; section: string; verdict: string; remarks: string }): Promise<ActionResult> {
  return withApp(user, 'reviewSection', input.expect, async ({ tx, app, pr, paid, now }) => {
    const section = input.section;
    const verdict = input.verdict;
    if (!isSectionKey(section)) throw new UserError('Unknown section "' + section + '".');
    if (!isVerdict(verdict)) throw new UserError('Unknown verdict "' + verdict + '".');
    assertReviewable(app);
    const remarks = trim(input.remarks);
    const prog = progressOf(app, paid, pr ? pr.status : null);
    if (verdict !== 'Pending' && !prog.done[SECTION_DONE[section]]) {
      throw new UserError(SECTION_LABEL[section] + ' has not been completed by the participant, so there is nothing to ' +
        (verdict === 'Verified' ? 'verify' : 'send back') + '.');
    }
    if (verdict === 'Sent Back' && !remarks) {
      throw new UserError('Say what needs correcting in ' + SECTION_LABEL[section].toLowerCase() + ' — the participant sees these remarks.');
    }
    if (app.review[section] === verdict && !remarks) {
      throw new UserError(SECTION_LABEL[section] + ' is already ' + verdict.toLowerCase() + '.');
    }
    const w = new AppWriter(app, false);
    w.set('review', { ...app.review, [section]: verdict });
    w.set('reviewedBy', user.userId);
    w.set('reviewedAt', now);
    if (remarks) w.set('adminRemarks', appendRemark(app, user.userId, now, remarks, section));
    w.write(tx, now);
    const prPatch = prStatusPatch(pr, app, section, verdict, remarks);
    if (pr && prPatch) tx.update(partnerRequestRef(pr.requestId), prPatch);

    const action = 'SECTION_' + verdict.toUpperCase().replace(/\s+/g, '_');
    return {
      appId: app.appId,
      message: SECTION_LABEL[section] + ' marked ' + (verdict === 'Pending' ? 'pending (reopened)' : verdict.toLowerCase()) + '.' +
        (prPatch ? ' The fund partner’s request is now ' + String(prPatch.status).toLowerCase() + '.' : ''),
      effects: [() => audit(user.userId, 'Admin', action, section + (remarks ? ' — ' + remarks : ''), app.appId)],
    };
  });
}

/** reviewMany: verify the chosen sections, or every one still to verify. Verify-only by design. */
export function verifySections(user: UserDoc, input: { expect: Expect; sections: string[]; all: boolean; remarks: string }): Promise<ActionResult> {
  return withApp(user, 'verifySections', input.expect, async ({ tx, app, pr, paid, now }) => {
    assertReviewable(app);
    const done = progressOf(app, paid, pr ? pr.status : null).done;
    const wanted = input.all ? SECTION_KEYS : input.sections.map(trim).filter(Boolean);
    const unknown = wanted.filter((k) => !isSectionKey(k));
    if (unknown.length) throw new UserError('Unknown section "' + unknown[0] + '".');
    const keys = wanted as SectionKey[];
    const empty = keys.filter((k) => !done[SECTION_DONE[k]]);
    if (empty.length && !input.all) throw new UserError('Not completed by the participant, so nothing to verify: ' + labels(empty) + '.');
    const todo = keys.filter((k) => done[SECTION_DONE[k]] && app.review[k] !== 'Verified');
    if (!todo.length) throw new UserError(keys.length ? 'Those sections are already verified.' : 'Choose at least one section to verify.');

    const review = { ...app.review };
    todo.forEach((k) => { review[k] = 'Verified'; });
    const remarks = trim(input.remarks);
    const w = new AppWriter(app, false);
    w.set('review', review);
    w.set('reviewedBy', user.userId);
    w.set('reviewedAt', now);
    if (remarks) w.set('adminRemarks', appendRemark(app, user.userId, now, remarks));
    w.write(tx, now);
    const prPatch = todo.includes('taxPayment') ? prStatusPatch(pr, app, 'taxPayment', 'Verified', '') : null;
    if (pr && prPatch) tx.update(partnerRequestRef(pr.requestId), prPatch);

    const left = unverifiedSections(review);
    return {
      appId: app.appId,
      message: todo.length + ' section' + (todo.length === 1 ? '' : 's') + ' verified' +
        (left.length ? '. Still to verify: ' + labels(left) + '.' : '. Every section is verified — the application can be approved.'),
      effects: [() => audit(user.userId, 'Admin', 'SECTIONS_VERIFIED', labels(todo), app.appId)],
    };
  });
}

/* ================= decisions ================= */

export function approveApplication(user: UserDoc, input: { expect: Expect; remarks: string }): Promise<ActionResult> {
  return withApp(user, 'approve', input.expect, async ({ tx, app, pr, paid, now }) => {
    if (app.status === STATUS.APPROVED) throw new UserError('This application is already approved.');
    assertReviewable(app);
    const unverified = unverifiedSections(app.review);
    if (unverified.length) throw new UserError('Verify every section before approving. Still unverified: ' + labels(unverified) + '.');
    const prog = progressOf(app, paid, pr ? pr.status : null);
    if (!prog.complete) throw new UserError('The application is not complete: ' + prog.pendingLabels.join(', ') + '.');
    const remarks = trim(input.remarks);
    const w = new AppWriter(app, false);
    w.set('status', 'Approved');
    w.set('reviewedBy', user.userId);
    w.set('reviewedAt', now);
    w.set('approvedAt', now);
    if (remarks) w.set('adminRemarks', appendRemark(app, user.userId, now, remarks));
    w.write(tx, now);
    const a = w.doc;
    return {
      appId: app.appId,
      message: 'Approved. ' + a.totalOptions.toLocaleString('en-IN') + ' options → ' + a.totalShares.toLocaleString('en-IN') + ' shares for allotment.',
      effects: [
        () => audit(user.userId, 'Admin', 'APP_APPROVED', a.totalOptions + ' options / ' + a.totalShares + ' shares', app.appId),
        async () => {
          const emp = await getEmployee(app.employeeId);
          const to = await participantAddress(app.employeeId, emp);
          if (!to) return;
          await sendTemplate('application_approved', to, {
            name: emp?.name ?? '', appId: app.appId, totalOptions: a.totalOptions, totalShares: a.totalShares,
            exerciseAmount: a.exerciseAmount, perquisite: a.perquisiteAmount, tax: a.taxAmount,
            dpId: a.demat.dpId, clientId: a.demat.clientId, remarks,
            ...(a.notice.fileId ? { attachFileIds: [a.notice.fileId] } : {}),
          }, { appId: app.appId });
        },
      ],
    };
  });
}

/**
 * Send back, as ONE action (legacy marked each section in one call and sent
 * the application back in another, so a failure between them left it half
 * done). AGREED CHANGE: refused for Approved and Rejected (canSendBack).
 */
export function sendBackApplication(user: UserDoc, input: { expect: Expect; sections: string[]; remarks: string }): Promise<ActionResult> {
  return withApp(user, 'sendBack', input.expect, async ({ tx, app, pr, now }) => {
    if (!canSendBack(app.status)) {
      throw new UserError('An ' + app.status.toLowerCase() + ' application cannot be sent back' +
        (app.status === STATUS.APPROVED ? ' — raise a reversal with the ESOP team instead.' : '.'));
    }
    if (app.status === STATUS.SENT_BACK) throw new UserError('This application is already with the participant for correction.');
    if (app.status === STATUS.DRAFT) throw new UserError(app.appId + ' has not been submitted, so there is nothing to send back.');
    const remarks = trim(input.remarks);
    if (!remarks) throw new UserError('Say what needs correcting — the participant sees these remarks.');
    const chosen = input.sections.map(trim).filter(Boolean);
    const bad = chosen.find((k) => !isSectionKey(k));
    if (bad) throw new UserError('Unknown section "' + bad + '".');
    const review = { ...app.review };
    (chosen as SectionKey[]).forEach((k) => { review[k] = 'Sent Back'; });
    const back = SECTION_KEYS.filter((k) => review[k] === 'Sent Back');
    if (!back.length) throw new UserError('Tick the section or sections the participant has to correct.');

    const w = new AppWriter(app, false);
    w.set('status', 'Sent Back');
    w.set('review', review);
    w.set('reviewedBy', user.userId);
    w.set('reviewedAt', now);
    w.set('adminRemarks', appendRemark(app, user.userId, now, remarks));
    w.write(tx, now);
    const prPatch = back.includes('taxPayment') && app.review.taxPayment !== 'Sent Back'
      ? prStatusPatch(pr, app, 'taxPayment', 'Sent Back', remarks) : null;
    if (pr && prPatch) tx.update(partnerRequestRef(pr.requestId), prPatch);

    const sectionLabels = back.map((k) => SECTION_LABEL[k]);
    return {
      appId: app.appId,
      message: 'Sent back with your remarks. Sections to correct: ' + sectionLabels.join(', ') + '.',
      effects: [
        () => audit(user.userId, 'Admin', 'APP_SENT_BACK', sectionLabels.join(', ') + ' — ' + remarks, app.appId),
        async () => {
          const emp = await getEmployee(app.employeeId);
          const to = await participantAddress(app.employeeId, emp);
          if (to) await sendTemplate('application_sent_back', to, { name: emp?.name ?? '', appId: app.appId, sections: sectionLabels, remarks }, { appId: app.appId });
        },
      ],
    };
  });
}

/** "Close without processing". A live partner request is withdrawn. */
export function rejectApplication(user: UserDoc, input: { expect: Expect; remarks: string }): Promise<ActionResult> {
  return withApp(user, 'reject', input.expect, async ({ tx, app, pr, now }) => {
    const remarks = trim(input.remarks);
    if (!remarks) throw new UserError('Record why the application is being closed.');
    if (app.status === STATUS.APPROVED) throw new UserError('An approved application cannot be rejected. Raise a reversal with the ESOP team instead.');
    if (app.status === STATUS.REJECTED) throw new UserError('This application is already closed.');
    const w = new AppWriter(app, false);
    w.set('status', 'Rejected');
    w.set('reviewedBy', user.userId);
    w.set('reviewedAt', now);
    w.set('adminRemarks', appendRemark(app, user.userId, now, remarks));
    w.write(tx, now);
    // Legacy withdrew Assigned and Payment Fed; a Sent Back request is open with the partner too.
    const open: string[] = [PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.PAID, PARTNER_STATUS.SENT_BACK];
    const withdraw = !!pr && open.includes(pr.status);
    if (pr && withdraw) tx.update(partnerRequestRef(pr.requestId), { status: PARTNER_STATUS.WITHDRAWN, remarks: 'Application closed: ' + remarks });
    return {
      appId: app.appId,
      message: 'Application closed and options released.' + (withdraw ? ' The request with ' + pr!.fundPartnerName + ' was withdrawn.' : ''),
      effects: [
        () => audit(user.userId, 'Admin', 'APP_REJECTED', remarks, app.appId),
        async () => {
          const emp = await getEmployee(app.employeeId);
          const to = await participantAddress(app.employeeId, emp);
          if (to) await sendTemplate('application_rejected', to, { name: emp?.name ?? '', appId: app.appId, remarks }, { appId: app.appId });
        },
      ],
    };
  });
}

/* ================= repricing ================= */

/**
 * Re-price one application inside a transaction: the grant's multiplier and
 * price, the participant's current flat rate, the FMV on record for the
 * application's FMV date, and the tax sheet. Returns the writer (not yet
 * written) and what changed. Reads only — the caller writes.
 */
async function repriceDraft(tx: Tx, app: ApplicationDoc, settings: Settings, opts: { fmv?: number; rate?: number | null }) {
  const st = await loadState(app.employeeId, settings, todayIst(), tx);
  const lines = await linesOf(app.appId, tx);
  let fmv = app.fmvValue;
  if (opts.fmv !== undefined) fmv = opts.fmv;
  else if (app.fmvDate) {
    const snap = await getDoc(db().collection(COL.fmv).doc(app.fmvDate), tx);
    const f = snap.data() as Partial<FmvDoc> | undefined;
    if (f && num(f.fmv, 0) > 0) fmv = num(f.fmv, 0);
  }
  const pr = await partnerRequestOf(app.appId, tx);
  const w = new AppWriter(app, false);
  const rate = opts.rate === undefined ? st.employee.taxRatePercent : opts.rate;
  if (rate !== null && rate !== undefined && rate !== app.taxRatePercent) w.set('taxRatePercent', rate);
  if (fmv !== app.fmvValue) w.set('fmvValue', fmv);
  return {
    w, pr, lines,
    apply: (now: string) => {
      repriceInto(w, { grants: st.grants, defaultExercisePrice: settings.portal.exercisePrice, priceOptions: priceOptions(st, app.appId) }, lines, tx, now);
    },
  };
}

function figures(a: Pick<ApplicationDoc, 'totalShares' | 'fmvValue' | 'perquisiteAmount' | 'taxAmount' | 'taxMethod'>): string {
  return a.totalShares + ' shares, FMV ' + a.fmvValue + ', perquisite ' + a.perquisiteAmount + ', tax ' + a.taxAmount + ' (' + (a.taxMethod || '—') + ')';
}

/**
 * AGREED CHANGE: a submitted application is never repriced silently. This is
 * the explicit, audited reprice; the participant is emailed the new figures.
 */
export function repriceApplication(user: UserDoc, input: { expect: Expect; reason: string }): Promise<ActionResult> {
  return runAdmin(user, 'reprice', async () => {
    const settings = await loadSettings();
    const reason = trim(input.reason);
    if (!reason) throw new UserError('Record why the application is being repriced — it is audited and the participant is told.');
    const out = await inTx(async (tx) => {
      const app = await getApplication(input.expect.appId, tx);
      if (!app) throw new UserError('Application ' + trim(input.expect.appId) + ' was not found.');
      assertRev(app, input.expect);
      if (app.status === STATUS.APPROVED || app.status === STATUS.REJECTED) {
        throw new UserError('An ' + app.status.toLowerCase() + ' application cannot be repriced.');
      }
      const r = await repriceDraft(tx, app, settings, {});
      const now = nowIso();
      const before = figures(app);
      r.apply(now);
      const after = figures(r.w.doc);
      if (before === after) throw new UserError('Nothing changes: the figures on record are already current. Nothing was saved.');
      const taxChanged = r.w.doc.taxAmount !== app.taxAmount;
      // The tax section was verified against the old figure.
      if (taxChanged && app.review.taxPayment === 'Verified') r.w.set('review', { ...r.w.doc.review, taxPayment: 'Pending' });
      if (!canAutoReprice(app.status)) r.w.set('taxFrozenAt', now);
      r.w.set('adminRemarks', appendRemark(app, user.userId, now, 'Repriced by the ESOP team: ' + reason));
      r.w.write(tx, now);
      if (r.pr && r.pr.status === PARTNER_STATUS.ASSIGNED && r.pr.taxAmount !== r.w.doc.taxAmount) {
        tx.update(partnerRequestRef(r.pr.requestId), { taxAmount: r.w.doc.taxAmount });
      }
      return { app, after: r.w.doc, before, afterText: after, taxChanged };
    });
    const a = out.after;
    const effects: Effect[] = [
      () => audit(user.userId, 'Admin', 'APP_REPRICED', reason + ' — ' + out.before + ' → ' + out.afterText, a.appId),
      async () => {
        const emp = await getEmployee(a.employeeId);
        const to = await participantAddress(a.employeeId, emp);
        if (!to) return;
        await sendTemplate('application_repriced', to, {
          name: emp?.name ?? '', appId: a.appId, reason, totalOptions: a.totalOptions, totalShares: a.totalShares,
          exerciseAmount: a.exerciseAmount, fmv: a.fmvValue, fmvDate: prettyDate(a.fmvDate), perquisite: a.perquisiteAmount,
          tax: a.taxAmount, previousTax: out.app.taxAmount, taxDueDate: prettyDate(a.taxDueDate),
          stillToPay: Math.max(0, a.taxAmount - a.taxPaidAmount),
        }, { appId: a.appId });
      },
    ];
    return {
      appId: a.appId,
      message: 'Repriced. Tax is now ' + inr(a.taxAmount) + (out.taxChanged ? ' (was ' + inr(out.app.taxAmount) + ')' : ' (unchanged)') +
        '; perquisite ' + inr(a.perquisiteAmount) + '. The participant has been emailed.' +
        (out.taxChanged && out.app.review.taxPayment === 'Verified' ? ' The tax section is back to pending.' : ''),
      effects,
    };
  });
}

/**
 * Automatic repricing after a master changes (tax rate, tax sheet, share
 * price): Draft and Sent Back only (canAutoReprice). Each application in its
 * own transaction. Returns how many changed, and the submitted ones left
 * alone so the screen can list them for an explicit reprice.
 */
export async function autoReprice(
  appIds: readonly string[], actor: string, why: string, opts: { fmv?: number; rate?: number | null } = {},
): Promise<{ repriced: string[]; frozen: string[]; failed: string[] }> {
  const settings = await loadSettings();
  const res = { repriced: [] as string[], frozen: [] as string[], failed: [] as string[] };
  for (const appId of appIds) {
    try {
      const outcome = await inTx(async (tx) => {
        const app = await getApplication(appId, tx);
        if (!app || app.status === STATUS.APPROVED || app.status === STATUS.REJECTED) return 'skip' as const;
        if (!canAutoReprice(app.status)) return 'frozen' as const;
        const r = await repriceDraft(tx, app, settings, opts);
        const now = nowIso();
        r.apply(now);
        if (!r.w.dirty || (figures(r.w.doc) === figures(app) && r.w.doc.taxRatePercent === app.taxRatePercent)) return 'same' as const;
        r.w.write(tx, now);
        if (r.pr && r.pr.status === PARTNER_STATUS.ASSIGNED && r.pr.taxAmount !== r.w.doc.taxAmount) {
          tx.update(partnerRequestRef(r.pr.requestId), { taxAmount: r.w.doc.taxAmount });
        }
        return 'done' as const;
      });
      if (outcome === 'done') res.repriced.push(appId);
      if (outcome === 'frozen') res.frozen.push(appId);
    } catch (e) {
      console.error('auto reprice ' + appId + ' failed', e);
      res.failed.push(appId);
    }
  }
  if (res.repriced.length) {
    await audit(actor, actor === 'system' ? 'system' : 'Admin', 'AUTO_REPRICED', why + ': ' + res.repriced.length + ' draft/sent-back application(s) — ' + res.repriced.join(', ').slice(0, 3000));
  }
  return res;
}
