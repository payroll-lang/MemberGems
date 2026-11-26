import 'server-only';
import { FieldValue } from 'firebase-admin/firestore';
import { accessBar, trim } from '@/domain';
import { audit } from '@/lib/audit';
import { issueCode } from '@/lib/auth/service';
import { db } from '@/lib/firebase';
import { sendTemplate } from '@/lib/mail';
import { COL, type Role, type UserDoc, type UserSecretDoc } from '@/lib/schema';
import { nowIso } from '@/lib/time';
import { UserError, type ActionResult } from '../core/errors';
import { emailFor, getEmployee } from '../employees';
import { getPartner } from '../partners';
import { loadSettings } from '../settings';
import { grantTotalsByEmployee } from './core/queue';
import { allEmployees, allUsers, grantFigures } from './data';
import { plural, runAdmin } from './run';
import { emailSwitches } from './views';

/**
 * Logins (Auth.provisionUser, AdminApi.users / setUserStatus /
 * provisionAllEmployees). A login is issued a one-time invite code; the code
 * is emailed (template account_ready) or shown once on screen. Issuing a code
 * for an existing login resets it, as legacy did: the old password stops
 * working and every session ends.
 */

export const CODE_MINUTES = 30;
const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const ROLES: Role[] = ['Employee', 'Admin', 'FundPartner'];

export interface LoginRow {
  userId: string;
  role: Role;
  name: string;
  loginEmails: string[];
  notifyEmail: string;
  fundPartnerId: string;
  fundPartnerName: string;
  status: string;
  mustResetPassword: boolean;
  hasPassword: boolean;
  locked: boolean;
  lastLoginAt: string;
  createdAt: string;
  createdBy: string;
}

export async function loadLogins(): Promise<LoginRow[]> {
  const [users, secrets] = await Promise.all([
    allUsers(), db().collection(COL.userSecrets).select('scheme', 'passwordHash', 'lockedUntil').get(),
  ]);
  const sec = new Map(secrets.docs.map((d) => [d.id, d.data() as Partial<UserSecretDoc>]));
  const now = Date.now();
  return users.map((u) => {
    const s = sec.get(u.userId);
    return {
      userId: u.userId, role: u.role, name: u.name ?? '', loginEmails: u.loginEmails ?? [], notifyEmail: u.notifyEmail ?? '',
      fundPartnerId: u.fundPartnerId ?? '', fundPartnerName: u.fundPartnerName ?? '', status: u.status,
      mustResetPassword: !!u.mustResetPassword, hasPassword: !!s && s.scheme !== 'none' && !!s.passwordHash,
      locked: !!s?.lockedUntil && Date.parse(s.lockedUntil) > now,
      lastLoginAt: u.lastLoginAt ?? '', createdAt: u.createdAt ?? '', createdBy: u.createdBy ?? '',
    };
  }).sort((a, b) => a.role.localeCompare(b.role) || a.userId.localeCompare(b.userId));
}

export interface IssuedCode {
  userId: string;
  name: string;
  email: string;
  emailed: boolean;
  /** Only when not emailed: shown once, never stored readable. */
  code: string;
  expiresInMinutes: number;
}

interface LoginSpec {
  userId: string;
  role: Role;
  name: string;
  email: string;
  partnerId?: string;
}

/** A readable, stable user ID for a partner login (AdminApi.partnerUserId). */
export function partnerUserId(name: string): string {
  return ('FP-' + String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 45);
}

/**
 * Create the login, or reset it, and issue an invite code. Writes the user
 * and secret documents in one transaction; the code is set by issueCode.
 */
