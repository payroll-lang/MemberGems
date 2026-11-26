import 'server-only';
import { FieldValue } from 'firebase-admin/firestore';
import { audit } from '../audit';
import { env } from '../env';
import { db } from '../firebase';
import { COL, type EmployeeDoc, type SessionDoc, type UserDoc, type UserSecretDoc } from '../schema';
import { addMinutes, nowIso } from '../time';
import {
  hashCode,
  hashPassword,
  newOneTimeCode,
  newSessionToken,
  passwordProblem,
  safeEqualHex,
  sha256Hex,
  verifyPassword,
} from './crypto';
import { verifyLegacyPassword } from './legacyHash';

export const SESSION_HOURS = 8;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 20;
const CODE_MINUTES = 30;
const MAX_CODE_ATTEMPTS = 5;
const IP_WINDOW_MINUTES = 15;
const IP_MAX_ATTEMPTS = 30;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

const GENERIC_LOGIN_ERROR = 'That sign-in did not work. Check your employee code or email and your password.';

/** Find a user by user ID (employee code) or any email on record. */
export async function resolveUser(identifier: string): Promise<UserDoc | null> {
  const id = (identifier ?? '').trim();
  if (!id) return null;
  const users = db().collection(COL.users);
  if (!id.includes('@')) {
    const snap = await users.doc(id.toUpperCase()).get();
    return snap.exists ? (snap.data() as UserDoc) : null;
  }
  const q = await users.where('loginEmails', 'array-contains', id.toLowerCase()).limit(2).get();
  // An address shared by two logins is ambiguous; refuse rather than guess.
  return q.size === 1 ? (q.docs[0].data() as UserDoc) : null;
}

/** Per-IP throttle across all accounts (the old portal only limited per account). */
async function throttleIp(ip: string): Promise<void> {
  if (!ip) return;
  const bucket = Math.floor(Date.now() / (IP_WINDOW_MINUTES * 60_000));
  const ref = db().collection(COL.rateLimits).doc(`login:${sha256Hex(ip).slice(0, 32)}:${bucket}`);
  const count = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const n = ((snap.data()?.count as number) ?? 0) + 1;
    tx.set(ref, { count: n, expiresAt: addMinutes(new Date(), IP_WINDOW_MINUTES * 2) }, { merge: true });
    return n;
  });
  if (count > IP_MAX_ATTEMPTS) throw new AuthError('Too many attempts from this network. Try again in a few minutes.');
}

async function isBlockedEmployee(user: UserDoc): Promise<boolean> {
  if (user.role !== 'Employee') return false;
  const emp = await db().collection(COL.employees).doc(user.userId).get();
  return Boolean((emp.data() as EmployeeDoc | undefined)?.blocked);
}

async function createSession(user: UserDoc, tokenVersion: number, meta: { ip?: string; userAgent?: string }) {
  const token = newSessionToken();
  const now = new Date();
  const doc: SessionDoc = {
    userId: user.userId,
    role: user.role,
    tokenVersion,
    createdAt: nowIso(now),
    expiresAt: nowIso(addMinutes(now, SESSION_HOURS * 60)),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 300),
  };
  await db().collection(COL.sessions).doc(sha256Hex(token)).set(doc);
  return { token, expiresAt: doc.expiresAt };
}

export async function login(identifier: string, password: string, meta: { ip?: string; userAgent?: string }) {
  await throttleIp(meta.ip ?? '');
  const user = await resolveUser(identifier);
  if (!user) throw new AuthError(GENERIC_LOGIN_ERROR);
  const e = env();
  const secretRef = db().collection(COL.userSecrets).doc(user.userId);
  const secretSnap = await secretRef.get();
  const secret = secretSnap.data() as UserSecretDoc | undefined;
  if (!secret) throw new AuthError(GENERIC_LOGIN_ERROR);

  if (secret.lockedUntil && new Date(secret.lockedUntil) > new Date()) {
    throw new AuthError(`This account is locked after repeated failed attempts. Try again after ${LOCKOUT_MINUTES} minutes.`);
  }

  let ok = false;
  if (secret.scheme === 'argon2') ok = await verifyPassword(password, secret.passwordHash, e.PASSWORD_PEPPER);
  else if (secret.scheme === 'legacy' && e.LEGACY_ESOP_PEPPER && secret.legacySalt)
    ok = verifyLegacyPassword(password, secret.legacySalt, secret.passwordHash, e.LEGACY_ESOP_PEPPER);

  if (!ok) {
    const failed = (secret.failedAttempts ?? 0) + 1;
    const lock = failed >= MAX_LOGIN_ATTEMPTS;
    await secretRef.update({
      failedAttempts: lock ? 0 : failed,
      lockedUntil: lock ? nowIso(addMinutes(new Date(), LOCKOUT_MINUTES)) : FieldValue.delete(),
    });
    if (lock) await audit(user.userId, user.role, 'ACCOUNT_LOCKED', `after ${MAX_LOGIN_ATTEMPTS} failed attempts`);
    throw new AuthError(GENERIC_LOGIN_ERROR);
  }

  if (user.status !== 'Active') throw new AuthError('This login is disabled. Contact the ESOP team.');
  if (await isBlockedEmployee(user)) throw new AuthError('Your access to the portal is on hold. Contact the ESOP team.');

  const patch: Record<string, unknown> = { failedAttempts: 0, lockedUntil: FieldValue.delete() };
  if (secret.scheme === 'legacy') {
    // Upgrade the old portal's hash to Argon2id now that we hold the password.
    patch.scheme = 'argon2';
    patch.passwordHash = await hashPassword(password, e.PASSWORD_PEPPER);
    patch.legacySalt = FieldValue.delete();
  }
  await secretRef.update(patch);
  await db().collection(COL.users).doc(user.userId).update({ lastLoginAt: nowIso() });
  await audit(user.userId, user.role, 'LOGIN', secret.scheme === 'legacy' ? 'legacy hash upgraded' : '');
  const session = await createSession(user, secret.tokenVersion, meta);
  return { user, ...session };
}

