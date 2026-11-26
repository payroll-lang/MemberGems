/**
 * What a participant may exercise, and whether they may act at all
 * (Domain.gs grantsFor 257-404, accessBar; GrantSync plan/status filters).
 */
import { STATUS, type PortalSettings } from './config';
import { shares, stepFor } from './lots';
import { instantMs, num, prettyDate, toDateKey, trim, windowKey, type Numeric } from './util';

export interface GrantRecord {
  grantId: string;
  employeeId: string;
  planName: string;
  multiplier: Numeric;
  grantDate?: unknown;
  exercisePrice?: Numeric;
  typeOfVesting?: string;
  grantStatus?: string;
  totalGranted?: Numeric;
  unvestedOptions?: Numeric;
  vestedOptions: Numeric;
  exercisedOptions?: Numeric;
  exercisePendingOptions?: Numeric;
  cancelledOptions?: Numeric;
  trancheCount?: Numeric;
  vestedTrancheCount?: Numeric;
  nextVestDate?: unknown;
  /** An array, or the legacy TrancheDetail JSON string. */
  tranches?: unknown;
  /** The vesting report's "as on" date. */
  reportAsOn?: unknown;
}

/** One of the participant's own applications, as far as holds are concerned. */
export interface HoldingApplication {
  appId: string;
  status: string;
  windowId: unknown;
  /** Timestamp; ISO or 'yyyy-MM-dd HH:mm:ss' IST. */
  approvedAt?: unknown;
  reviewedAt?: unknown;
}

export interface HoldingLine {
  appId: string;
  grantId: string;
  optionsExercised: Numeric;
}

export interface GrantBalance {
  grantId: string;
  employeeId: string;
  planName: string;
  multiplier: number;
  grantDate: string;
  prettyGrantDate: string;
  grantStatus: string;
  typeOfVesting: string;
  exercisePrice: number;
  totalGranted: number;
  unvestedOptions: number;
  vestedOptions: number;
  exercisedOptions: number;
  exercisePendingOptions: number;
  cancelledOptions: number;
  pledgedElsewhere: number;
  availableOptions: number;
  exercisableOptions: number;
  step: number;
  exercisableShares: number;
  vestedShares: number;
  unvestedShares: number;
  exerciseAmountIfAll: number;
  trancheCount: number;
  vestedTrancheCount: number;
  nextVestDate: string;
  prettyNextVestDate: string;
  tranches: unknown[];
  reportAsOn: string;
}

export interface GrantBalanceInput {
  grants: readonly GrantRecord[];
  /** This participant's applications (any status). */
  applications: readonly HoldingApplication[];
  /** Lines of those applications. */
  lines: readonly HoldingLine[];
  /** The application being edited; it does not hold against itself. */
  excludeAppId?: string;
  /** Today, 'yyyy-MM-dd' IST — decides the current window. */
  today: string;
  settings: PortalSettings;
}

type Hold = { approved: false } | { approved: true; approvedAt: number | null; currentWindow: boolean };

