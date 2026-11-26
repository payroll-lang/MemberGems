import 'server-only';
import { trim } from '@/domain';
import { db } from '@/lib/firebase';
import { COL, type EmployeeDoc, type UserDoc } from '@/lib/schema';
import { emailFor } from '../employees';

/**
 * Where a participant's email goes: the notification address of their
 * login if they have one (Auth.notificationEmailFor), else the master's
 * address (Domain.emailFor).
 */
export async function employeeNotifyEmail(emp: EmployeeDoc): Promise<string> {
  return (await employeeNotifyEmails([emp])).get(emp.employeeId) ?? '';
}

/** The same for many participants, in one batched read of their logins. */
export async function employeeNotifyEmails(emps: readonly EmployeeDoc[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!emps.length) return out;
  const refs = emps.map((e) => db().collection(COL.users).doc(e.employeeId.toUpperCase()));
  const snaps = await db().getAll(...refs);
  emps.forEach((e, i) => {
    const u = snaps[i].exists ? (snaps[i].data() as UserDoc) : null;
    const viaLogin = u && u.role === 'Employee' ? trim(u.notifyEmail) || trim(u.loginEmails?.[0]) : '';
    out.set(e.employeeId, viaLogin || emailFor(e));
  });
  return out;
}

/** A FundPartner login's address. */
export function loginAddress(u: UserDoc): string {
  return trim(u.notifyEmail) || trim(u.loginEmails?.[0]);
}
