'use server';

import { refresh } from 'next/cache';
import { requireRole } from '@/lib/auth/session';
import type { Role } from '@/lib/schema';
import type { ActionResult } from '@/server/errors';
import { importUploadTicket, type ImportKind, type ImportTicket } from '@/server/admin/imports';
import { previewGrantSync, runGrantSync } from '@/server/admin/grantSync';
import { bulkCreateLogins, createLogin, newCode, setUserStatus } from '@/server/admin/logins';
import { bulkBlock, bulkDetails, bulkTaxRates, saveEmployee, setBlocked, setEnabledList } from '@/server/admin/participants';
import { createPartnerLogin, savePartner, setPartnerStatus } from '@/server/admin/partners';
import { savePrice } from '@/server/admin/prices';
import {
  approveApplication, rejectApplication, repriceApplication, reviewSection, sendBackApplication, verifySections,
} from '@/server/admin/review';
import { saveHolidays, saveSetting, saveTaxRules, taxPreview } from '@/server/admin/settingsStore';
import { loadTaxSheet } from '@/server/admin/taxSheet';
import { announceWindow, createWindow, saveWindow } from '@/server/admin/windows';
import { toActionResult } from '@/server/errors';
import type { AdminResult } from './shared';

/**
 * The ESOP team's server actions. Each re-authenticates with
 * requireRole('Admin'), turns the form into a typed request, and hands it to
 * src/server/admin, which checks every rule again (inside a transaction
 * where it touches an application) and audits the change.
 */

async function admin() {
  return (await requireRole('Admin')).user;
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v : '';
}

function all(form: FormData, key: string): string[] {
  return form.getAll(key).filter((v): v is string => typeof v === 'string');
}

function expectOf(form: FormData) {
  const rev = Number(str(form, 'rev'));
  return { appId: str(form, 'appId'), rev: Number.isFinite(rev) ? rev : -1 };
}

function finish(r: ActionResult, opts: { refresh?: boolean } = {}): AdminResult {
  if (opts.refresh !== false) refresh();
  return r.ok ? { ok: true, message: r.message, data: r.data, at: Date.now() } : { ok: false, error: r.error, at: Date.now() };
}

/* ================= review ================= */

export async function reviewSectionAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await reviewSection(user, { expect: expectOf(form), section: str(form, 'section'), verdict: str(form, 'verdict'), remarks: str(form, 'remarks') }));
}

export async function verifySectionsAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await verifySections(user, { expect: expectOf(form), sections: all(form, 'section'), all: str(form, 'all') === '1', remarks: str(form, 'remarks') }));
}

export async function approveAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await approveApplication(user, { expect: expectOf(form), remarks: str(form, 'remarks') }));
}

export async function sendBackAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await sendBackApplication(user, { expect: expectOf(form), sections: all(form, 'section'), remarks: str(form, 'remarks') }));
}

export async function rejectAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await rejectApplication(user, { expect: expectOf(form), remarks: str(form, 'remarks') }));
}

export async function repriceAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await repriceApplication(user, { expect: expectOf(form), reason: str(form, 'reason') }));
}

/* ================= participants ================= */

export async function saveEmployeeAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  const f = (k: string) => str(form, k);
  return finish(await saveEmployee(user, {
    employeeId: f('employeeId'), isNew: f('isNew') === '1', name: f('name'), designation: f('designation'), emailOverride: f('emailOverride'),
    mobile: f('mobile'), address: f('address'), nationality: f('nationality'), employmentStatus: f('employmentStatus'),
    separationDate: f('separationDate'), pan: f('pan'), remarks: f('remarks'), ctc: f('ctc'), taxRatePercent: f('taxRatePercent'),
    dpName: f('dpName'), dpId: f('dpId'), clientId: f('clientId'), accountName: f('accountName'), accountType: f('accountType'),
  }));
}

export async function setBlockedAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await setBlocked(user, { employeeId: str(form, 'employeeId'), blocked: str(form, 'blocked') === '1', reason: str(form, 'reason') }));
}

export async function bulkTaxRatesAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await bulkTaxRates(user, str(form, 'rows')));
}

export async function bulkDetailsAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await bulkDetails(user, str(form, 'rows')));
}

export async function enabledListAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await setEnabledList(user, str(form, 'clear') === '1' ? '' : str(form, 'ids')));
}

export async function bulkBlockAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await bulkBlock(user, { text: str(form, 'ids'), blocked: str(form, 'blocked') === '1', reason: str(form, 'reason') }));
}