async function provision(spec: LoginSpec, actor: string, sendEmail: boolean): Promise<IssuedCode & { created: boolean }> {
  const id = trim(spec.userId).toUpperCase();
  if (!id) throw new UserError('A user ID is required.');
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,59}$/.test(id)) throw new UserError('"' + id + '" cannot be used as a user ID (letters, digits, - . _ only).');
  if (!ROLES.includes(spec.role)) throw new UserError('Unknown role "' + spec.role + '".');
  let email = trim(spec.email);
  let name = trim(spec.name);
  let notify = email;
  const loginEmails: string[] = [];
  let partner: { partnerId: string; name: string } | null = null;

  if (spec.role === 'Employee') {
    const emp = await getEmployee(id);
    if (!emp) throw new UserError('There is no participant record for ' + id + '. A participant login uses the employee code as its user ID.');
    if (!name) name = emp.name;
    if (!email) email = emailFor(emp);
    notify = emailFor(emp) || email;
    [emp.emailOverride, emp.accessEmail, emp.secondaryEmail, email].forEach((e) => {
      const v = trim(e).toLowerCase();
      if (v && !loginEmails.includes(v)) loginEmails.push(v);
    });
  } else {
    if (email) loginEmails.push(email.toLowerCase());
  }
  if (spec.role === 'FundPartner') {
    const p = await getPartner(trim(spec.partnerId));
    if (!p) throw new UserError('Choose one of the fund partners on record for a fund partner login.');
    partner = { partnerId: p.partnerId, name: p.name };
    if (!name) name = p.name;
  }
  if (!email) {
    throw new UserError('No email address on record for ' + id + '. Add one first — the one-time code has to go somewhere, and it is the address they sign in with.');
  }
  if (!EMAIL.test(email)) throw new UserError('"' + email + '" does not look like an email address.');

  // An address shared by two logins cannot be signed in with (resolveUser refuses to guess).
  const clash = loginEmails.length ? await db().collection(COL.users).where('loginEmails', 'array-contains-any', loginEmails.slice(0, 10)).get() : null;
  const others = (clash?.docs ?? []).filter((d) => d.id !== id).map((d) => d.id);
  if (others.length) throw new UserError('That address is already a sign-in address of ' + others.join(', ') + '. Each login needs its own address.');

  const userRef = db().collection(COL.users).doc(id);
  const secretRef = db().collection(COL.userSecrets).doc(id);
  const now = nowIso();
  const { user, created } = await db().runTransaction(async (tx) => {
    const [us, ss] = await Promise.all([tx.get(userRef), tx.get(secretRef)]);
    const existing = us.data() as UserDoc | undefined;
    if (existing && existing.role !== spec.role) {
      throw new UserError(id + ' already exists as a ' + existing.role + ' login. A login’s role cannot be changed here.');
    }
    const doc: UserDoc = {
      userId: id, role: spec.role, name: name || id, loginEmails, notifyEmail: notify,
      ...(partner ? { fundPartnerId: partner.partnerId, fundPartnerName: partner.name } : {}),
      status: existing?.status ?? 'Active', mustResetPassword: true,
      ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
      createdAt: existing?.createdAt || now, createdBy: existing?.createdBy || actor,
    };
    tx.set(userRef, doc);
    const prev = ss.data() as UserSecretDoc | undefined;
    // Provisioning clears the password — that is its purpose — and signs them out everywhere.
    tx.set(secretRef, {
      scheme: 'none', passwordHash: '', tokenVersion: (prev?.tokenVersion ?? 0) + 1, failedAttempts: 0,
      legacySalt: FieldValue.delete(), lockedUntil: FieldValue.delete(),
    }, { merge: true });
    return { user: doc, created: !existing };
  });

  const code = await issueCode(user, 'invite');
  let emailed = false;
  if (sendEmail) {
    emailed = await sendTemplate('account_ready', notify || email, {
      name: user.name || id, userId: id, code, minutes: CODE_MINUTES, role: spec.role,
    });
  }
  await audit(actor, 'Admin', created ? 'USER_CREATED' : 'USER_RESET', id + ' (' + spec.role + ')' + (emailed ? ' — code emailed' : ' — no email sent'));
  return { userId: id, name: user.name, email: notify || email, emailed, code: emailed ? '' : code, expiresInMinutes: CODE_MINUTES, created };
}

export function createLogin(user: UserDoc, input: LoginSpec & { sendEmail: boolean }): Promise<ActionResult> {
  return runAdmin(user, 'createLogin', async () => {
    const r = await provision(input, user.userId, input.sendEmail);
    const settings = await loadSettings();
    let warn = '';
    if (input.role === 'Employee') {
      const emp = await getEmployee(r.userId);
      const bar = emp ? accessBar(emp, settings.portal) : '';
      if (bar) warn = ' Note: this participant cannot use the portal at the moment (' + bar + ').';
    }
    return {
      message: (r.created ? 'Login created for ' : 'Login reset for ') + r.userId + '. ' +
        (r.emailed ? 'A one-time code was emailed to ' + r.email + '.' : 'No email was sent — pass the code below on yourself.') + warn,
      data: { issued: [r] },
    };
  });
}

/** "New code" for an existing login (resets it, as legacy did). */
export function newCode(user: UserDoc, input: { userId: string; sendEmail: boolean }): Promise<ActionResult> {
  return runAdmin(user, 'newCode', async () => {
    const snap = await db().collection(COL.users).doc(trim(input.userId).toUpperCase()).get();
    const u = snap.data() as UserDoc | undefined;
    if (!u) throw new UserError('That login was not found.');
    const r = await provision({
      userId: snap.id, role: u.role, name: u.name, email: u.role === 'Employee' ? '' : (u.notifyEmail || u.loginEmails?.[0] || ''),
      partnerId: u.fundPartnerId,
    }, user.userId, input.sendEmail);
    return {
      message: 'New code issued for ' + r.userId + '. ' + (r.emailed ? 'It was emailed to ' + r.email + '.' : 'No email was sent — pass the code below on yourself.') +
        ' Their old password no longer works.',
      data: { issued: [r] },
    };
  });
}

