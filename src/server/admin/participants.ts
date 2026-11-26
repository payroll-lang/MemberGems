import 'server-only';
import { STATUS, num, toDateKey, trim, validateMobile, validatePan, type GrantBalance } from '@/domain';
import type { WriteBatch } from 'firebase-admin/firestore';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { COL, type ApplicationDoc, type EmployeeDoc, type UserDoc } from '@/lib/schema';
import { nowIso, todayIst } from '@/lib/time';
import { applicationsForEmployee } from '../applications';
import { UserError, type ActionResult } from '../core/errors';
import { employeeRef, getEmployee } from '../employees';
import { balances, loadState } from '../participant/state';
import { loadSettings } from '../settings';
import { getTaxPosition } from '../taxPositions';
import { parseIdList } from './core/grid';
import { blankEmployee, loginEmailSync } from './core/grantReport';
import { checkRate, parseDetailsRows, parseRateRows, planDetails, planEnabledList, planRates, MAX_PASTE_ROWS } from './core/bulkPaste';
import {
  filterParticipants, grantTotalsByEmployee, participantRows, participantSummary, type ParticipantFilter, type ParticipantRow,
} from './core/queue';
import { allEmployees, allUsers, grantFigures, taxSheetState } from './data';
import { autoReprice } from './review';
import { idList, plural, runAdmin, type Outcome } from './run';
import { saveConfigValue } from './settingsStore';

export const PAGE_SIZE = 100;

export interface ParticipantsView {
  rows: ParticipantRow[];
  matched: number;
  page: number;
  pages: number;
  summary: ReturnType<typeof participantSummary>;
  enabledIds: string[];
  taxSheet: { rows: number; asOn: string; loadedAt: string };
}

/** AdminApi.employees, paged. */
export async function loadParticipants(f: { search: string; only: ParticipantFilter; page: number }): Promise<ParticipantsView> {
  const settings = await loadSettings();
  const [employees, grants, users, sheet] = await Promise.all([allEmployees(), grantFigures(), allUsers(), taxSheetState()]);
  const userMap = new Map(users.filter((u) => u.role === 'Employee').map((u) => [u.userId.toUpperCase(), u]));
  const all = participantRows({
    employees, totals: grantTotalsByEmployee(grants, settings.portal), users: userMap, sheetCovered: sheet.covered,
    enabledIds: settings.portal.eligibleEmployeeIds,
  });
  const rows = filterParticipants(all, f.search, f.only);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, f.page || 1), pages);
  return {
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    matched: rows.length, page, pages,
    summary: participantSummary(all),
    enabledIds: settings.portal.eligibleEmployeeIds,
    taxSheet: { rows: sheet.rows, asOn: sheet.asOn, loadedAt: sheet.loadedAt },
  };
}

export interface ParticipantDetail {
  employee: EmployeeDoc;
  grants: GrantBalance[];
  applications: ApplicationDoc[];
  login: Pick<UserDoc, 'userId' | 'status' | 'loginEmails' | 'notifyEmail' | 'lastLoginAt' | 'mustResetPassword'> | null;
  taxPosition: { regime: string; netTaxable: number; asOn: string; flags: string } | null;
}

export async function loadParticipant(employeeId: string): Promise<ParticipantDetail | null> {
  const id = trim(employeeId).toUpperCase();
  if (!id || id.includes('/')) return null;
  const emp = await getEmployee(id);
  if (!emp) return null;
  const settings = await loadSettings();
  const [st, apps, userSnap, tp] = await Promise.all([
    loadState(id, settings, todayIst()), applicationsForEmployee(id), db().collection(COL.users).doc(id).get(), getTaxPosition(id),
  ]);
  const u = userSnap.data() as UserDoc | undefined;
  return {
    employee: emp,
    grants: balances(st, ''),
    applications: apps,
    login: u ? { userId: userSnap.id, status: u.status, loginEmails: u.loginEmails ?? [], notifyEmail: u.notifyEmail ?? '', lastLoginAt: u.lastLoginAt, mustResetPassword: u.mustResetPassword } : null,
    taxPosition: tp ? {
      regime: String(tp.regime ?? ''), netTaxable: num(tp.netTaxable, 0), asOn: String(tp.asOn ?? ''),
      flags: Array.isArray(tp.flags) ? tp.flags.join(', ') : String(tp.flags ?? ''),
    } : null,
  };
}

/* ================= one participant ================= */