/**
 * Issue a one-time code (invite or reset). Always looks successful to the
 * caller so it cannot be used to discover who has a login. Unlike the old
 * portal it does NOT clear an account lockout.
 */
export async function issueCode(user: UserDoc, purpose: 'invite' | 'reset'): Promise<string> {
  const code = newOneTimeCode();
  await db()
    .collection(COL.userSecrets)
    .doc(user.userId)
    .set(
      {
        code: {
          hash: hashCode(code, user.userId, env().PASSWORD_PEPPER),
          expiresAt: nowIso(addMinutes(new Date(), CODE_MINUTES)),
          attempts: 0,
          purpose,
        },
      },
      { merge: true },
    );
  await audit(user.userId, user.role, purpose === 'invite' ? 'INVITE_CODE_ISSUED' : 'RESET_CODE_SENT', user.notifyEmail);
  return code;
}

export async function setPasswordWithCode(
  identifier: string,
  code: string,
  newPassword: string,
  meta: { ip?: string; userAgent?: string },
) {
  await throttleIp(meta.ip ?? '');
  const problem = passwordProblem(newPassword);
  if (problem) throw new AuthError(problem);
  const user = await resolveUser(identifier);
  const invalid = new AuthError('That code is not valid or has expired. Request a new one.');
  if (!user) throw invalid;
  const ref = db().collection(COL.userSecrets).doc(user.userId);
  const e = env();

  const tokenVersion = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const s = snap.data() as UserSecretDoc | undefined;
    if (!s?.code || new Date(s.code.expiresAt) < new Date() || s.code.attempts >= MAX_CODE_ATTEMPTS) throw invalid;
    if (!safeEqualHex(hashCode(String(code).trim(), user.userId, e.PASSWORD_PEPPER), s.code.hash)) {
      tx.update(ref, { 'code.attempts': s.code.attempts + 1 });
      return null;
    }
    const v = (s.tokenVersion ?? 0) + 1;
    tx.update(ref, {
      scheme: 'argon2',
      passwordHash: await hashPassword(newPassword, e.PASSWORD_PEPPER),
      legacySalt: FieldValue.delete(),
      code: FieldValue.delete(),
      tokenVersion: v,
      failedAttempts: 0,
      lockedUntil: FieldValue.delete(),
    });
    return v;
  });
  if (tokenVersion === null) throw invalid;

  await db().collection(COL.users).doc(user.userId).update({ mustResetPassword: false });
  await audit(user.userId, user.role, 'PASSWORD_SET', 'via one-time code');
  if (user.status !== 'Active' || (await isBlockedEmployee(user))) return { user, token: null, expiresAt: null };
  const session = await createSession(user, tokenVersion, meta);
  return { user, ...session };
}

export async function changePassword(userId: string, current: string, next: string) {
  const problem = passwordProblem(next);
  if (problem) throw new AuthError(problem);
  const e = env();
  const ref = db().collection(COL.userSecrets).doc(userId);
  const s = (await ref.get()).data() as UserSecretDoc | undefined;
  if (!s || s.scheme !== 'argon2' || !(await verifyPassword(current, s.passwordHash, e.PASSWORD_PEPPER)))
    throw new AuthError('Your current password is not right.');
  await ref.update({ passwordHash: await hashPassword(next, e.PASSWORD_PEPPER), tokenVersion: (s.tokenVersion ?? 0) + 1 });
}

export async function revokeSession(token: string): Promise<void> {
  await db().collection(COL.sessions).doc(sha256Hex(token)).delete();
}

export interface Session {
  user: UserDoc;
  sessionId: string;
  expiresAt: string;
}

/** Validate a session token against the live user record. */
export async function readSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const sessionId = sha256Hex(token);
  const snap = await db().collection(COL.sessions).doc(sessionId).get();
  const s = snap.data() as SessionDoc | undefined;
  if (!s || new Date(s.expiresAt) < new Date()) return null;
  const [userSnap, secretSnap] = await Promise.all([
    db().collection(COL.users).doc(s.userId).get(),
    db().collection(COL.userSecrets).doc(s.userId).get(),
  ]);
  const user = userSnap.data() as UserDoc | undefined;
  const secret = secretSnap.data() as UserSecretDoc | undefined;
  if (!user || !secret || user.status !== 'Active' || secret.tokenVersion !== s.tokenVersion) return null;
  if (await isBlockedEmployee(user)) return null;
  return { user, sessionId, expiresAt: s.expiresAt };
}
