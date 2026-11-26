/**
 * The admin's bulk pastes (AdminApi bulkTaxRates / bulkParticipantDetails),
 * as pure functions: parse the pasted text, then work out per participant
 * what changes, with the legacy warnings. Writing is the caller's job.
 */
import { num, trim, validateDemat, validateMobile, validatePan } from '@/domain';
import type { DematDetails, EmployeeDoc } from '@/lib/schema';
import { parsePaste } from './grid';

export const MAX_PASTE_ROWS = 5000;

/* ================= CTC and tax rate ================= */

export interface RateRow {
  employeeId: string;
  ctc: string;
  taxRatePercent: string;
}

/**
 * "employee ID, CTC, tax %" per line. Two columns are read as "employee ID,
 * tax %" (legacy read the second column as both CTC and rate — a slip).
 */
export function parseRateRows(text: string): RateRow[] {
  return parsePaste(text.replace(/;/g, '\t')).map((c) => {
    if (!c[0]) return null;
    return c.length >= 3
      ? { employeeId: c[0], ctc: c[1] ?? '', taxRatePercent: c[2] ?? '' }
      : { employeeId: c[0], ctc: '', taxRatePercent: c[1] ?? '' };
  }).filter((r): r is RateRow => !!r);
}

/** A tax percentage the portal accepts: 0 to 60. */
export function checkRate(v: unknown): { ok: true; value: number } | { ok: false } {
  const s = trim(v);
  if (!s) return { ok: false };
  const rate = num(s, NaN);
  return isNaN(rate) || rate < 0 || rate > 60 ? { ok: false } : { ok: true, value: rate };
}

export interface RatePlan {
  updates: { employeeId: string; taxRatePercent: number; ctc?: number }[];
  skipped: string[];
}

export function planRates(rows: readonly RateRow[], known: ReadonlySet<string>): RatePlan {
  const out: RatePlan = { updates: [], skipped: [] };
  const seen = new Set<string>();
  rows.forEach((r) => {
    const id = trim(r.employeeId).toUpperCase();
    if (!id) return;
    if (!known.has(id)) { out.skipped.push(id + ' — no participant record'); return; }
    const rate = checkRate(r.taxRatePercent);
    if (!rate.ok) { out.skipped.push(id + ' — rate "' + r.taxRatePercent + '" is not a percentage between 0 and 60'); return; }
    const ctcText = trim(r.ctc);
    const ctc = ctcText ? num(ctcText, NaN) : undefined;
    if (ctc !== undefined && (isNaN(ctc) || ctc < 0)) { out.skipped.push(id + ' — CTC "' + r.ctc + '" is not an amount'); return; }
    if (seen.has(id)) out.updates = out.updates.filter((u) => u.employeeId !== id);
    seen.add(id);
    out.updates.push({ employeeId: id, taxRatePercent: rate.value, ...(ctc !== undefined ? { ctc } : {}) });
  });
  return out;
}

/* ================= PAN and demat details ================= */

export interface DetailsRow {
  employeeId: string;
  pan: string;
  dematAccountType: string;
  dematDPName: string;
  dematDPId: string;
  dematClientId: string;
  dematAccountName: string;
  mobile: string;
  address: string;
}

export const DETAILS_COLUMNS = ['Employee ID', 'PAN', 'Account type', 'DP name', 'DP ID', 'Client ID', 'Holder name', 'Mobile', 'Address'];

/** The nine columns, in the legacy dialog's order. */
export function parseDetailsRows(text: string): DetailsRow[] {
  return parsePaste(text).map((c) => {
    if (!c[0]) return null;
    return {
      employeeId: c[0], pan: c[1] ?? '', dematAccountType: c[2] ?? '', dematDPName: c[3] ?? '', dematDPId: c[4] ?? '',
      dematClientId: c[5] ?? '', dematAccountName: c[6] ?? '', mobile: c[7] ?? '', address: c[8] ?? '',
    };
  }).filter((r): r is DetailsRow => !!r);
}

