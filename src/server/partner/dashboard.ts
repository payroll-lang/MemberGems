import 'server-only';
import { prettyDate, prettyStamp, trim, windowKey } from '@/domain';
import { db } from '@/lib/firebase';
import { COL, type UserDoc } from '@/lib/schema';
import { todayIst } from '@/lib/time';
import { normalizeApplication } from '../applications';
import { emailFor, normalizeEmployee } from '../employees';
import { fileMetas, type FileMeta } from '../files';
import { partnerRequestsForPartner } from '../partnerRequests';
import { loadSettings } from '../settings';
import { partnerContext } from './mutations';
import { dematMismatch, isPartnerEditable, partnerSummary, sortRequests, type PartnerSummary } from './rules';

/**
 * PartnerApi.dashboard: only this partner's requests, but for those the whole
 * picture — the partner is the counterparty to the shares. What a partner
 * never gets is the participant's own evidence (PAN card, CML, exercise
 * payment proof): only the files the partner uploaded are linked.
 */

export interface PartnerRow {
  requestId: string;
  appId: string;
  employeeId: string;
  employeeName: string;
  windowId: string;
  employeeEmail: string;
  employeeMobile: string;
  pan: string;
  totalOptions: number;
  totalShares: number;
  exerciseAmount: number;
  fmvValue: number;
  prettyFmvDate: string;
  perquisiteAmount: number;
  taxAmount: number;
  taxDueDate: string;
  prettyTaxDueDate: string;
  status: string;
  assignedAt: string;
  demat: {
    dpName: string; dpId: string; clientId: string; accountType: string; accountName: string;
    providedBy: string; providedAt: string; cml: FileMeta | null; complete: boolean;
  };
  /** What the participant entered themselves (the snapshot once the partner's account replaced it). */
  ownDemat: { dpName: string; dpId: string; clientId: string; accountType: string };
  mismatch: boolean;
  payment: { utr: string; date: string; prettyDate: string; amount: number; bank: string; proof: FileMeta | null };
  fedBy: string;
  fedAt: string;
  remarks: string;
  editable: boolean;
  overdue: boolean;
}

export interface PartnerDashboard {
  partnerName: string;
  today: string;
  rows: PartnerRow[];
  summary: PartnerSummary;
  bankDetails: string;
}

export async function loadPartnerDashboard(user: UserDoc): Promise<PartnerDashboard> {
  const ctx = partnerContext(user);
  const today = todayIst();
  const [settings, requests] = await Promise.all([loadSettings(), partnerRequestsForPartner(ctx.partnerId)]);
  const appIds = [...new Set(requests.map((r) => r.appId).filter((x) => x && !x.includes('/')))];
  const empIds = [...new Set(requests.map((r) => r.employeeId.toUpperCase()).filter((x) => x && !x.includes('/')))];
  const [appSnaps, empSnaps] = await Promise.all([
    appIds.length ? db().getAll(...appIds.map((id) => db().collection(COL.applications).doc(id))) : Promise.resolve([]),
    empIds.length ? db().getAll(...empIds.map((id) => db().collection(COL.employees).doc(id))) : Promise.resolve([]),
  ]);
  const apps = new Map(appSnaps.filter((s) => s.exists).map((s) => [s.id, normalizeApplication(s.data(), s.id)]));
  const emps = new Map(empSnaps.filter((s) => s.exists).map((s) => [s.id, normalizeEmployee(s.data(), s.id)]));
  // Only the partner's own uploads are ever looked up.
  const files = await fileMetas(requests.flatMap((r) => [r.partnerDemat.cmlFileId, r.payment.proofFileId]));

  const rows = requests.map((r): PartnerRow => {
    const app = apps.get(r.appId) ?? null;
    const emp = emps.get(r.employeeId.toUpperCase()) ?? null;
    const held = !!app?.dematSource;
    const snap = r.employeeDemat;
    const own = {
      dpName: snap?.dpName || (held ? '' : app?.demat.dpName ?? ''),
      dpId: snap?.dpId || (held ? '' : app?.demat.dpId ?? ''),
      clientId: snap?.clientId || (held ? '' : app?.demat.clientId ?? ''),
      accountType: snap?.accountType || (held ? '' : app?.demat.accountType ?? ''),
    };
    const pd = r.partnerDemat;
    const editable = isPartnerEditable(r.status);
    const taxDueDate = app?.taxDueDate ?? '';
    return {
      requestId: r.requestId, appId: r.appId, employeeId: r.employeeId, employeeName: emp?.name ?? '',
      windowId: windowKey(app?.windowId), employeeEmail: emp ? emailFor(emp) : '',
      employeeMobile: trim(app?.applicant.mobile) || emp?.mobile || '', pan: trim(app?.applicant.pan) || emp?.pan || '',
      totalOptions: app?.totalOptions ?? 0, totalShares: app?.totalShares ?? 0, exerciseAmount: app?.exerciseAmount ?? 0,
      fmvValue: app?.fmvValue ?? 0, prettyFmvDate: prettyDate(app?.fmvDate), perquisiteAmount: app?.perquisiteAmount ?? 0,
      taxAmount: r.taxAmount, taxDueDate, prettyTaxDueDate: prettyDate(taxDueDate), status: r.status,
      assignedAt: prettyStamp(r.assignedAt),
      demat: {
        dpName: pd.dpName, dpId: pd.dpId, clientId: pd.clientId, accountType: pd.accountType, accountName: pd.accountName,
        providedBy: pd.providedBy, providedAt: prettyStamp(pd.providedAt), cml: files.get(pd.cmlFileId) ?? null,
        complete: !!(pd.dpId && pd.clientId && pd.accountType && pd.cmlFileId),
      },
      ownDemat: own,
      mismatch: !!(pd.dpId && pd.clientId && pd.accountType && pd.cmlFileId) && dematMismatch(own, pd),
      payment: {
        utr: r.payment.utr, date: r.payment.date, prettyDate: prettyDate(r.payment.date), amount: r.payment.amount,
        bank: r.payment.bank, proof: files.get(r.payment.proofFileId) ?? null,
      },
      fedBy: r.fedBy, fedAt: prettyStamp(r.fedAt), remarks: r.remarks, editable,
      overdue: editable && !!taxDueDate && taxDueDate < today,
    };
  });

  const sorted = sortRequests(rows);
  return {
    partnerName: ctx.partnerName, today, rows: sorted, summary: partnerSummary(sorted, today),
    bankDetails: settings.text.TAX_BANK_DETAILS,
  };
}
