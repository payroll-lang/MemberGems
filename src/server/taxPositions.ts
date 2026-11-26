import 'server-only';
import type { TaxPosition } from '@/domain';
import { db } from '@/lib/firebase';
import { COL } from '@/lib/schema';
import { getDoc, type Tx } from './db';

/** Payroll's year-to-date position for a participant (TaxSheet row), or null. */
export async function getTaxPosition(employeeId: string, tx?: Tx): Promise<TaxPosition | null> {
  const snap = await getDoc(db().collection(COL.taxPositions).doc(employeeId.trim().toUpperCase()), tx);
  if (!snap.exists) return null;
  const d = snap.data() as Record<string, unknown>;
  return {
    employeeId: String(d.employeeId ?? snap.id),
    regime: d.regime,
    netTaxable: d.netTaxable as number,
    totalGross: d.totalGross as number,
    projectedGross: d.projectedGross as number,
    totalTax: d.totalTax as number,
    previousTds: d.previousTds as number,
    outsideTax: d.outsideTax as number,
    tdsToDate: d.tdsToDate as number,
    remainingMonths: d.remainingMonths as number,
    asOn: d.asOn,
    flags: Array.isArray(d.flags) ? (d.flags as string[]) : String(d.flags ?? ''),
  };
}