export interface DetailsPatch {
  employeeId: string;
  patch: { pan?: string; mobile?: string; address?: string; demat?: DematDetails };
}

export interface DetailsPlan {
  updates: DetailsPatch[];
  unchanged: number;
  skipped: string[];
  warnings: string[];
}

/**
 * bulkParticipantDetails: a blank cell leaves the value on record; a bad PAN,
 * mobile or account type is not set (with a warning); DP/client IDs are stored
 * even when their shape is wrong, with a warning, once both are present.
 */
export function planDetails(rows: readonly DetailsRow[], byId: ReadonlyMap<string, EmployeeDoc>): DetailsPlan {
  const out: DetailsPlan = { updates: [], unchanged: 0, skipped: [], warnings: [] };
  rows.forEach((r, i) => {
    const id = trim(r.employeeId).toUpperCase();
    if (!id) return;
    const emp = byId.get(id);
    if (!emp) { out.skipped.push(id + ' - no participant record'); return; }
    const at = 'Row ' + (i + 1) + ' (' + id + '): ';
    const patch: DetailsPatch['patch'] = {};
    const demat: DematDetails = { ...emp.demat };
    let dematChanged = false;

    const pan = trim(r.pan);
    if (pan) {
      const v = validatePan(pan);
      if (!v.ok) out.warnings.push(at + v.error + ' PAN not set.');
      else if (trim(emp.pan) !== v.value) patch.pan = v.value;
    }
    const mobile = trim(r.mobile);
    if (mobile) {
      const v = validateMobile(mobile);
      if (!v.ok) out.warnings.push(at + v.error + ' Mobile not set.');
      else if (trim(emp.mobile) !== v.value) patch.mobile = v.value;
    }
    const address = trim(r.address);
    if (address && trim(emp.address) !== address) patch.address = address;

    const type = trim(r.dematAccountType).toUpperCase();
    if (type) {
      if (type !== 'NSDL' && type !== 'CDSL') out.warnings.push(at + 'account type "' + type + '" is neither NSDL nor CDSL. Not set.');
      else if (demat.accountType !== type) { demat.accountType = type; dematChanged = true; }
    }
    const setDemat = (k: 'dpName' | 'dpId' | 'clientId' | 'accountName', raw: string, upper: boolean) => {
      const v = upper ? trim(raw).toUpperCase() : trim(raw);
      if (v && demat[k] !== v) { demat[k] = v; dematChanged = true; }
    };
    setDemat('dpName', r.dematDPName, false);
    setDemat('dpId', r.dematDPId, true);
    setDemat('clientId', r.dematClientId, true);
    setDemat('accountName', r.dematAccountName, false);
    if (dematChanged) patch.demat = demat;

    if (demat.dpId && demat.clientId) {
      const v = validateDemat({
        dematDPName: demat.dpName || 'unknown', dematAccountName: demat.accountName || emp.name,
        dematDPId: demat.dpId, dematClientId: demat.clientId, dematAccountType: demat.accountType,
      });
      if (!v.ok) out.warnings.push(at + v.error + ' Stored anyway - the participant will be asked to confirm it.');
    }

    if (!Object.keys(patch).length) { out.unchanged++; return; }
    out.updates.push({ employeeId: id, patch });
  });
  return out;
}

/* ================= enabled list ================= */

/** setEnabledList: the de-duplicated list, and the codes that match no participant. */
export function planEnabledList(ids: readonly string[], known: ReadonlySet<string>): { kept: string[]; unknown: string[] } {
  const kept: string[] = [];
  const unknown: string[] = [];
  ids.forEach((raw) => {
    const id = trim(raw).toUpperCase();
    if (!id || kept.includes(id)) return;
    kept.push(id);
    if (!known.has(id)) unknown.push(id);
  });
  return { kept, unknown };
}
