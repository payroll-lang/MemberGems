import 'server-only';
import { db } from '@/lib/firebase';
import { COL, type ApplicationDoc, type ApplicationLineDoc, type TaxPaymentDoc } from '@/lib/schema';
import { normalizeApplication, normalizeLine, normalizeTaxPayment, sortTaxPayments } from './core/applications';
import { getDoc, getQuery, type Tx } from './db';

export * from './core/applications';

export const LINES = 'lines';
export const TAX_PAYMENTS = 'taxPayments';

export function appRef(appId: string) {
  return db().collection(COL.applications).doc(appId);
}
export function linesCol(appId: string) {
  return appRef(appId).collection(LINES);
}
export function taxPaymentsCol(appId: string) {
  return appRef(appId).collection(TAX_PAYMENTS);
}

export async function getApplication(appId: string, tx?: Tx): Promise<ApplicationDoc | null> {
  const id = appId.trim();
  if (!id || id.includes('/')) return null;
  const snap = await getDoc(appRef(id), tx);
  return snap.exists ? normalizeApplication(snap.data(), snap.id) : null;
}

/** Every application of one participant (a handful), newest window first. */
export async function applicationsForEmployee(employeeId: string, tx?: Tx): Promise<ApplicationDoc[]> {
  const q = db().collection(COL.applications).where('employeeId', '==', employeeId.trim().toUpperCase());
  const snap = await getQuery(q, tx);
  return snap.docs.map((d) => normalizeApplication(d.data(), d.id))
    .sort((a, b) => b.windowId.localeCompare(a.windowId) || b.createdAt.localeCompare(a.createdAt));
}

/** Applications in any of the given statuses (admin queue). */
export async function applicationsWithStatus(statuses: ApplicationDoc['status'][], tx?: Tx): Promise<ApplicationDoc[]> {
  if (!statuses.length) return [];
  const q = db().collection(COL.applications).where('status', 'in', statuses.slice(0, 30));
  const snap = await getQuery(q, tx);
  return snap.docs.map((d) => normalizeApplication(d.data(), d.id));
}

/** Every application in a window (exports, jobs). */
export async function applicationsInWindow(windowId: string, tx?: Tx): Promise<ApplicationDoc[]> {
  const snap = await getQuery(db().collection(COL.applications).where('windowId', '==', windowId), tx);
  return snap.docs.map((d) => normalizeApplication(d.data(), d.id));
}

/** AppStore.linesOf: the option lines, zero lines dropped. */
export async function linesOf(appId: string, tx?: Tx): Promise<ApplicationLineDoc[]> {
  const snap = await getQuery(linesCol(appId), tx);
  return snap.docs.map((d) => ({ ...normalizeLine(d.data(), d.id), lineId: d.id, appId }))
    .filter((l) => l.optionsExercised > 0)
    .sort((a, b) => a.grantId.localeCompare(b.grantId));
}

/** Line documents including zero ones, with their refs (to replace them). */
export async function lineRefsOf(appId: string, tx?: Tx) {
  const snap = await getQuery(linesCol(appId), tx);
  return snap.docs.map((d) => d.ref);
}

export async function linesForApps(appIds: readonly string[], tx?: Tx): Promise<Map<string, ApplicationLineDoc[]>> {
  const out = new Map<string, ApplicationLineDoc[]>();
  const all = await Promise.all(appIds.map((id) => linesOf(id, tx)));
  appIds.forEach((id, i) => out.set(id, all[i]));
  return out;
}

/** AppStore.taxPaymentsOf: every remittance, in order. */
export async function taxPaymentsOf(appId: string, tx?: Tx): Promise<TaxPaymentDoc[]> {
  const snap = await getQuery(taxPaymentsCol(appId), tx);
  return sortTaxPayments(snap.docs.map((d) => ({ ...normalizeTaxPayment(d.data(), d.id), paymentId: d.id, appId })));
}
