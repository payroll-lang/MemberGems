import 'server-only';
import { trim } from '@/domain';
import { db } from '@/lib/firebase';
import { COL, type EmployeeDoc, type UserDoc } from '@/lib/schema';
import { UserError, toActionResult, type ActionResult } from '../core/errors';
import { STALE_MESSAGE } from '../core/guards';
import { getDoc, type Tx } from '../db';
import { emailFor } from '../employees';

/**
 * Plumbing for the ESOP team's mutations. Each one: the caller has already
 * checked requireRole('Admin') in the server action, this checks the role
 * again, runs the body (a transaction where it touches an application), then
 * runs the follow-ups — audit entries and emails — after the commit. A failed
 * follow-up is logged and never undoes the change.
 */
export type Effect = () => Promise<unknown>;

export interface Outcome {
  message: string;
  /** A refusal that still wrote something. */
  error?: string;
  appId?: string;
  data?: unknown;
  effects?: Effect[];
}

export async function runAdmin(user: UserDoc, label: string, body: () => Promise<Outcome>): Promise<ActionResult> {
  try {
    if (user.role !== 'Admin') throw new UserError('This screen is for the ESOP team.');
    const out = await body();
    for (const effect of out.effects ?? []) {
      try { await effect(); } catch (e) { console.error('admin ' + label + ': follow-up failed', e); }
    }
    if (out.error) return { ok: false, error: out.error };
    return { ok: true, message: out.message, appId: out.appId, data: out.data };
  } catch (e) {
    // A create() that lost a race (ALREADY_EXISTS).
    if ((e as { code?: unknown })?.code === 6) return { ok: false, error: STALE_MESSAGE };
    return toActionResult(e, 'admin ' + label);
  }
}

/** Run fn in a transaction (all reads before any write — the callers keep to that). */
export function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().runTransaction(fn);
}

/** Which version of which application the page was showing. */
export interface Expect {
  appId: string;
  rev: number;
}

/**
 * AdminApi.employeeEmail: the address on the participant record (override,
 * access, secondary), else the login's own address.
 */
export async function participantAddress(employeeId: string, emp: EmployeeDoc | null, tx?: Tx): Promise<string> {
  const viaRecord = emp ? emailFor(emp) : '';
  if (viaRecord) return viaRecord;
  const snap = await getDoc(db().collection(COL.users).doc(trim(employeeId).toUpperCase()), tx);
  const u = snap.data() as UserDoc | undefined;
  return u ? trim(u.notifyEmail) || trim(u.loginEmails?.[0]) : '';
}

/** A readable list of codes, shortened for an audit line or a message. */
export function idList(ids: readonly string[], max = 20): string {
  return ids.slice(0, max).join(', ') + (ids.length > max ? ' and ' + (ids.length - max) + ' more' : '');
}

export function plural(n: number, one: string, many = one + 's'): string {
  return n + ' ' + (n === 1 ? one : many);
}
