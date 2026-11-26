/**
 * GrantSync.run without the I/O: the "Vest wise Report" export (one row per
 * TRANCHE) rolled up to one grant per row, with the per-tranche breakdown
 * kept on the grant, plus the participant fields the report carries. Pure.
 *
 * Facts this relies on (verified by the legacy team against the 08-Sep-2026
 * export): headings sit on row 4, "... as on Sep 08, 2026" above them;
 * Granted = Unvested + Vested + Exercised + Pending + cancellations, so
 * `Vested` is already the exercisable balance; Grant IDs are globally unique;
 * Multiplier / Plan / Grant Date / Exercise Price never vary within a grant.
 */
import {
  isGrantRowAllowed, lotSize, num, resolveMultiplier, round6, stepFor, toDateKey, trim,
  type LotScope, type PortalSettings,
} from '@/domain';
import type { DematDetails, EmployeeDoc, GrantDoc, Tranche } from '@/lib/schema';
import { slug, type Cell, type Grid } from './grid';

/** Config.gs REPORT_COLUMNS: field → heading aliases (matched by slug). */
export const REPORT_COLUMNS: Record<string, readonly string[]> = {
  planName: ['Plan Name'],
  designation: ['Employee Designation', 'Designation'],
  category: ['Stakeholder Category'],
  employeeId: ['Employee ID', 'Emp ID', 'Employee Code'],
  employeeName: ['Stakeholder Name', 'Employee Name'],
  awardeeStatus: ['Awardee Status'],
  separationDate: ['Separation Date(Last Working Date)', 'Separation Date'],
  resignationDate: ['Resignation Date'],
  grantId: ['Grant ID'],
  grantDate: ['Grant Date'],
  trancheId: ['Tranche ID'],
  actualVestDate: ['Actual Vest Date'],
  vestDate: ['Vest Date'],
  typeOfVesting: ['Type of Vesting'],
  expiryDate: ['Expiry Date'],
  exercisePrice: ['Exercise Price'],
  grantStatus: ['Grant Status'],
  granted: ['Granted'],
  unvested: ['Unvested'],
  vested: ['Vested'],
  outstanding: ['Quantity Outstanding'],
  exercisePending: ['Exercises Pending for Approval'],
  exercised: ['Exercised'],
  cancelled: ['Cancelled'],
  lapsed: ['Lapsed'],
  unvestedCancelled: ['Unvested Cancelled'],
  vestedCancelled: ['Vested Cancelled'],
  accessEmail: ['Access Email ID'],
  secondaryEmail: ['Secondary Email ID'],
  multiplier: ['Multiplier'],
  // Optional prefill columns: a blank cell leaves what is on record.
  pan: ['PAN', 'PAN Number', 'Pan No', 'PAN No'],
  mobile: ['Mobile', 'Mobile Number', 'Contact Number', 'Phone'],
  address: ['Address', 'Member Address', 'Residential Address'],
  nationality: ['Nationality'],
  dematAccountType: ['Demat Account Type', 'Account Type', 'Depository'],
  dematDPName: ['Depository Participant Name', 'DP Name', 'Depository Participant'],
  dematDPId: ['DP ID', 'DPID', 'DP Id'],
  dematClientId: ['Client ID', 'ClientID', 'Client Id', 'BO ID'],
  dematAccountName: ['Demat Account Holder Name', 'Account Holder Name', 'Demat Account Name'],
};

const REQUIRED = ['employeeId', 'grantId', 'vested', 'unvested', 'multiplier', 'planName'];
export const PREFILL_KEYS = ['pan', 'mobile', 'address', 'nationality', 'dematAccountType', 'dematDPName', 'dematDPId',
  'dematClientId', 'dematAccountName'] as const;
export type PrefillKey = (typeof PREFILL_KEYS)[number];

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportError';
  }
}

function text(v: Cell): string {
  if (v instanceof Date) return toDateKey(v);
  return trim(v);
}

/** The report writes 0 or "-" where there is no date. */
function reportDate(v: Cell): string {
  if (v === 0 || v === '0' || v === '-' || v === '' || v === null || v === undefined) return '';
  return toDateKey(v);
}

/** The report writes "-" or "0" for an empty text cell. */
function reportText(v: Cell): string {
  const s = text(v);
  return s === '-' || s === '0' ? '' : s;
}