export interface EmployeeInput {
  employeeId: string;
  isNew: boolean;
  name: string;
  designation: string;
  emailOverride: string;
  mobile: string;
  address: string;
  nationality: string;
  employmentStatus: string;
  separationDate: string;
  pan: string;
  remarks: string;
  ctc: string;
  taxRatePercent: string;
  dpName: string;
  dpId: string;
  clientId: string;
  accountName: string;
  accountType: string;
}

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

/** Open applications on a participant that an automatic reprice may touch, and the frozen ones. */
async function openAppsOf(employeeId: string): Promise<string[]> {
  const apps = await applicationsForEmployee(employeeId);
  return apps.filter((a) => a.status !== STATUS.APPROVED && a.status !== STATUS.REJECTED).map((a) => a.appId);
}

function repriceNote(r: { repriced: string[]; frozen: string[]; failed: string[] }): string {
  return (r.repriced.length ? ' ' + plural(r.repriced.length, 'draft application') + ' repriced.' : '') +
    (r.frozen.length ? ' Not repriced, because submitted (use Reprice on each if needed): ' + idList(r.frozen) + '.' : '') +
    (r.failed.length ? ' Repricing failed for ' + idList(r.failed) + '; open them and use Reprice.' : '');
}

/** Keep an Employee login's sign-in addresses in line with the record. */
async function syncLogin(emp: Pick<EmployeeDoc, 'employeeId' | 'emailOverride' | 'accessEmail' | 'secondaryEmail'>): Promise<void> {
  const ref = db().collection(COL.users).doc(emp.employeeId);
  const snap = await ref.get();
  const u = snap.data() as UserDoc | undefined;
  if (!u || u.role !== 'Employee') return;
  const patch = loginEmailSync(u, emp);
  if (patch) await ref.update(patch);
}

/** AdminApi.saveEmployee: every field the screen shows; blank tax / CTC leaves them as they are. */
export function saveEmployee(user: UserDoc, input: EmployeeInput): Promise<ActionResult> {
  return runAdmin(user, 'saveEmployee', async (): Promise<Outcome> => {
    const id = trim(input.employeeId).toUpperCase();
    if (!id) throw new UserError('An employee ID is required.');
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(id)) throw new UserError('"' + id + '" is not an employee code (letters, digits, - and _ only).');
    const rateText = trim(input.taxRatePercent);
    const rate = rateText ? checkRate(rateText) : null;
    if (rate && !rate.ok) throw new UserError('The tax rate must be a percentage between 0 and 60.');
    const ctcText = trim(input.ctc);
    const ctc = ctcText ? num(ctcText, NaN) : null;
    if (ctc !== null && (isNaN(ctc) || ctc < 0)) throw new UserError('CTC must be an amount in rupees.');
    let pan = trim(input.pan).toUpperCase();
    if (pan) {
      const v = validatePan(pan);
      if (!v.ok) throw new UserError(v.error);
      pan = v.value;
    }
    let mobile = trim(input.mobile);
    if (mobile) {
      const v = validateMobile(mobile);
      if (!v.ok) throw new UserError(v.error);
      mobile = v.value;
    }
    const override = trim(input.emailOverride);
    if (override && !EMAIL.test(override)) throw new UserError('"' + override + '" does not look like an email address.');
    const type = trim(input.accountType).toUpperCase();
    if (type && type !== 'NSDL' && type !== 'CDSL') throw new UserError('The demat account type must be NSDL or CDSL.');
    const sep = trim(input.separationDate);
    const sepKey = sep ? toDateKey(sep) : '';
    if (sep && !sepKey) throw new UserError('"' + sep + '" is not a date.');

    const now = nowIso();
    const ref = employeeRef(id);
    const result = await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? (await getEmployee(id, tx)) : null;
      if (input.isNew && existing) throw new UserError(id + ' is already on record. Open it from the list to edit it.');
      if (!input.isNew && !existing) throw new UserError('No participant record for ' + id + '.');
      const base = existing ?? blankEmployee(id, now);
      const next: EmployeeDoc = {
        ...base,
        name: trim(input.name), designation: trim(input.designation), emailOverride: override, mobile, address: trim(input.address),
        nationality: trim(input.nationality) || (existing ? '' : 'Indian'), employmentStatus: trim(input.employmentStatus) || (existing ? '' : 'Active'),
        separationDate: sepKey, pan, remarks: trim(input.remarks),
        demat: {
          dpName: trim(input.dpName), dpId: trim(input.dpId).toUpperCase(), clientId: trim(input.clientId).toUpperCase(),
          accountName: trim(input.accountName), accountType: type as EmployeeDoc['demat']['accountType'],
        },
        ...(ctc !== null ? { ctc } : {}),
        ...(rate && rate.ok ? { taxRatePercent: rate.value } : {}),
        updatedAt: now,
      };
      if (!next.name) throw new UserError('Enter the participant’s name.');
      tx.set(ref, next);
      return { existing, next };
    });
    const rateChanged = !!rate && rate.ok && result.existing?.taxRatePercent !== rate.value;
    const emailsChanged = !result.existing || result.existing.emailOverride !== result.next.emailOverride;
    if (emailsChanged) await syncLogin(result.next);
    const rep = rateChanged && rate.ok ? await autoReprice(await openAppsOf(id), user.userId, 'tax rate of ' + id + ' set to ' + rate.value + '%', { rate: rate.value }) : null;
    return {
      message: 'Saved ' + id + '.' + (rep ? repriceNote(rep) : ''),
      effects: [() => audit(user.userId, 'Admin', result.existing ? 'EMPLOYEE_UPDATED' : 'EMPLOYEE_CREATED',
        id + (rateChanged ? ' — tax rate ' + (result.existing?.taxRatePercent ?? '—') + '% → ' + result.next.taxRatePercent + '%' : ''))],
    };
  });
}