/* ================= imports ================= */

export async function importTicketAction(kind: ImportKind, name: string, size: number): Promise<{ ok: true; ticket: ImportTicket } | { ok: false; error: string }> {
  await admin();
  if (kind !== 'grantReport' && kind !== 'taxSheet') return { ok: false, error: 'Unknown upload.' };
  try {
    return { ok: true, ticket: await importUploadTicket(kind, String(name), Number(size), kind === 'grantReport') };
  } catch (e) {
    const r = toActionResult(e, 'import ticket');
    return { ok: false, error: r.ok ? '' : r.error };
  }
}

export async function previewGrantSyncAction(path: string): Promise<AdminResult> {
  const user = await admin();
  return finish(await previewGrantSync(user, String(path)), { refresh: false });
}

export async function runGrantSyncAction(path: string): Promise<AdminResult> {
  const user = await admin();
  return finish(await runGrantSync(user, String(path)));
}

export async function loadTaxSheetAction(input: { asOn: string; rows?: unknown[]; path?: string }): Promise<AdminResult> {
  const user = await admin();
  return finish(await loadTaxSheet(user, { asOn: String(input?.asOn ?? ''), rows: Array.isArray(input?.rows) ? input.rows : undefined, path: input?.path ? String(input.path) : undefined }));
}

/* ================= prices, windows ================= */

export async function savePriceAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await savePrice(user, { date: str(form, 'date'), open: str(form, 'open'), close: str(form, 'close'), source: str(form, 'source') }));
}

export async function saveHolidaysAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await saveHolidays(user, str(form, 'dates')));
}

export async function saveWindowAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await saveWindow(user, {
    windowId: str(form, 'windowId'), label: str(form, 'label'), openDate: str(form, 'openDate'), closeDate: str(form, 'closeDate'),
    taxDueDate: str(form, 'taxDueDate'), status: str(form, 'status'), remarks: str(form, 'remarks'),
  }));
}

export async function createWindowAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await createWindow(user, str(form, 'month')));
}

export async function announceAction(cursor: string): Promise<AdminResult> {
  const user = await admin();
  return finish(await announceWindow(user, { cursor: String(cursor ?? '') }), { refresh: false });
}

/* ================= logins and partners ================= */

export async function createLoginAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await createLogin(user, {
    userId: str(form, 'userId'), role: str(form, 'role') as Role, name: str(form, 'name'), email: str(form, 'email'),
    partnerId: str(form, 'partnerId'), sendEmail: str(form, 'sendEmail') === '1',
  }));
}

export async function newCodeAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await newCode(user, { userId: str(form, 'userId'), sendEmail: str(form, 'sendEmail') === '1' }));
}

export async function setUserStatusAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await setUserStatus(user, { userId: str(form, 'userId'), status: str(form, 'status') }));
}

export async function bulkLoginsAction(cursor: string, sendEmail: boolean): Promise<AdminResult> {
  const user = await admin();
  return finish(await bulkCreateLogins(user, { cursor: String(cursor ?? ''), sendEmail: !!sendEmail }), { refresh: false });
}

export async function savePartnerAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await savePartner(user, {
    partnerId: str(form, 'partnerId'), name: str(form, 'name'), contactEmails: str(form, 'contactEmails'), notes: str(form, 'notes'),
    createLogin: str(form, 'createLogin') === '1', sendEmail: str(form, 'sendEmail') === '1',
  }));
}

export async function partnerLoginAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await createPartnerLogin(user, { partnerId: str(form, 'partnerId'), email: str(form, 'email'), sendEmail: str(form, 'sendEmail') === '1' }));
}

export async function partnerStatusAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await setPartnerStatus(user, { partnerId: str(form, 'partnerId'), status: str(form, 'status') }));
}

/* ================= settings ================= */

export async function saveSettingAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  return finish(await saveSetting(user, str(form, 'key'), str(form, 'value')));
}

export async function saveTaxRulesAction(_p: AdminResult, form: FormData): Promise<AdminResult> {
  const user = await admin();
  const input = { slabs: str(form, 'slabs'), surcharge: str(form, 'surcharge'), rules: str(form, 'rules') };
  if (str(form, 'intent') === 'preview') {
    const p = taxPreview(input);
    return p.ok
      ? { ok: true, message: 'Preview below — nothing saved yet.', data: p.rows, at: Date.now() }
      : { ok: false, error: 'These need fixing:\n• ' + p.errors.join('\n• '), at: Date.now() };
  }
  return finish(await saveTaxRules(user, input));
}