function n(v: Cell): number {
  return v instanceof Date ? 0 : num(v as string | number | boolean | null | undefined, 0);
}

/** Find the heading row, and the report's "as on" date from above it (locateHeader). */
export function locateHeader(grid: Grid, configuredRow = 4): { headerRow: number; headers: string[]; asOn: string } {
  const probeRows = Math.min(12, grid.length);
  if (!probeRows) throw new ReportError('The report is empty.');
  const candidates: number[] = [];
  if (configuredRow >= 1 && configuredRow <= probeRows) candidates.push(configuredRow);
  for (let i = 1; i <= probeRows; i++) if (!candidates.includes(i)) candidates.push(i);
  let headerRow = 0;
  for (const c of candidates) {
    const slugs = (grid[c - 1] ?? []).map(slug);
    if (slugs.includes('planname') && slugs.includes('employeeid')) { headerRow = c; break; }
  }
  if (!headerRow) {
    throw new ReportError('Could not find the heading row. Looked in the first ' + probeRows +
      ' rows for one containing both "Plan Name" and "Employee ID".');
  }
  // "Vest wise Report of Physics Wallah as on Sep 08, 2026"
  let asOn = '';
  for (let r = 0; r < headerRow - 1 && !asOn; r++) {
    for (const cell of grid[r] ?? []) {
      const m = String(cell ?? '').match(/as on\s+([A-Za-z]{3,}\s+\d{1,2},\s*\d{4})/i);
      if (m) { asOn = toDateKey(m[1]); if (asOn) break; }
    }
  }
  return { headerRow, headers: (grid[headerRow - 1] ?? []).map((x) => text(x)), asOn };
}

/** Resolve REPORT_COLUMNS aliases to column indexes (mapColumns). */
export function mapColumns(headers: readonly string[]): { idx: Record<string, number>; missing: string[] } {
  const slugs = headers.map(slug);
  const idx: Record<string, number> = {};
  const missing: string[] = [];
  for (const [key, aliases] of Object.entries(REPORT_COLUMNS)) {
    const at = aliases.map((a) => slugs.indexOf(slug(a))).find((i) => i >= 0);
    if (at !== undefined) idx[key] = at;
    else missing.push(key + ' (' + aliases[0] + ')');
  }
  const lacking = REQUIRED.filter((k) => idx[k] === undefined);
  if (lacking.length) {
    throw new ReportError('The report is missing column(s) the portal needs: ' +
      lacking.map((k) => REPORT_COLUMNS[k][0]).join(', ') + '.');
  }
  return { idx, missing };
}

/** What the report says about a participant (only the first row seen for them counts, as legacy). */
export interface ReportEmployee {
  employeeId: string;
  name: string;
  designation: string;
  stakeholderCategory: string;
  accessEmail: string;
  secondaryEmail: string;
  employmentStatus: string;
  separationDate: string;
  resignationDate: string;
  prefill: Partial<Record<PrefillKey, string>>;
}

export interface GrantReportSummary {
  reportAsOn: string;
  headerRow: number;
  rowsRead: number;
  rowsUsed: number;
  skippedPlan: number;
  skippedStatus: number;
  skippedNoId: number;
  statusesSkipped: Record<string, number>;
  plansSeen: Record<string, number>;
  grantStatusesAllowed: string[];
  grantsWithDefaultedMultiplier: number;
  grantsFullyClosed: number;
  grantRows: number;
  employees: number;
  prefillColumnsFound: string[];
  participantsWithPrefills: number;
  unmatchedColumns: string[];
  warnings: string[];
  preview: {
    lotSize: number;
    lotScope: LotScope;
    vestedOptions: number;
    exercisableOptions: number;
    strandedBelowOneLot: number;
    grantsUnderOneLot: number;
    employeesWithSomething: number;
    employeesWithNothing: number;
  };
  sample: {
    grantId: string; employeeId: string; plan: string; multiplier: number; vested: number; exercisable: number;
    shares: number; tranches: number; nextVest: string;
  }[];
}

export interface GrantReportResult {
  summary: GrantReportSummary;
  grants: GrantDoc[];
  /** Participants who still hold one of the written grants. */
  employees: Record<string, ReportEmployee>;
}

