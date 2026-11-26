import 'server-only';
import { PARTNER_STATUS, trim } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { partnerIdFor } from '@/lib/migration/parse';
import { COL, type FundPartnerDoc, type UserDoc } from '@/lib/schema';
import { nowIso } from '@/lib/time';
import { UserError, type ActionResult } from '../core/errors';
import { getPartner, listPartners } from '../partners';
import { allPartnerRequests, allUsers } from './data';
import { createLogin, partnerUserId } from './logins';
import { idList, runAdmin } from './run';

/**
 * Fund partners (Partners.gs, AdminApi.partnerList / savePartner /
 * createPartnerLogin / setPartnerStatus). Partners are never deleted, only
 * retired, and a name is never edited once created: applications and
 * requests keep pointing at the partner.
 */

const OPEN: string[] = [PARTNER_STATUS.ASSIGNED, PARTNER_STATUS.SENT_BACK, PARTNER_STATUS.PAID];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface PartnerRow extends FundPartnerDoc {
  logins: { userId: string; email: string; status: string; lastLoginAt: string }[];
  activeLogins: number;
  selectable: boolean;
  openRequests: number;
  openAppIds: string[];
  totalRequests: number;
}

export async function loadPartners(): Promise<PartnerRow[]> {
  const [partners, users, prs] = await Promise.all([listPartners(), allUsers(), allPartnerRequests()]);
  return partners.map((p) => {
    const logins = users.filter((u) => u.role === 'FundPartner' && u.fundPartnerId === p.partnerId);
    const active = logins.filter((u) => u.status === 'Active');
    const mine = prs.filter((r) => r.fundPartnerId === p.partnerId);
    const open = mine.filter((r) => OPEN.includes(r.status));
    return {
      ...p,
      logins: logins.map((u) => ({ userId: u.userId, email: u.loginEmails?.[0] ?? '', status: u.status, lastLoginAt: u.lastLoginAt ?? '' })),
      activeLogins: active.length,
      selectable: p.status === 'Active' && active.length > 0,
      openRequests: open.length,
      openAppIds: open.map((r) => r.appId),
      totalRequests: mine.length,
    };
  });
}