/** Enable or disable a login (not your own). Either way their sessions end. */
export function setUserStatus(user: UserDoc, input: { userId: string; status: string }): Promise<ActionResult> {
  return runAdmin(user, 'setUserStatus', async () => {
    const id = trim(input.userId).toUpperCase();
    if (id === user.userId.toUpperCase()) throw new UserError('You cannot change the status of your own login.');
    const status = input.status === 'Disabled' ? 'Disabled' : input.status === 'Active' ? 'Active' : '';
    if (!status) throw new UserError('Status must be Active or Disabled.');
    const userRef = db().collection(COL.users).doc(id);
    const secretRef = db().collection(COL.userSecrets).doc(id);
    await db().runTransaction(async (tx) => {
      const [us, ss] = await Promise.all([tx.get(userRef), tx.get(secretRef)]);
      if (!us.exists) throw new UserError('User not found.');
      tx.update(userRef, { status });
      tx.set(secretRef, { tokenVersion: (Number((ss.data() as UserSecretDoc | undefined)?.tokenVersion) || 0) + 1 }, { merge: true });
    });
    return {
      message: id + (status === 'Disabled' ? ' disabled and signed out everywhere.' : ' enabled.'),
      effects: [() => audit(user.userId, 'Admin', 'USER_STATUS', id + ' -> ' + status)],
    };
  });
}

export const BULK_LOGIN_BATCH = 100;

/**
 * AdminApi.provisionAllEmployees: logins for every participant with
 * something exercisable who may act and has none, ~100 per call (the client
 * calls again with the cursor). Emailing the codes needs BULK_EMAILS_ENABLED;
 * codes not emailed are returned for the screen to show once.
 */
export function bulkCreateLogins(user: UserDoc, input: { cursor: string; sendEmail: boolean }): Promise<ActionResult> {
  return runAdmin(user, 'bulkCreateLogins', async () => {
    const settings = await loadSettings();
    const sw = emailSwitches(settings.config);
    if (input.sendEmail && !sw.bulk) {
      throw new UserError('Bulk participant emails are switched off (BULK_EMAILS_ENABLED), so codes cannot be emailed in bulk. ' +
        'Untick "email the codes" to create the logins and show the codes here, or switch bulk emails on in Settings first.');
    }
    const [employees, grants, users] = await Promise.all([allEmployees(), grantFigures(), allUsers()]);
    const totals = grantTotalsByEmployee(grants, settings.portal);
    const has = new Set(users.map((u) => u.userId.toUpperCase()));
    const candidates = employees
      .filter((e) => (totals.get(e.employeeId)?.exercisable ?? 0) > 0 && !accessBar(e, settings.portal) && !has.has(e.employeeId))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
    const cursor = trim(input.cursor);
    const rest = candidates.filter((e) => !cursor || e.employeeId > cursor);
    const slice = rest.slice(0, BULK_LOGIN_BATCH);
    const issued: IssuedCode[] = [];
    const skipped: string[] = [];
    for (const e of slice) {
      if (!emailFor(e)) { skipped.push(e.employeeId + ' — no email on record'); continue; }
      try {
        issued.push(await provision({ userId: e.employeeId, role: 'Employee', name: e.name, email: '' }, user.userId, input.sendEmail));
      } catch (err) {
        skipped.push(e.employeeId + ' — ' + (err instanceof UserError ? err.message : 'failed'));
        if (!(err instanceof UserError)) console.error('bulk login ' + e.employeeId, err);
      }
    }
    const done = rest.length <= slice.length;
    const remaining = rest.length - slice.length;
    const emailed = issued.filter((x) => x.emailed).length;
    return {
      message: plural(issued.length, 'login') + ' created in this batch' + (emailed ? ', ' + emailed + ' emailed' : '') +
        (done ? '. Done.' : ' — ' + remaining + ' still to go.'),
      data: { issued: issued.map(({ userId, name, email, emailed: em, code, expiresInMinutes }) => ({ userId, name, email, emailed: em, code, expiresInMinutes })), skipped, done, cursor: slice.length ? slice[slice.length - 1].employeeId : cursor, total: candidates.length },
      effects: [() => audit(user.userId, 'Admin', 'BULK_LOGINS', issued.length + ' created (' + emailed + ' emailed), ' + skipped.length + ' skipped')],
    };
  });
}