interface Acc {
  grantId: string; employeeId: string; planName: string; multiplier: number; grantDate: string; exercisePrice: number;
  typeOfVesting: string; grantStatus: string; expiryDate: string;
  granted: number; unvested: number; vested: number; exercised: number; pending: number; cancelled: number;
  tranches: Tranche[];
}

/**
 * Roll the report up. `today` decides each grant's next vest date; `syncedAt`
 * is stamped on every grant. Throws ReportError for a report it cannot read.
 */
export function rollupGrantReport(grid: Grid, opts: {
  settings: PortalSettings; today: string; syncedAt: string; headerRow?: number;
}): GrantReportResult {
  const { settings } = opts;
  const loc = locateHeader(grid, opts.headerRow ?? 4);
  const map = mapColumns(loc.headers);
  const idx = map.idx;
  const col = (row: readonly Cell[], key: string): Cell => (idx[key] === undefined ? undefined : row[idx[key]]);
  const asOn = loc.asOn || opts.today;

  const firstData = loc.headerRow; // 0-based index of the first data row
  if (grid.length <= firstData) throw new ReportError('The report has headings but no data rows.');

  // An object, not a Map: grant ids are iterated in the same order legacy's Object.keys gave.
  const g: Record<string, Acc> = {};
  const employees: Record<string, ReportEmployee> = {};
  const multiplierDefaulted: Record<string, true> = {};
  const prefillSeen: Record<string, true> = {};
  const warnings: string[] = [];
  const stats = { rowsRead: 0, rowsUsed: 0, skippedPlan: 0, skippedStatus: 0, skippedNoId: 0,
    plansSeen: {} as Record<string, number>, statusesSkipped: {} as Record<string, number> };

  for (let r = firstData; r < grid.length; r++) {
    const row = grid[r] ?? [];
    stats.rowsRead++;
    const empId = text(col(row, 'employeeId')).toUpperCase();
    const grantId = text(col(row, 'grantId'));
    if (!empId || !grantId || grantId === '-') { stats.skippedNoId++; continue; }

    const planName = text(col(row, 'planName'));
    stats.plansSeen[planName] = (stats.plansSeen[planName] || 0) + 1;
    const grantStatus = idx.grantStatus === undefined ? undefined : text(col(row, 'grantStatus'));
    const allowed = isGrantRowAllowed(planName, grantStatus, settings);
    if (!allowed.ok) {
      if (allowed.reason === 'PLAN') stats.skippedPlan++;
      else {
        const st = grantStatus ?? '';
        stats.skippedStatus++;
        stats.statusesSkipped[st] = (stats.statusesSkipped[st] || 0) + 1;
      }
      continue;
    }
    stats.rowsUsed++;

    // A blank multiplier falls back to DEFAULT_MULTIPLIER (said once per grant);
    // one that is present but nonsense is refused.
    const rawMultiplier = text(col(row, 'multiplier'));
    const mult = resolveMultiplier(rawMultiplier, settings);
    if (!mult.ok) {
      warnings.push('Grant ' + grantId + ' (' + empId + '): multiplier "' + rawMultiplier +
        '" is not a positive number — the grant was skipped.');
      continue;
    }
    const multiplier = mult.multiplier;
    if (mult.defaulted && !multiplierDefaulted[grantId]) {
      multiplierDefaulted[grantId] = true;
      warnings.push('Grant ' + grantId + ' (' + empId + ', ' + planName + '): the report has no Multiplier, so ' +
        settings.defaultMultiplier + ' was used — one option to ' + settings.defaultMultiplier + ' share(s).');
    }

    let acc = g[grantId];
    if (!acc) {
      acc = g[grantId] = {
        grantId, employeeId: empId, planName, multiplier,
        grantDate: reportDate(col(row, 'grantDate')),
        exercisePrice: idx.exercisePrice === undefined ? settings.exercisePrice : (n(col(row, 'exercisePrice')) || settings.exercisePrice),
        typeOfVesting: idx.typeOfVesting === undefined ? '' : reportText(col(row, 'typeOfVesting')),
        grantStatus: grantStatus === undefined ? 'Accepted' : grantStatus,
        expiryDate: reportDate(col(row, 'expiryDate')),
        granted: 0, unvested: 0, vested: 0, exercised: 0, pending: 0, cancelled: 0, tranches: [],
      };
    } else {
      if (acc.employeeId !== empId) {
        warnings.push('Grant ' + grantId + ' appears against both ' + acc.employeeId + ' and ' + empId + '. The first was kept.');
        continue;
      }
      if (Math.abs(acc.multiplier - multiplier) > 1e-9) {
        warnings.push('Grant ' + grantId + ' has two different multipliers (' + acc.multiplier + ' and ' + multiplier + '). ' +
          acc.multiplier + ' was kept — check the report.');
      }
    }

    const vested = n(col(row, 'vested'));
    const unvested = n(col(row, 'unvested'));
    const exercised = n(col(row, 'exercised'));
    const pending = n(col(row, 'exercisePending'));
    const cancelled = n(col(row, 'unvestedCancelled')) + n(col(row, 'vestedCancelled'));
    acc.granted += n(col(row, 'granted'));
    acc.unvested += unvested;
    acc.vested += vested;
    acc.exercised += exercised;
    acc.pending += pending;
    acc.cancelled += cancelled;
    acc.tranches.push({
      id: idx.trancheId === undefined ? '' : text(col(row, 'trancheId')),
      vd: reportDate(col(row, 'vestDate')),
      avd: reportDate(col(row, 'actualVestDate')),
      v: round6(vested), u: round6(unvested), e: round6(exercised), p: round6(pending),
    });

    if (!employees[empId]) {
      const prefill: Partial<Record<PrefillKey, string>> = {};
      for (const k of PREFILL_KEYS) {
        if (idx[k] === undefined) continue;
        const v = reportText(col(row, k));
        if (v) prefill[k] = v;
      }
      if (Object.keys(prefill).length) prefillSeen[empId] = true;
      employees[empId] = {
        employeeId: empId,
        name: reportText(col(row, 'employeeName')),
        designation: reportText(col(row, 'designation')),
        stakeholderCategory: reportText(col(row, 'category')),
        accessEmail: reportText(col(row, 'accessEmail')),
        secondaryEmail: reportText(col(row, 'secondaryEmail')),
        employmentStatus: idx.awardeeStatus === undefined ? 'Active' : (reportText(col(row, 'awardeeStatus')) || 'Active'),
        separationDate: reportDate(col(row, 'separationDate')),
        resignationDate: reportDate(col(row, 'resignationDate')),
        prefill,
      };
    }
  }

  /* ---- grant rows ---- */
  const grants: GrantDoc[] = [];
  let fullyClosed = 0;
  for (const grantId of Object.keys(g)) {
    const a = g[grantId];
    if (round6(a.unvested + a.vested) <= 0) { fullyClosed++; continue; }
    a.tranches.sort((x, y) => x.vd.localeCompare(y.vd));
    const future = a.tranches.filter((t) => t.u > 0 && t.vd && t.vd > opts.today);
    grants.push({
      grantId: a.grantId, employeeId: a.employeeId, planName: a.planName, multiplier: a.multiplier,
      grantDate: a.grantDate, exercisePrice: a.exercisePrice, typeOfVesting: a.typeOfVesting, grantStatus: a.grantStatus,
      totalGranted: round6(a.granted), unvestedOptions: round6(a.unvested), vestedOptions: round6(a.vested),
      exercisedOptions: round6(a.exercised), exercisePendingOptions: round6(a.pending), cancelledOptions: round6(a.cancelled),
      trancheCount: a.tranches.length, vestedTrancheCount: a.tranches.filter((t) => t.v > 0).length,
      nextVestDate: future.length ? future[0].vd : '',
      lastVestDate: a.tranches.length ? a.tranches[a.tranches.length - 1].vd : '',
      expiryDate: a.expiryDate, tranches: a.tranches, reportAsOn: asOn, lastSyncedAt: opts.syncedAt,
    });
  }
  grants.sort((x, y) => x.employeeId.localeCompare(y.employeeId) || x.grantDate.localeCompare(y.grantDate));

  const kept: Record<string, ReportEmployee> = {};
  grants.forEach((r) => { kept[r.employeeId] = employees[r.employeeId]; });

  /* ---- what the lot rule does to it ---- */
  let totVested = 0, totExercisable = 0, locked = 0;
  const byEmp: Record<string, number> = {};
  const exercisableOf = (r: GrantDoc) => {
    const step = stepFor(r.multiplier, settings);
    return Math.floor((r.vestedOptions + 1e-9) / step) * step;
  };
  grants.forEach((r) => {
    const ex = exercisableOf(r);
    totVested += r.vestedOptions;
    totExercisable += ex;
    if (r.vestedOptions > 0 && ex === 0) locked++;
    byEmp[r.employeeId] = (byEmp[r.employeeId] || 0) + ex;
  });

  const summary: GrantReportSummary = {
    reportAsOn: asOn,
    headerRow: loc.headerRow,
    rowsRead: stats.rowsRead, rowsUsed: stats.rowsUsed,
    skippedPlan: stats.skippedPlan, skippedStatus: stats.skippedStatus, skippedNoId: stats.skippedNoId,
    statusesSkipped: stats.statusesSkipped, plansSeen: stats.plansSeen,
    grantStatusesAllowed: settings.allowedGrantStatuses ?? ['(all)'],
    grantsWithDefaultedMultiplier: Object.keys(multiplierDefaulted).length,
    grantsFullyClosed: fullyClosed,
    grantRows: grants.length,
    employees: Object.keys(kept).length,
    prefillColumnsFound: PREFILL_KEYS.filter((k) => idx[k] !== undefined).map((k) => REPORT_COLUMNS[k][0]),
    participantsWithPrefills: Object.keys(prefillSeen).length,
    unmatchedColumns: map.missing,
    warnings,
    preview: {
      lotSize: lotSize(settings), lotScope: settings.lotScope,
      vestedOptions: round6(totVested), exercisableOptions: round6(totExercisable),
      strandedBelowOneLot: round6(totVested - totExercisable), grantsUnderOneLot: locked,
      employeesWithSomething: Object.keys(byEmp).filter((k) => byEmp[k] > 0).length,
      employeesWithNothing: Object.keys(byEmp).filter((k) => byEmp[k] <= 0).length,
    },
    sample: grants.slice(0, 12).map((r) => {
      const ex = exercisableOf(r);
      return {
        grantId: r.grantId, employeeId: r.employeeId, plan: r.planName, multiplier: r.multiplier, vested: r.vestedOptions,
        exercisable: ex, shares: Math.round(ex * r.multiplier), tranches: r.trancheCount, nextVest: r.nextVestDate,
      };
    }),
  };
  return { summary, grants, employees: kept };
}

