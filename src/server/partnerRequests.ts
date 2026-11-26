import 'server-only';
import { db } from '@/lib/firebase';
import { COL, type PartnerRequestDoc } from '@/lib/schema';
import { dematFrom, latestPartnerRequest } from './core/applications';
import { getDoc, getQuery, type Tx } from './db';

export function partnerRequestRef(requestId: string) {
  return db().collection(COL.partnerRequests).doc(requestId);
}

export function normalizePartnerRequest(raw: unknown, id: string): PartnerRequestDoc {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pay = (r.payment ?? {}) as Record<string, unknown>;
  const pd = (r.partnerDemat ?? {}) as Record<string, unknown>;
  const ed = r.employeeDemat as Record<string, unknown> | null | undefined;
  const str = (v: unknown) => String(v ?? '').trim();
  return {
    requestId: str(r.requestId) || id,
    appId: str(r.appId),
    employeeId: str(r.employeeId),
    fundPartnerId: str(r.fundPartnerId),
    fundPartnerName: str(r.fundPartnerName),
    taxAmount: Number(r.taxAmount) || 0,
    status: (str(r.status) || 'Assigned') as PartnerRequestDoc['status'],
    assignedAt: str(r.assignedAt),
    payment: { utr: str(pay.utr), date: str(pay.date), amount: Number(pay.amount) || 0, bank: str(pay.bank), proofFileId: str(pay.proofFileId) },
    fedBy: str(r.fedBy),
    fedAt: str(r.fedAt),
    remarks: str(r.remarks),
    partnerDemat: { ...dematFrom(pd), cmlFileId: str(pd.cmlFileId), providedBy: str(pd.providedBy), providedAt: str(pd.providedAt) },
    employeeDemat: ed ? { ...dematFrom(ed), cmlFileId: str(ed.cmlFileId) } : null,
  };
}

export async function getPartnerRequest(requestId: string, tx?: Tx): Promise<PartnerRequestDoc | null> {
  const snap = await getDoc(partnerRequestRef(requestId), tx);
  return snap.exists ? normalizePartnerRequest(snap.data(), snap.id) : null;
}

/** Every request ever raised for an application, oldest first. */
export async function partnerRequestsForApp(appId: string, tx?: Tx): Promise<PartnerRequestDoc[]> {
  const snap = await getQuery(db().collection(COL.partnerRequests).where('appId', '==', appId), tx);
  return snap.docs.map((d) => normalizePartnerRequest(d.data(), d.id))
    .sort((a, b) => a.assignedAt.localeCompare(b.assignedAt));
}

/** AppStore.partnerRequestOf: the latest request of an application. */
export async function partnerRequestOf(appId: string, tx?: Tx): Promise<PartnerRequestDoc | null> {
  return latestPartnerRequest(await partnerRequestsForApp(appId, tx));
}

/** A partner's own requests (for the partner portal). */
export async function partnerRequestsForPartner(partnerId: string, tx?: Tx): Promise<PartnerRequestDoc[]> {
  const snap = await getQuery(db().collection(COL.partnerRequests).where('fundPartnerId', '==', partnerId), tx);
  return snap.docs.map((d) => normalizePartnerRequest(d.data(), d.id))
    .sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
}