/** AdminApi.setBlocked: they keep their record, grants and history, and cannot sign in or act. */
export function setBlocked(user: UserDoc, input: { employeeId: string; blocked: boolean; reason: string }): Promise<ActionResult> {
  return runAdmin(user, 'setBlocked', async () => {
    const id = trim(input.employeeId).toUpperCase();
    const reason = trim(input.reason);
    if (input.blocked && !reason) throw new UserError('Record why this participant is being blocked - they are shown the reason.');
    const emp = await getEmployee(id);
    if (!emp) throw new UserError('No participant record for ' + id + '.');
    const now = nowIso();
    await employeeRef(id).update({
      blocked: input.blocked, blockedReason: input.blocked ? reason : '', blockedAt: input.blocked ? now : '',
      blockedBy: input.blocked ? user.userId : '', updatedAt: now,
    });
    return {
      message: id + (input.blocked ? ' is blocked from the portal. Their sessions end at their next request.' : ' can use the portal again.'),
      effects: [() => audit(user.userId, 'Admin', input.blocked ? 'PARTICIPANT_BLOCKED' : 'PARTICIPANT_UNBLOCKED', id + (input.blocked ? ' - ' + reason : ''))],
    };
  });
}

/* ================= bulk ================= */

async function knownIds(): Promise<Set<string>> {
  const snap = await db().collection(COL.employees).select().get();
  return new Set(snap.docs.map((d) => d.id.toUpperCase()));
}

async function commitAll(writes: ((b: WriteBatch) => void)[]): Promise<void> {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db().batch();
    writes.slice(i, i + 400).forEach((w) => w(batch));
    await batch.commit();
  }
}

/** AdminApi.bulkTaxRates: "employee ID, CTC, tax %" per line; open drafts are repriced. */
export function bulkTaxRates(user: UserDoc, text: string): Promise<ActionResult> {
  return runAdmin(user, 'bulkTaxRates', async () => {
    const rows = parseRateRows(text);
    if (!rows.length) throw new UserError('Paste at least one row.');
    if (rows.length > MAX_PASTE_ROWS) throw new UserError('Paste at most ' + MAX_PASTE_ROWS + ' rows at a time.');
    const plan = planRates(rows, await knownIds());
    const now = nowIso();
    await commitAll(plan.updates.map((u) => (b) => b.update(employeeRef(u.employeeId), {
      taxRatePercent: u.taxRatePercent, ...(u.ctc !== undefined ? { ctc: u.ctc } : {}), updatedAt: now,
    })));
    // Reprice open drafts of everyone touched (in one pass over their applications).
    const changed = new Map(plan.updates.map((u) => [u.employeeId, u.taxRatePercent]));
    const open: { appId: string; rate: number }[] = [];
    if (changed.size) {
      const snap = await db().collection(COL.applications).where('status', 'in', [STATUS.DRAFT, STATUS.SENT_BACK, STATUS.SUBMITTED, STATUS.UNDER_REVIEW]).get();
      snap.docs.forEach((d) => {
        const emp = String(d.get('employeeId') ?? '').toUpperCase();
        if (changed.has(emp)) open.push({ appId: d.id, rate: changed.get(emp)! });
      });
    }
    const rep = { repriced: [] as string[], frozen: [] as string[], failed: [] as string[] };
    for (const o of open) {
      const r = await autoReprice([o.appId], user.userId, 'bulk tax rates', { rate: o.rate });
      rep.repriced.push(...r.repriced); rep.frozen.push(...r.frozen); rep.failed.push(...r.failed);
    }
    return {
      message: plural(plan.updates.length, 'participant record') + ' updated.' + repriceNote(rep),
      data: { skipped: plan.skipped, warnings: [] },
      effects: [() => audit(user.userId, 'Admin', 'BULK_TAX_RATES', plan.updates.length + ' updated, ' + rep.repriced.length + ' applications repriced, ' + plan.skipped.length + ' skipped')],
    };
  });
}