/** run()'s refusal when nothing would be written. */
export function nothingToWriteMessage(summary: GrantReportSummary, settings: PortalSettings): string {
  return 'No grants with anything outstanding were found. Plans seen in the report: ' +
    Object.keys(summary.plansSeen).join(', ') + '. ALLOWED_PLANS is set to: ' + settings.allowedPlans.join(', ') + '.';
}

/* ================= the participant master ================= */

const AUTHORITATIVE = ['name', 'designation', 'stakeholderCategory', 'accessEmail', 'secondaryEmail', 'employmentStatus',
  'separationDate', 'resignationDate'] as const;

const DEMAT_OF: Partial<Record<PrefillKey, keyof DematDetails>> = {
  dematAccountType: 'accountType', dematDPName: 'dpName', dematDPId: 'dpId', dematClientId: 'clientId',
  dematAccountName: 'accountName',
};

export function blankEmployee(employeeId: string, now: string): EmployeeDoc {
  return {
    employeeId, name: '', designation: '', stakeholderCategory: '', accessEmail: '', secondaryEmail: '', emailOverride: '',
    mobile: '', address: '', nationality: 'Indian', pan: '', employmentStatus: 'Active', separationDate: '', resignationDate: '',
    ctc: null, taxRatePercent: null, blocked: false, blockedReason: '', blockedAt: '', blockedBy: '',
    demat: { dpName: '', dpId: '', clientId: '', accountName: '', accountType: '' }, remarks: '', updatedAt: now,
  };
}