function emailList(v: string): string[] {
  return trim(v).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** Partners.save + AdminApi.savePartner: add a partner (and its login), or update contacts and notes. */
export function savePartner(user: UserDoc, input: { partnerId: string; name: string; contactEmails: string; notes: string; createLogin: boolean; sendEmail: boolean }): Promise<ActionResult> {
  return runAdmin(user, 'savePartner', async () => {
    const emails = emailList(input.contactEmails);
    const bad = emails.find((e) => !EMAIL.test(e));
    if (bad) throw new UserError('"' + bad + '" does not look like an email address.');
    const now = nowIso();
    const editing = trim(input.partnerId);
    let partner: FundPartnerDoc;
    let created = false;
    if (editing) {
      const p = await getPartner(editing);
      if (!p) throw new UserError('That fund partner was not found.');
      await db().collection(COL.fundPartners).doc(p.partnerId).update({ contactEmails: emails, notes: trim(input.notes), updatedAt: now, updatedBy: user.userId });
      partner = { ...p, contactEmails: emails, notes: trim(input.notes) };
    } else {
      const name = trim(input.name);
      if (!name) throw new UserError('Enter the fund partner’s name.');
      if (name.length < 3) throw new UserError('That name is too short to be recognisable.');
      const id = partnerIdFor(name);
      if (!id) throw new UserError('That name has no letters or digits.');
      const all = await listPartners();
      const same = all.find((p) => p.partnerId === id || p.name.toLowerCase() === name.toLowerCase());
      if (same) throw new UserError('"' + same.name + '" is already on record. Edit its contacts instead — a partner’s name is never changed.');
      partner = {
        partnerId: id, name, status: 'Active', contactEmails: emails, notes: trim(input.notes),
        createdAt: now, createdBy: user.userId, updatedAt: now, updatedBy: user.userId,
      };
      await db().collection(COL.fundPartners).doc(id).create(partner);
      created = true;
    }
    await audit(user.userId, 'Admin', created ? 'PARTNER_ADDED' : 'PARTNER_UPDATED', partner.name + ' — ' + (emails.join(', ') || 'no contacts'));

    const hasLogin = (await allUsers()).some((u) => u.role === 'FundPartner' && u.fundPartnerId === partner.partnerId);
    let loginMsg = '';
    let issued: unknown = undefined;
    if (input.createLogin && !hasLogin) {
      if (!emails.length) {
        loginMsg = ' No login was created: add a contact address first — the sign-in code has to go somewhere.';
      } else {
        const r = await createLogin(user, { userId: partnerUserId(partner.name), role: 'FundPartner', name: partner.name, email: emails[0], partnerId: partner.partnerId, sendEmail: input.sendEmail });
        loginMsg = ' ' + (r.ok ? r.message : 'The login could not be created: ' + r.error);
        if (r.ok) issued = (r.data as { issued?: unknown })?.issued;
      }
    } else if (!hasLogin) {
      loginMsg = ' They still need a portal login before participants can choose them.';
    }
    return {
      message: (created ? partner.name + ' added.' : 'Contact details updated for ' + partner.name + '.') + loginMsg,
      data: issued ? { issued } : undefined,
    };
  });
}

/** Create (or re-issue) a login for a partner. */
export function createPartnerLogin(user: UserDoc, input: { partnerId: string; email: string; sendEmail: boolean }): Promise<ActionResult> {
  return runAdmin(user, 'createPartnerLogin', async () => {
    const p = await getPartner(trim(input.partnerId));
    if (!p) throw new UserError('That fund partner was not found.');
    const email = trim(input.email) || p.contactEmails[0] || '';
    if (!email) throw new UserError('Add a contact address for ' + p.name + ' first — the sign-in code has to go somewhere.');
    // A second login for the same partner gets its own ID.
    const existing = (await allUsers()).filter((u) => u.role === 'FundPartner' && u.fundPartnerId === p.partnerId);
    const mineForEmail = existing.find((u) => (u.loginEmails ?? []).includes(email.toLowerCase()));
    const base = partnerUserId(p.name);
    let userId = mineForEmail?.userId ?? base;
    if (!mineForEmail && existing.some((u) => u.userId === base)) {
      let n = 2;
      while (existing.some((u) => u.userId === base + '-' + n)) n++;
      userId = (base + '-' + n).slice(0, 50);
    }
    const r = await createLogin(user, { userId, role: 'FundPartner', name: p.name, email, partnerId: p.partnerId, sendEmail: input.sendEmail });
    if (!r.ok) throw new UserError(r.error);
    return { message: r.message, data: r.data };
  });
}

/** Partners.setStatus: retiring is refused while requests are open with them. */
export function setPartnerStatus(user: UserDoc, input: { partnerId: string; status: string }): Promise<ActionResult> {
  return runAdmin(user, 'setPartnerStatus', async () => {
    const p = await getPartner(trim(input.partnerId));
    if (!p) throw new UserError('That fund partner was not found.');
    const want = input.status === 'Retired' ? 'Retired' : input.status === 'Active' ? 'Active' : '';
    if (!want) throw new UserError('Status must be Active or Retired.');
    if (want === 'Retired') {
      const open = (await allPartnerRequests()).filter((r) => r.fundPartnerId === p.partnerId && OPEN.includes(r.status));
      if (open.length) {
        throw new UserError(p.name + ' still has ' + open.length + ' request' + (open.length === 1 ? '' : 's') + ' in progress (' +
          idList(open.map((r) => r.appId)) + '). Settle or reassign those before retiring them, or the participants are left with nobody able to pay their tax.');
      }
    }
    await db().collection(COL.fundPartners).doc(p.partnerId).update({ status: want, updatedAt: nowIso(), updatedBy: user.userId });
    return {
      message: want === 'Retired' ? p.name + ' retired. Existing applications keep working; no new one can choose them.' : p.name + ' is available again.',
      effects: [() => audit(user.userId, 'Admin', 'PARTNER_STATUS', p.name + ' -> ' + want)],
    };
  });
}