/** AdminApi.bulkParticipantDetails: blank cells leave what is on record. Prefills, not verifications. */
export function bulkDetails(user: UserDoc, text: string): Promise<ActionResult> {
  return runAdmin(user, 'bulkDetails', async () => {
    const rows = parseDetailsRows(text);
    if (!rows.length) throw new UserError('Paste at least one row.');
    if (rows.length > MAX_PASTE_ROWS) throw new UserError('Paste at most ' + MAX_PASTE_ROWS + ' rows at a time.');
    const employees = await allEmployees();
    const plan = planDetails(rows, new Map(employees.map((e) => [e.employeeId, e])));
    const now = nowIso();
    await commitAll(plan.updates.map((u) => (b) => b.update(employeeRef(u.employeeId), { ...u.patch, updatedAt: now })));
    return {
      message: plural(plan.updates.length, 'participant record') + ' updated' + (plan.unchanged ? ', ' + plan.unchanged + ' already matched' : '') +
        (plan.skipped.length ? ', ' + plan.skipped.length + ' skipped' : '') + '.',
      data: { skipped: plan.skipped, warnings: plan.warnings },
      effects: [() => audit(user.userId, 'Admin', 'BULK_DETAILS_PREFILLED', plan.updates.length + ' updated, ' + plan.unchanged + ' unchanged, ' + plan.skipped.length + ' skipped')],
    };
  });
}

/** AdminApi.setEnabledList (ELIGIBLE_EMPLOYEE_IDS). Empty = open to everyone. */
export function setEnabledList(user: UserDoc, text: string): Promise<ActionResult> {
  return runAdmin(user, 'setEnabledList', async () => {
    const plan = planEnabledList(parseIdList(text), await knownIds());
    await saveConfigValue('ELIGIBLE_EMPLOYEE_IDS', plan.kept.join(', '), user.userId);
    return {
      message: plan.kept.length
        ? plural(plan.kept.length, 'participant') + ' can use the portal. Everyone else is held back.' +
          (plan.unknown.length ? ' Not on the participant list (check for typos): ' + idList(plan.unknown) + '.' : '')
        : 'List cleared — the portal is open to every participant on the report.',
      data: { skipped: plan.unknown.map((x) => x + ' — not a participant on record'), warnings: [] },
      effects: [() => audit(user.userId, 'Admin', 'ENABLED_LIST_SET', plan.kept.length ? plan.kept.length + ' participant(s) enabled' : 'list cleared — open to everyone')],
    };
  });
}

/** AdminApi.bulkBlock */
export function bulkBlock(user: UserDoc, input: { text: string; blocked: boolean; reason: string }): Promise<ActionResult> {
  return runAdmin(user, 'bulkBlock', async () => {
    const reason = trim(input.reason);
    if (input.blocked && !reason) throw new UserError('Give a reason - every blocked participant is shown it.');
    const ids = parseIdList(input.text);
    if (!ids.length) throw new UserError('Paste at least one employee ID.');
    if (ids.length > MAX_PASTE_ROWS) throw new UserError('Paste at most ' + MAX_PASTE_ROWS + ' codes at a time.');
    const known = await knownIds();
    const hit = ids.filter((id) => known.has(id));
    const skipped = ids.filter((id) => !known.has(id)).map((id) => id + ' - no participant record');
    const now = nowIso();
    await commitAll(hit.map((id) => (b) => b.update(employeeRef(id), {
      blocked: input.blocked, blockedReason: input.blocked ? reason : '', blockedAt: input.blocked ? now : '',
      blockedBy: input.blocked ? user.userId : '', updatedAt: now,
    })));
    return {
      message: plural(hit.length, 'participant') + ' ' + (input.blocked ? 'blocked' : 'released') + '.',
      data: { skipped, warnings: [] },
      effects: [() => audit(user.userId, 'Admin', input.blocked ? 'BULK_BLOCKED' : 'BULK_UNBLOCKED', hit.length + ' participant(s)' + (reason ? ' - ' + reason : '') + ': ' + idList(hit, 50))],
    };
  });
}