function prefillValue(k: PrefillKey, v: string): string | null {
  if (k === 'pan') return v.toUpperCase();
  if (k === 'dematDPId' || k === 'dematClientId') return v.toUpperCase();
  if (k === 'dematAccountType') {
    const t = v.toUpperCase();
    return t === 'NSDL' || t === 'CDSL' ? t : null;
  }
  return v;
}

/** Apply the report's prefills to a record: written only when the report carries a value. */
function applyPrefills(target: EmployeeDoc, prefill: ReportEmployee['prefill'], patch: Record<string, unknown>): void {
  let demat: DematDetails | null = null;
  for (const k of PREFILL_KEYS) {
    const raw = trim(prefill[k]);
    if (!raw) continue;
    const v = prefillValue(k, raw);
    if (v === null) continue;
    const dk = DEMAT_OF[k];
    if (dk) {
      if (trim(target.demat[dk]) !== v) {
        demat = demat ?? { ...target.demat };
        (demat as unknown as Record<string, string>)[dk] = v;
      }
    } else {
      const field = k as 'pan' | 'mobile' | 'address' | 'nationality';
      if (trim(target[field]) !== v) patch[field] = v;
    }
  }
  if (demat) patch.demat = demat;
}

export interface EmployeeUpsertPlan {
  creates: EmployeeDoc[];
  updates: { employeeId: string; patch: Record<string, unknown> }[];
  created: number;
  updated: number;
  missingRate: number;
  missingEmail: number;
}

