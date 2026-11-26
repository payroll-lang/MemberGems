/** Reading employee and grant documents tolerantly (Domain.employee / employeeView). */
import { isBlocked, num, toDateKey, trim, type GrantRecord, type Numeric } from '@/domain';
import type { EmployeeDoc, GrantDoc, Tranche } from '@/lib/schema';
import { dematFrom } from './applications';

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const s = (v: unknown): string => trim(v);
const nn = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = num(v as Numeric, NaN);
  return isNaN(x) ? null : x;
};

export function normalizeEmployee(raw: unknown, id?: string): EmployeeDoc {
  const e = o(raw);
  return {
    employeeId: (s(e.employeeId) || s(id)).toUpperCase(),
    name: s(e.name),
    designation: s(e.designation),
    stakeholderCategory: s(e.stakeholderCategory),
    accessEmail: s(e.accessEmail),
    secondaryEmail: s(e.secondaryEmail),
    emailOverride: s(e.emailOverride),
    mobile: s(e.mobile),
    address: s(e.address),
    nationality: s(e.nationality),
    pan: s(e.pan).toUpperCase(),
    employmentStatus: s(e.employmentStatus),
    separationDate: s(e.separationDate),
    resignationDate: s(e.resignationDate),
    ctc: nn(e.ctc),
    taxRatePercent: nn(e.taxRatePercent),
    blocked: isBlocked({ employeeId: '', blocked: e.blocked }),
    blockedReason: s(e.blockedReason),
    blockedAt: s(e.blockedAt),
    blockedBy: s(e.blockedBy),
    demat: dematFrom(e.demat),
    remarks: s(e.remarks),
    updatedAt: s(e.updatedAt),
  };
}

/** Domain.emailFor: override, else access email, else secondary. */
export function emailFor(e: Pick<EmployeeDoc, 'emailOverride' | 'accessEmail' | 'secondaryEmail'>): string {
  return trim(e.emailOverride) || trim(e.accessEmail) || trim(e.secondaryEmail);
}

function tranche(v: unknown): Tranche {
  const t = o(v);
  return { id: s(t.id), vd: s(t.vd), avd: s(t.avd), v: num(t.v as Numeric, 0), u: num(t.u as Numeric, 0), e: num(t.e as Numeric, 0), p: num(t.p as Numeric, 0) };
}

export function normalizeGrant(raw: unknown, id?: string): GrantDoc {
  const g = o(raw);
  let tranches: unknown = g.tranches;
  if (typeof tranches === 'string') {
    try { tranches = JSON.parse(tranches); } catch { tranches = []; }
  }
  const n0 = (v: unknown) => num(v as Numeric, 0);
  return {
    grantId: s(g.grantId) || s(id),
    employeeId: s(g.employeeId).toUpperCase(),
    planName: s(g.planName),
    multiplier: num(g.multiplier as Numeric, 1) || 1,
    grantDate: toDateKey(g.grantDate),
    exercisePrice: n0(g.exercisePrice),
    typeOfVesting: s(g.typeOfVesting),
    grantStatus: s(g.grantStatus),
    totalGranted: n0(g.totalGranted),
    unvestedOptions: n0(g.unvestedOptions),
    vestedOptions: n0(g.vestedOptions),
    exercisedOptions: n0(g.exercisedOptions),
    exercisePendingOptions: n0(g.exercisePendingOptions),
    cancelledOptions: n0(g.cancelledOptions),
    trancheCount: n0(g.trancheCount),
    vestedTrancheCount: n0(g.vestedTrancheCount),
    nextVestDate: toDateKey(g.nextVestDate),
    lastVestDate: toDateKey(g.lastVestDate),
    expiryDate: toDateKey(g.expiryDate),
    tranches: Array.isArray(tranches) ? tranches.map(tranche) : [],
    reportAsOn: toDateKey(g.reportAsOn),
    lastSyncedAt: s(g.lastSyncedAt),
  };
}

/** A grant as the rules engine reads it. A blank exercise price falls back to EXERCISE_PRICE there. */
export function grantRecord(g: GrantDoc): GrantRecord {
  return {
    ...g,
    exercisePrice: g.exercisePrice || undefined,
  };
}
