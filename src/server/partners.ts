import 'server-only';
import { db } from '@/lib/firebase';
import { COL, type FundPartnerDoc, type UserDoc } from '@/lib/schema';
import { UserError } from './core/errors';
import { getDoc, getQuery, type Tx } from './db';

export function normalizePartner(raw: unknown, id: string): FundPartnerDoc {
  const p = (raw ?? {}) as Partial<FundPartnerDoc> & { contactEmails?: unknown };
  const emails = Array.isArray(p.contactEmails)
    ? (p.contactEmails as unknown[]).map(String)
    : String(p.contactEmails ?? '').split(/[,;\s]+/);
  return {
    partnerId: p.partnerId || id,
    name: String(p.name ?? '').trim(),
    // Legacy wrote 'Inactive'; anything not Active is retired.
    status: String(p.status ?? 'Active').trim().toLowerCase() === 'active' || !p.status ? 'Active' : 'Retired',
    contactEmails: emails.map((e) => e.trim()).filter(Boolean),
    notes: String(p.notes ?? ''),
    createdAt: String(p.createdAt ?? ''),
    createdBy: String(p.createdBy ?? ''),
    updatedAt: String(p.updatedAt ?? ''),
    updatedBy: String(p.updatedBy ?? ''),
  };
}

export async function listPartners(tx?: Tx): Promise<FundPartnerDoc[]> {
  const snap = await getQuery(db().collection(COL.fundPartners), tx);
  return snap.docs.map((d) => normalizePartner(d.data(), d.id)).filter((p) => p.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Partners still taking new business (Partners.active). */
export async function activePartners(tx?: Tx): Promise<FundPartnerDoc[]> {
  return (await listPartners(tx)).filter((p) => p.status === 'Active');
}

export async function getPartner(partnerId: string, tx?: Tx): Promise<FundPartnerDoc | null> {
  const id = partnerId.trim();
  if (!id) return null;
  const snap = await getDoc(db().collection(COL.fundPartners).doc(id), tx);
  return snap.exists ? normalizePartner(snap.data(), snap.id) : null;
}

/** Partners.requireSelectable: on record and still active, with the legacy wording. */
export async function requireSelectablePartner(partnerId: string, tx?: Tx): Promise<FundPartnerDoc> {
  const p = await getPartner(partnerId, tx);
  if (!p) throw new UserError('"' + partnerId.trim() + '" is not one of our fund partners.');
  if (p.status !== 'Active') {
    throw new UserError(p.name + ' is no longer available as a fund partner. Choose another, or pay the tax yourself.');
  }
  return p;
}

/** Partners.logins: the active FundPartner users of a partner — who can act on a request. */
export async function partnerLogins(partnerId: string, tx?: Tx): Promise<UserDoc[]> {
  const q = db().collection(COL.users).where('fundPartnerId', '==', partnerId.trim());
  const snap = await getQuery(q, tx);
  return snap.docs.map((d) => d.data() as UserDoc)
    .filter((u) => u.role === 'FundPartner' && u.status === 'Active');
}

/** Partners.notifyEmails: contact addresses plus login addresses, de-duplicated. */
export function partnerNotifyEmails(partner: FundPartnerDoc, logins: readonly UserDoc[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (e: string | undefined) => {
    const v = (e ?? '').trim();
    if (!v || seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase());
    out.push(v);
  };
  partner.contactEmails.forEach(add);
  logins.forEach((u) => add(u.notifyEmail || u.loginEmails?.[0]));
  return out;
}