/**
 * GrantSync.upsertEmployees: identity fields are brought into line with the
 * register; prefills are written only when the report carries a value; CTC,
 * tax rate, email override, block and remarks are never touched.
 */
export function planEmployeeUpserts(
  existing: ReadonlyMap<string, EmployeeDoc>, fromReport: Record<string, ReportEmployee>, now: string,
): EmployeeUpsertPlan {
  const plan: EmployeeUpsertPlan = { creates: [], updates: [], created: 0, updated: 0, missingRate: 0, missingEmail: 0 };
  for (const id of Object.keys(fromReport)) {
    const src = fromReport[id];
    if (!src) continue;
    if (!(trim(src.accessEmail) || trim(src.secondaryEmail))) plan.missingEmail++;
    const row = existing.get(id);
    if (!row) {
      const doc = blankEmployee(id, now);
      AUTHORITATIVE.forEach((f) => { doc[f] = src[f]; });
      if (!doc.employmentStatus) doc.employmentStatus = 'Active';
      const patch: Record<string, unknown> = {};
      applyPrefills(doc, src.prefill, patch);
      Object.assign(doc, patch);
      doc.remarks = 'Created by grant sync';
      plan.creates.push(doc);
      plan.missingRate++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    AUTHORITATIVE.forEach((f) => {
      const v = src[f] ?? '';
      if (trim(row[f]) !== trim(v)) patch[f] = v;
    });
    applyPrefills(row, src.prefill, patch);
    if (Object.keys(patch).length) {
      patch.updatedAt = now;
      plan.updates.push({ employeeId: id, patch });
    }
    if (!num(row.taxRatePercent, 0)) plan.missingRate++;
  }
  plan.created = plan.creates.length;
  plan.updated = plan.updates.length;
  return plan;
}

/**
 * An Employee login's sign-in addresses follow the participant record: every
 * address on it (override, access, secondary), lower-cased. Returns the patch
 * for the user document, or null when nothing changes (or the record has no
 * address, in which case the login keeps what it has).
 */
export function loginEmailSync(
  user: { loginEmails?: string[]; notifyEmail?: string },
  emp: Pick<EmployeeDoc, 'emailOverride' | 'accessEmail' | 'secondaryEmail'>,
): { loginEmails: string[]; notifyEmail: string } | null {
  const all = [emp.emailOverride, emp.accessEmail, emp.secondaryEmail].map((e) => trim(e).toLowerCase()).filter(Boolean);
  const wanted = [...new Set(all)];
  if (!wanted.length) return null;
  const notify = trim(emp.emailOverride) || trim(emp.accessEmail) || trim(emp.secondaryEmail);
  const current = (user.loginEmails ?? []).map((e) => trim(e).toLowerCase());
  const same = current.length === wanted.length && wanted.every((e) => current.includes(e));
  if (same && trim(user.notifyEmail) === notify) return null;
  return { loginEmails: wanted, notifyEmail: notify };
}
