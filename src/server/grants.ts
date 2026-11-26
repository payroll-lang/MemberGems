import 'server-only';
import { db } from '@/lib/firebase';
import { COL, type GrantDoc } from '@/lib/schema';
import { normalizeGrant } from './core/employees';
import { getQuery, type Tx } from './db';

export { grantRecord, normalizeGrant } from './core/employees';

/** Every grant on the participant's record (the synced vesting report). */
export async function grantsForEmployee(employeeId: string, tx?: Tx): Promise<GrantDoc[]> {
  const q = db().collection(COL.grants).where('employeeId', '==', employeeId.trim().toUpperCase());
  const snap = await getQuery(q, tx);
  return snap.docs.map((d) => normalizeGrant(d.data(), d.id));
}
