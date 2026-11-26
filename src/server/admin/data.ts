import 'server-only';
import { taxPositionUsable, type TaxPosition } from '@/domain';
import { db } from '@/lib/firebase';
import {
  COL, type ApplicationDoc, type AuditDoc, type EmployeeDoc, type FmvDoc, type GrantDoc, type PartnerRequestDoc, type UserDoc,
  type WindowDoc,
} from '@/lib/schema';
import { latestPartnerRequest, normalizeApplication } from '../core/applications';
import { normalizeEmployee, normalizeGrant } from '../core/employees';
import { normalizePartnerRequest } from '../partnerRequests';
import { normalizeWindow } from '../windows';

/**
 * Whole-collection reads for the admin screens. The collections are small
 * (≈2,150 participants, ≈3,600 grants, a few thousand applications a year),
 * so the screens read them and filter in memory — which also means no
 * composite Firestore indexes are needed.
 */

export async function allEmployees(): Promise<EmployeeDoc[]> {
  const snap = await db().collection(COL.employees).get();
  return snap.docs.map((d) => normalizeEmployee(d.data(), d.id));
}

export async function allGrants(): Promise<GrantDoc[]> {
  const snap = await db().collection(COL.grants).get();
  return snap.docs.map((d) => normalizeGrant(d.data(), d.id));
}

/** Grants without their tranche detail (the participants list and health checks). */
export async function grantFigures(): Promise<GrantDoc[]> {
  const snap = await db().collection(COL.grants)
    .select('grantId', 'employeeId', 'planName', 'multiplier', 'vestedOptions', 'unvestedOptions', 'reportAsOn', 'lastSyncedAt').get();
  return snap.docs.map((d) => normalizeGrant(d.data(), d.id));
}

export async function allUsers(): Promise<UserDoc[]> {
  const snap = await db().collection(COL.users).get();
  return snap.docs.map((d) => ({ ...(d.data() as UserDoc), userId: d.id }));
}

export async function allApplications(): Promise<ApplicationDoc[]> {
  const snap = await db().collection(COL.applications).get();
  return snap.docs.map((d) => normalizeApplication(d.data(), d.id));
}

export async function allPartnerRequests(): Promise<PartnerRequestDoc[]> {
  const snap = await db().collection(COL.partnerRequests).get();
  return snap.docs.map((d) => normalizePartnerRequest(d.data(), d.id));
}

/** The latest request of each application. */
export function latestRequestByApp(rows: readonly PartnerRequestDoc[]): Map<string, PartnerRequestDoc> {
  const byApp = new Map<string, PartnerRequestDoc[]>();
  rows.forEach((r) => byApp.set(r.appId, [...(byApp.get(r.appId) ?? []), r]));
  const out = new Map<string, PartnerRequestDoc>();
  byApp.forEach((list, appId) => { const l = latestPartnerRequest(list); if (l) out.set(appId, l); });
  return out;
}

export async function employeesById(ids: readonly string[]): Promise<Map<string, EmployeeDoc>> {
  const unique = [...new Set(ids.map((x) => x.trim().toUpperCase()).filter((x) => x && !x.includes('/')))];
  const out = new Map<string, EmployeeDoc>();
  for (let i = 0; i < unique.length; i += 300) {
    const refs = unique.slice(i, i + 300).map((id) => db().collection(COL.employees).doc(id));
    const snaps = await db().getAll(...refs);
    snaps.forEach((s) => { if (s.exists) out.set(s.id, normalizeEmployee(s.data(), s.id)); });
  }
  return out;
}

/** Tax.covered + Tax.status: who the loaded tax sheet can price, and what is loaded. */
export async function taxSheetState(): Promise<{
  covered: Set<string>; rows: number; asOn: string; loadedAt: string; loadedBy: string; flags: Record<string, number>; flagged: Record<string, string[]>;
}> {
  const snap = await db().collection(COL.taxPositions).get();
  const covered = new Set<string>();
  const flags: Record<string, number> = {};
  const flagged: Record<string, string[]> = {};
  let asOn = '', loadedAt = '', loadedBy = '';
  snap.docs.forEach((d) => {
    const t = d.data() as TaxPosition & { loadedAt?: string; loadedBy?: string };
    if (taxPositionUsable(t).ok) covered.add(d.id.toUpperCase());
    const list = Array.isArray(t.flags) ? t.flags : String(t.flags ?? '').split(',').filter(Boolean);
    list.forEach((f) => { flags[f] = (flags[f] || 0) + 1; (flagged[f] = flagged[f] ?? []).push(d.id); });
    if (!asOn) { asOn = String(t.asOn ?? ''); loadedAt = String(t.loadedAt ?? ''); loadedBy = String(t.loadedBy ?? ''); }
  });
  return { covered, rows: snap.size, asOn, loadedAt, loadedBy, flags, flagged };
}

export async function listWindows(): Promise<WindowDoc[]> {
  const snap = await db().collection(COL.windows).get();
  return snap.docs.map((d) => normalizeWindow(d.data(), d.id)).sort((a, b) => b.windowId.localeCompare(a.windowId));
}

export async function recentPrices(limit = 90): Promise<FmvDoc[]> {
  const snap = await db().collection(COL.fmv).orderBy('date', 'desc').limit(limit).get();
  return snap.docs.map((d) => {
    const f = d.data() as Partial<FmvDoc>;
    return {
      date: String(f.date || d.id), openPrice: Number(f.openPrice) || 0, closePrice: Number(f.closePrice) || 0,
      fmv: Number(f.fmv) || 0, source: String(f.source ?? ''), enteredBy: String(f.enteredBy ?? ''), enteredAt: String(f.enteredAt ?? ''),
    };
  });
}

export interface AuditRow extends AuditDoc {
  id: string;
}

/** The audit trail of one application, newest first (equality query, sorted here: no index needed). */
export async function auditForApp(appId: string, limit = 200): Promise<AuditRow[]> {
  const snap = await db().collection(COL.auditLog).where('appId', '==', appId).limit(1000).get();
  return snap.docs.map((d) => ({ ...(d.data() as AuditDoc), id: d.id }))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
