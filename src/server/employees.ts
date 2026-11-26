import 'server-only';
import { db } from '@/lib/firebase';
import { COL, type EmployeeDoc } from '@/lib/schema';
import { normalizeEmployee } from './core/employees';
import { UserError } from './core/errors';
import { getDoc, type Tx } from './db';

export { emailFor, normalizeEmployee } from './core/employees';

export function employeeRef(employeeId: string) {
  return db().collection(COL.employees).doc(employeeId.trim().toUpperCase());
}

export async function getEmployee(employeeId: string, tx?: Tx): Promise<EmployeeDoc | null> {
  const snap = await getDoc(employeeRef(employeeId), tx);
  return snap.exists ? normalizeEmployee(snap.data(), snap.id) : null;
}

/** Domain.employee: the record, or the legacy message. */
export async function requireEmployee(employeeId: string, tx?: Tx): Promise<EmployeeDoc> {
  const e = await getEmployee(employeeId, tx);
  if (!e) throw new UserError('Your employee record is not set up in the portal yet. Please contact the ESOP team.');
  return e;
}