function parseTranches(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  const raw = trim(v);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Domain.grantsFor. The report's VestedOptions less what the portal has
 * itself committed and the report cannot know about yet:
 *   - Rejected holds nothing.
 *   - Draft / Sent Back from a past window holds nothing (abandoned).
 *   - Any other live application holds.
 *   - Approved holds if it is in the current window, or has no approval
 *     date, or the grant has no report date, or it was approved after the
 *     report's "as on" date.
 * Sorted by exercisable desc, then grant date.
 *
 * Deviation: two lines of one application naming the same grant are summed;
 * legacy kept only the last of them (a side of review item 12, which can no
 * longer arise because validateLines merges such lines).
 */
export function computeGrantBalances(input: GrantBalanceInput): GrantBalance[] {
  const { grants, settings } = input;
  if (!grants.length) return [];
  const exclude = trim(input.excludeAppId || '');
  const thisWindow = input.today.slice(0, 7);

  const holds: Record<string, Hold> = {};
  input.applications.forEach((a) => {
    const appId = trim(a.appId);
    if (appId === exclude) return;
    const status = trim(a.status);
    if (status === STATUS.REJECTED) return;
    if (status === STATUS.APPROVED) {
      holds[appId] = {
        approved: true,
        approvedAt: instantMs(a.approvedAt) ?? instantMs(a.reviewedAt),
        currentWindow: windowKey(a.windowId) === thisWindow
      };
    } else {
      const abandoned = (status === STATUS.DRAFT || status === STATUS.SENT_BACK) &&
        windowKey(a.windowId) < thisWindow;
      if (abandoned) return;
      holds[appId] = { approved: false };
    }
  });

  const byAppGrant: Record<string, number> = {};
  input.lines.forEach((l) => {
    const appId = trim(l.appId);
    if (!holds[appId]) return;
    const k = appId + '\u0000' + trim(l.grantId);
    byAppGrant[k] = (byAppGrant[k] || 0) + num(l.optionsExercised, 0);
  });
  const ids = Object.keys(holds);

  const defaultPrice = settings.exercisePrice;

  return grants.map((g): GrantBalance => {
    const gid = trim(g.grantId);
    const reportAsOn = instantMs(toDateKey(g.reportAsOn) || null);
    const multiplier = num(g.multiplier, 1) || 1;
    const vested = num(g.vestedOptions, 0);

    let pledged = 0;
    ids.forEach((appId) => {
      const hold = holds[appId];
      const qty = num(byAppGrant[appId + '\u0000' + gid], 0);
      if (!qty) return;
      if (!hold.approved) { pledged += qty; return; }
      if (hold.currentWindow) { pledged += qty; return; }
      if (reportAsOn === null || hold.approvedAt === null) { pledged += qty; return; }
      if (hold.approvedAt > reportAsOn) pledged += qty;
    });

    const available = Math.max(0, Math.round((vested - pledged) * 1e6) / 1e6);
    const step = stepFor(multiplier, settings);
    const exercisable = Math.floor((available + 1e-9) / step) * step;
    const price = num(g.exercisePrice, defaultPrice) || defaultPrice;

    return {
      grantId: gid,
      employeeId: trim(g.employeeId),
      planName: trim(g.planName),
      multiplier,
      grantDate: toDateKey(g.grantDate),
      prettyGrantDate: prettyDate(g.grantDate),
      grantStatus: trim(g.grantStatus),
      typeOfVesting: trim(g.typeOfVesting),
      exercisePrice: price,
      totalGranted: num(g.totalGranted, 0),
      unvestedOptions: num(g.unvestedOptions, 0),
      vestedOptions: vested,
      exercisedOptions: num(g.exercisedOptions, 0),
      exercisePendingOptions: num(g.exercisePendingOptions, 0),
      cancelledOptions: num(g.cancelledOptions, 0),
      pledgedElsewhere: Math.round(pledged * 1e6) / 1e6,
      availableOptions: available,
      exercisableOptions: exercisable,
      step,
      exercisableShares: shares(exercisable, multiplier),
      vestedShares: shares(vested, multiplier),
      unvestedShares: shares(num(g.unvestedOptions, 0), multiplier),
      exerciseAmountIfAll: Math.round(exercisable * price * 100) / 100,
      trancheCount: num(g.trancheCount, 0),
      vestedTrancheCount: num(g.vestedTrancheCount, 0),
      nextVestDate: toDateKey(g.nextVestDate),
      prettyNextVestDate: prettyDate(g.nextVestDate),
      tranches: parseTranches(g.tranches),
      reportAsOn: toDateKey(g.reportAsOn)
    };
  }).sort((a, b) => {
    if (b.exercisableOptions !== a.exercisableOptions) return b.exercisableOptions - a.exercisableOptions;
    return String(a.grantDate).localeCompare(String(b.grantDate));
  });
}

export interface BalanceTotals {
  granted: number; vested: number; unvested: number; exercised: number;
  available: number; exercisable: number; exercisableShares: number; vestedShares: number; stranded: number;
}

/** The dashboard totals (EmployeeApi.dashboard). */
export function balanceTotals(grants: readonly GrantBalance[]): BalanceTotals {
  return grants.reduce<BalanceTotals>((acc, g) => {
    acc.granted += g.totalGranted;
    acc.vested += g.vestedOptions;
    acc.unvested += g.unvestedOptions;
    acc.exercised += g.exercisedOptions;
    acc.available += g.availableOptions;
    acc.exercisable += g.exercisableOptions;
    acc.exercisableShares += g.exercisableShares;
    acc.vestedShares += g.vestedShares;
    acc.stranded += Math.max(0, g.availableOptions - g.exercisableOptions);
    return acc;
  }, { granted: 0, vested: 0, unvested: 0, exercised: 0, available: 0, exercisable: 0, exercisableShares: 0, vestedShares: 0, stranded: 0 });
}

/** Indicative gain on the exercisable balance at a price (dashboard). */
export function indicativeGain(grants: readonly GrantBalance[], fmv: number): number {
  const v = grants.reduce((a, g) => a + Math.max(0, g.exercisableShares * fmv - g.exercisableOptions * g.exercisePrice), 0);
  return Math.round(v * 100) / 100;
}

/* ================= access ================= */

export interface AccessSubject {
  employeeId: string;
  blocked?: unknown;
  blockedReason?: string;
}

/** Domain.isBlocked */
export function isBlocked(e: AccessSubject): boolean {
  const v = trim(e.blocked).toLowerCase();
  return v === 'true' || v === 'yes' || v === 'y' || v === '1';
}

/** Domain.blockReason */
export function blockReason(e: AccessSubject): string {
  return trim(e.blockedReason) || 'Your participation has been put on hold by the ESOP team.';
}

/** Domain.isEnabled — the enabled list (empty = everyone). */
export function isEnabled(e: AccessSubject, settings: PortalSettings): boolean {
  if (!settings.eligibleEmployeeIds.length) return true;
  return settings.eligibleEmployeeIds.indexOf(trim(e.employeeId).toUpperCase()) >= 0;
}

export const LIMITED_GROUP_MESSAGE = 'The portal is open to a limited group at the moment. The ESOP team will ' +
  'write to you when it is open to you.';

/** Domain.accessBar — why this participant cannot act, or '' when they can. */
export function accessBar(e: AccessSubject, settings: PortalSettings): string {
  if (isBlocked(e)) return blockReason(e);
  if (!isEnabled(e, settings)) return LIMITED_GROUP_MESSAGE;
  return '';
}

/* ================= grant sync filters ================= */

/** GrantSync.run: is a report row on an allowed plan with an allowed status? */
export function isGrantRowAllowed(
  planName: string, grantStatus: string | undefined, settings: PortalSettings
): { ok: true } | { ok: false; reason: 'PLAN' | 'STATUS' } {
  if (settings.allowedPlans.indexOf(trim(planName)) < 0) return { ok: false, reason: 'PLAN' };
  const status = grantStatus === undefined ? 'Accepted' : trim(grantStatus);
  if (settings.allowedGrantStatuses && settings.allowedGrantStatuses.indexOf(status) < 0) {
    return { ok: false, reason: 'STATUS' };
  }
  return { ok: true };
}

/** GrantSync.run: the multiplier for a report row; blank → DEFAULT_MULTIPLIER. */
export function resolveMultiplier(
  raw: unknown, settings: PortalSettings
): { ok: true; multiplier: number; defaulted: boolean } | { ok: false } {
  const s = trim(raw);
  if (!s || s === '-') return { ok: true, multiplier: settings.defaultMultiplier, defaulted: true };
  const m = num(s, NaN);
  if (isNaN(m) || m <= 0) return { ok: false };
  return { ok: true, multiplier: m, defaulted: false };
}
