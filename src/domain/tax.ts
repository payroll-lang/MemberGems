/**
 * The tax on an ESOP exercise — a full port of Tax.gs.
 *
 * Rules are data (TaxTables). DEFAULT_TAX_TABLES are the shipped tax-year
 * 2026-27 rules, which equal the live TaxSlabs / TaxSurcharge / TaxRules tabs
 * as of 2026-11-26 (verified; see tests/golden/fixtures/live-tax-tabs.json).
 */
import type { FlatTaxRounding } from './config';
import { ceilTo } from './money';
import { DAY_MS, dayStartMs, instantMs, num, toDateKey, trim, type Numeric } from './util';

export type Regime = 'New' | 'Old';
export const REGIMES: readonly Regime[] = ['New', 'Old'];

export type RuleValue = string | number | boolean;

export interface TaxBand { above: number; rate: number }
export interface RegimeTable { slabs: TaxBand[]; surcharge: TaxBand[]; rules: Record<string, RuleValue> }
export type TaxTables = Record<Regime, RegimeTable>;

export interface BandRow { regime: unknown; above: Numeric; rate: Numeric }
export interface RuleRow { regime: unknown; rule: unknown; value: RuleValue }

/* ================= the rules, as shipped ================= */

export const DEFAULT_SLAB_ROWS: readonly BandRow[] = ([
  ['New', 0, 0], ['New', 400000, 5], ['New', 800000, 10], ['New', 1200000, 15],
  ['New', 1600000, 20], ['New', 2000000, 25], ['New', 2400000, 30],
  ['Old', 0, 0], ['Old', 250000, 5], ['Old', 500000, 20], ['Old', 1000000, 30]
] as const).map(([regime, above, rate]) => ({ regime, above, rate }));

export const DEFAULT_SURCHARGE_ROWS: readonly BandRow[] = ([
  ['New', 5000000, 10], ['New', 10000000, 15], ['New', 20000000, 25],
  ['Old', 5000000, 10], ['Old', 10000000, 15], ['Old', 20000000, 25], ['Old', 50000000, 37]
] as const).map(([regime, above, rate]) => ({ regime, above, rate }));

export const DEFAULT_RULE_ROWS: readonly RuleRow[] = ([
  ['New', 'CessPercent', 4], ['Old', 'CessPercent', 4],
  ['New', 'RoundIncomeTo', 10], ['Old', 'RoundIncomeTo', 10],
  ['New', 'RebateIncomeLimit', 1200000], ['Old', 'RebateIncomeLimit', 500000],
  ['New', 'RebateMaxAmount', 60000], ['Old', 'RebateMaxAmount', 12500],
  ['New', 'RebateMarginalRelief', 'TRUE'], ['Old', 'RebateMarginalRelief', 'FALSE'],
  ['New', 'SurchargeMarginalRelief', 'TRUE'], ['Old', 'SurchargeMarginalRelief', 'TRUE']
] as const).map(([regime, rule, value]) => ({ regime, rule, value }));

/** Tax.normRegime */
export function normRegime(v: unknown): Regime | '' {
  const s = trim(v).toLowerCase();
  if (s.indexOf('new') === 0) return 'New';
  if (s.indexOf('old') === 0) return 'Old';
  return '';
}

function truthy(v: unknown): boolean {
  return ['true', 'yes', 'y', '1'].indexOf(trim(v).toLowerCase()) >= 0;
}

/**
 * Tax.tables(): build from rows; an empty list falls back to the shipped
 * rows, and a regime left with no slabs gets the shipped slabs.
 */
export function buildTaxTables(
  slabRows: readonly BandRow[] = [],
  surchargeRows: readonly BandRow[] = [],
  ruleRows: readonly RuleRow[] = []
): TaxTables {
  const out: TaxTables = { New: { slabs: [], surcharge: [], rules: {} }, Old: { slabs: [], surcharge: [], rules: {} } };
  (slabRows.length ? slabRows : DEFAULT_SLAB_ROWS).forEach((r) => {
    const g = normRegime(r.regime); if (!g) return;
    out[g].slabs.push({ above: num(r.above, 0), rate: num(r.rate, 0) });
  });
  (surchargeRows.length ? surchargeRows : DEFAULT_SURCHARGE_ROWS).forEach((r) => {
    const g = normRegime(r.regime); if (!g) return;
    out[g].surcharge.push({ above: num(r.above, 0), rate: num(r.rate, 0) });
  });
  (ruleRows.length ? ruleRows : DEFAULT_RULE_ROWS).forEach((r) => {
    const g = normRegime(r.regime); if (!g) return;
    out[g].rules[trim(r.rule)] = r.value;
  });
  REGIMES.forEach((g) => {
    out[g].slabs.sort((a, b) => a.above - b.above);
    out[g].surcharge.sort((a, b) => a.above - b.above);
    if (!out[g].slabs.length) {
      out[g].slabs = DEFAULT_SLAB_ROWS.filter((r) => r.regime === g).map((r) => ({ above: num(r.above), rate: num(r.rate) }));
    }
  });
  return out;
}

export const DEFAULT_TAX_TABLES: TaxTables = buildTaxTables();

/* ================= the annual tax ================= */

function ruleNum(rg: RegimeTable, name: string, dflt: number): number {
  const v = rg.rules[name];
  return v === undefined || v === '' ? dflt : num(v, dflt);
}

function slabTax(rg: RegimeTable, x: number): number {
  const s = rg.slabs;
  let tax = 0;
  for (let i = 0; i < s.length; i++) {
    const lo = s[i].above;
    const hi = i + 1 < s.length ? s[i + 1].above : Infinity;
    if (x > lo) tax += (Math.min(x, hi) - lo) * s[i].rate / 100;
  }
  return tax;
}

function afterRebate(rg: RegimeTable, x: number): { base: number; after: number; rebate: number } {
  const base = slabTax(rg, x);
  const limit = ruleNum(rg, 'RebateIncomeLimit', 0);
  const max = ruleNum(rg, 'RebateMaxAmount', 0);
  if (limit <= 0) return { base, after: base, rebate: 0 };
  let after = base;
  if (x <= limit) after = base - Math.min(base, max);
  else if (truthy(rg.rules.RebateMarginalRelief === undefined ? 'FALSE' : rg.rules.RebateMarginalRelief)) {
    after = Math.min(base, x - limit);
  }
  return { base, after, rebate: base - after };
}

function band(rg: RegimeTable, x: number): { rate: number; above: number } {
  let hit = { rate: 0, above: 0 };
  rg.surcharge.forEach((b) => { if (x > b.above) hit = { rate: b.rate, above: b.above }; });
  return hit;
}

export interface AnnualTax {
  income: number;
  base: number;
  rebate: number;
  tax: number;
  surchargeRate: number;
  surchargeFrom: number;
  surchargeRaw: number;
  surcharge: number;
  marginalRelief: number;
  cessPercent: number;
  cess: number;
  total: number;
}

/**
 * Tax.annual: slab tax, rebate (+ marginal relief), surcharge (+ marginal
 * relief), cess, on income rounded UP to RoundIncomeTo. Whole rupees.
 */
export function annualTax(regime: Regime, income: number, tables: TaxTables = DEFAULT_TAX_TABLES): AnnualTax {
  const rg = tables[regime];
  if (!rg) throw new Error('Unknown tax regime "' + regime + '".');
  const x = ceilTo(Math.max(0, income), ruleNum(rg, 'RoundIncomeTo', 10));
  const ar = afterRebate(rg, x);
  const b = band(rg, x);

  const raw = ar.after * b.rate / 100;
  let sur = raw;
  if (b.rate > 0 && truthy(rg.rules.SurchargeMarginalRelief === undefined ? 'TRUE' : rg.rules.SurchargeMarginalRelief)) {
    const below = band(rg, b.above);
    const atThreshold = afterRebate(rg, b.above).after * (1 + below.rate / 100);
    sur = Math.max(0, Math.min(raw, atThreshold + (x - b.above) - ar.after));
  }
  const cessPct = ruleNum(rg, 'CessPercent', 4);
  const surR = Math.round(sur);
  const afterR = Math.round(ar.after);
  const cess = Math.round((afterR + surR) * cessPct / 100);
  return {
    income: x, base: Math.round(ar.base), rebate: Math.round(ar.rebate), tax: afterR,
    surchargeRate: b.rate, surchargeFrom: b.above, surchargeRaw: Math.round(raw),
    surcharge: surR, marginalRelief: Math.max(0, Math.round(raw) - surR),
    cessPercent: cessPct, cess, total: afterR + surR + cess
  };
}

/* ================= the tax sheet ================= */

/** Payroll's year-to-date position for one participant (a TaxSheet row). */
export interface TaxPosition {
  employeeId?: string;
  regime: unknown;
  netTaxable: Numeric;
  totalGross: Numeric;
  projectedGross: Numeric;
  totalTax?: Numeric;
  previousTds?: Numeric;
  outsideTax?: Numeric;
  tdsToDate?: Numeric;
  remainingMonths: Numeric;
  asOn: unknown;
  /** 'A,B' (legacy cell) or an array. */
  flags?: string | readonly string[];
}

export const TAX_FLAGS = ['NO_REGIME', 'NO_INCOME', 'MISMATCH', 'NEG_MONTHS', 'OVER_DEDUCTED'] as const;
export type TaxFlag = (typeof TAX_FLAGS)[number];
const BLOCKING = ['NO_REGIME', 'NO_INCOME', 'MISMATCH'];

function flagList(v: TaxPosition['flags']): string[] {
  const s = Array.isArray(v) ? v.join(',') : trim(v);
  return s.split(/[,\s]+/).filter(Boolean);
}

/** Tax.usable: can the sheet engine rely on this row? */
export function taxPositionUsable(row: TaxPosition | null | undefined):
  { ok: true; regime: Regime } | { ok: false; why: string } {
  if (!row) return { ok: false, why: 'No row for this participant in the tax sheet' };
  const regime = normRegime(row.regime);
  if (!regime) return { ok: false, why: 'Payroll shows no tax regime for this participant' };
  const stop = flagList(row.flags).filter((f) => BLOCKING.indexOf(f) >= 0)[0];
  if (stop === 'NO_INCOME') return { ok: false, why: 'Payroll shows no taxable income on record for this participant' };
  if (stop === 'MISMATCH') return { ok: false, why: 'Payroll’s own tax figure for this participant does not reconcile, so it was not relied on' };
  if (stop) return { ok: false, why: 'The tax-sheet row is flagged ' + stop };
  return { ok: true, regime };
}

/** One of the participant's applications, for perquisite approved since the sheet. */
export interface PriorApplication {
  appId: string;
  status: string;
  approvedAt?: unknown;
  perquisiteAmount: Numeric;
}

/** Tax.approvedSince: perquisite approved on or after the day after `asOn`. */
export function approvedSince(
  applications: readonly PriorApplication[], asOn: string, exceptAppId: string
): { amount: number; appIds: string[] } {
  const cut = asOn ? dayStartMs(asOn) + DAY_MS : 0;
  let sum = 0;
  const ids: string[] = [];
  applications.filter((a) => trim(a.status) === 'Approved' && trim(a.appId) !== trim(exceptAppId))
    .forEach((a) => {
      const when = instantMs(a.approvedAt);
      if (when !== null && when >= cut) { sum += num(a.perquisiteAmount, 0); ids.push(trim(a.appId)); }
    });
  return { amount: Math.round(sum * 100) / 100, appIds: ids };
}

/* ================= the tax on one exercise ================= */

export interface FlatBreakdown {
  v: 1; method: 'Flat'; reason: string; ratePercent: number; perquisite: number; collect: number;
}

export interface SheetBreakdown {
  v: 1; method: 'Sheet'; regime: Regime; asOn: string;
  perquisite: number; priorPerquisite: number; priorApps: string[];
  incomeBefore: number; incomeAfter: number;
  earned: number; future: number; earnedShare: number;
  taxBefore: number; taxAfter: number; dBase: number;
  surchargeRate: number; surchargeBefore: number; surchargeAfter: number;
  surchargeRaw: number; marginalRelief: number; rebateAfter: number;
  ownSurcharge: number; cliff: number; cliffNow: number; cliffLater: number; cessPercent: number;
  totalBefore: number; totalAfter: number; whole: number;
  collect: number; left: number;
  tdsToDate: number; outsideTax: number; remainingMonths: number;
}

export type TaxBreakdown = FlatBreakdown | SheetBreakdown;

export interface TaxResult {
  amount: number;
  method: 'Sheet' | 'Flat' | 'None';
  effectivePercent: number;
  breakdown: TaxBreakdown | null;
}

/**
 * The flat tax.
 *   'rupee' (AGREED CHANGE, default) = Math.round(perquisite × rate / 100)
 *   'paise' (legacy)                 = Math.round(perquisite × rate) / 100
 */
export function flatTaxAmount(perquisite: number, ratePercent: number, rounding: FlatTaxRounding): number {
  return rounding === 'paise'
    ? Math.round(perquisite * ratePercent) / 100
    : Math.round(perquisite * ratePercent / 100);
}

/** Tax.flat */
export function flatTax(perquisite: number, flatRate: number, why: string, rounding: FlatTaxRounding): TaxResult {
  const amount = flatTaxAmount(perquisite, flatRate, rounding);
  return {
    amount, method: 'Flat', effectivePercent: flatRate,
    breakdown: { v: 1, method: 'Flat', reason: why, ratePercent: flatRate, perquisite, collect: amount }
  };
}

export interface TaxForExerciseInput {
  perquisite: Numeric;
  /** The flat percentage to fall back on (Employees.TaxRatePercent). */
  flatRate: Numeric;
  /** This participant's tax-sheet row, if any. */
  position: TaxPosition | null | undefined;
  /** This participant's applications (for perquisite approved since asOn). */
  applications: readonly PriorApplication[];
  /** The application being priced (excluded from the prior perquisite). */
  appId: string;
  tables?: TaxTables;
  flatRounding: FlatTaxRounding;
}

/**
 * Tax.forExercise: the tax to collect now on this perquisite.
 * Sheet method = difference in annual tax with and without the perquisite,
 * less the share of any surcharge "cliff" that falls on future income, plus
 * cess, capped at the whole difference. Falls back to flat with a reason.
 */
export function taxForExercise(input: TaxForExerciseInput): TaxResult {
  const tables = input.tables || DEFAULT_TAX_TABLES;
  const P = Math.round(num(input.perquisite, 0) * 100) / 100;
  if (P <= 0) return { amount: 0, method: 'None', effectivePercent: 0, breakdown: null };

  const row = input.position;
  const ok = taxPositionUsable(row);
  if (!ok.ok || !row) return flatTax(P, num(input.flatRate, 0), ok.ok ? '' : ok.why, input.flatRounding);

  const regime = ok.regime;
  const asOn = toDateKey(row.asOn);
  const prior = approvedSince(input.applications, asOn, input.appId);

  const x0 = num(row.netTaxable, 0) + prior.amount;
  const projected = num(row.remainingMonths, 0) <= 0 ? 0 : Math.max(0, num(row.projectedGross, 0));
  const earned = Math.max(0, num(row.totalGross, 0) - num(row.projectedGross, 0)) + prior.amount;
  const share = earned + projected > 0 ? earned / (earned + projected) : 1;

  const before = annualTax(regime, x0, tables);
  const after = annualTax(regime, x0 + P, tables);

  const dBase = after.tax - before.tax;
  const dSur = after.surcharge - before.surcharge;
  const own = Math.max(0, Math.min(after.surchargeRate * dBase / 100, dSur));
  const cliff = Math.max(0, dSur - own);
  const cliffNow = cliff * share;
  const cessPct = after.cessPercent;

  const pre = dBase + own + cliffNow;
  const whole = after.total - before.total;
  const collect = Math.min(Math.max(0, whole), Math.round(pre * (1 + cessPct / 100)));

  return {
    amount: collect, method: 'Sheet', effectivePercent: Math.round(collect / P * 10000) / 100,
    breakdown: {
      v: 1, method: 'Sheet', regime, asOn,
      perquisite: P, priorPerquisite: prior.amount, priorApps: prior.appIds,
      incomeBefore: before.income, incomeAfter: after.income,
      earned: Math.round(earned), future: Math.round(projected), earnedShare: Math.round(share * 10000) / 10000,
      taxBefore: before.tax, taxAfter: after.tax, dBase,
      surchargeRate: after.surchargeRate, surchargeBefore: before.surcharge, surchargeAfter: after.surcharge,
      surchargeRaw: after.surchargeRaw, marginalRelief: after.marginalRelief, rebateAfter: after.rebate,
      ownSurcharge: Math.round(own), cliff: Math.round(cliff), cliffNow: Math.round(cliffNow),
      cliffLater: Math.round(cliff - cliffNow), cessPercent: cessPct,
      totalBefore: before.total, totalAfter: after.total, whole,
      collect, left: Math.max(0, whole - collect),
      tdsToDate: num(row.tdsToDate, 0), outsideTax: num(row.outsideTax, 0),
      remainingMonths: num(row.remainingMonths, 0)
    }
  };
}

/* ================= loading the sheet ================= */

/** A row of payroll's HRIMS tax sheet, as parsed in the browser. */
export interface TaxSheetInputRow {
  employeeId: unknown;
  regime: unknown;
  netTaxable: Numeric;
  totalGross: Numeric;
  projectedGross: Numeric;
  totalTax: Numeric;
  previousTds: Numeric;
  outsideTax: Numeric;
  tdsToDate: Numeric;
  remainingMonths: Numeric;
}

export interface AssessedTaxPosition {
  employeeId: string;
  /** The normalised regime, or the raw text when it is not recognised. */
  regime: string;
  netTaxable: number;
  totalGross: number;
  projectedGross: number;
  totalTax: number;
  previousTds: number;
  outsideTax: number;
  tdsToDate: number;
  remainingMonths: number;
  asOn: string;
  flags: TaxFlag[];
  engineTotal: number | '';
}

export type TaxSheetAssessment =
  | {
      ok: true;
      positions: AssessedTaxPosition[];
      received: number;
      notParticipants: number;
      duplicates: number;
      participantsWithoutRow: number;
      flagged: Record<TaxFlag, string[]>;
    }
  | { ok: false; error: string };

/**
 * Tax.load without the I/O: keep participants only (first row per ID wins),
 * flag each row, and normalise it for storage. MISMATCH = the engine's
 * annual total differs from payroll's TotalTax by more than ₹5.
 */
export function assessTaxSheet(input: {
  rows: readonly TaxSheetInputRow[];
  participantIds: readonly string[];
  asOn: unknown;
  tables?: TaxTables;
}): TaxSheetAssessment {
  const tables = input.tables || DEFAULT_TAX_TABLES;
  const asOn = toDateKey(input.asOn);
  if (!asOn) return { ok: false, error: 'Enter the date payroll was processed up to (the “as on” date of this report).' };
  const rows = input.rows || [];
  if (!rows.length) return { ok: false, error: 'No rows were received.' };

  const participants: Record<string, boolean> = {};
  input.participantIds.forEach((id) => { participants[trim(id).toUpperCase()] = true; });

  const out: AssessedTaxPosition[] = [];
  const flagged: Record<TaxFlag, string[]> = { NO_REGIME: [], NO_INCOME: [], MISMATCH: [], NEG_MONTHS: [], OVER_DEDUCTED: [] };
  const seen: Record<string, boolean> = {};
  let skipped = 0, duplicates = 0;

  rows.forEach((r) => {
    const id = trim(r.employeeId).toUpperCase();
    if (!id || !participants[id]) { skipped++; return; }
    if (seen[id]) { duplicates++; return; }
    seen[id] = true;

    const regime = normRegime(r.regime);
    const net = num(r.netTaxable, 0);
    const flags: TaxFlag[] = [];
    let engineTotal: number | '' = '';
    if (!regime) flags.push('NO_REGIME');
    if (net <= 0) flags.push('NO_INCOME');
    if (regime && net > 0) {
      engineTotal = annualTax(regime, net, tables).total;
      if (Math.abs(engineTotal - num(r.totalTax, 0)) > 5) flags.push('MISMATCH');
    }
    if (num(r.remainingMonths, 0) < 0) flags.push('NEG_MONTHS');
    if (num(r.tdsToDate, 0) + num(r.outsideTax, 0) + num(r.previousTds, 0) > num(r.totalTax, 0) &&
        num(r.totalTax, 0) > 0) flags.push('OVER_DEDUCTED');
    flags.forEach((f) => flagged[f].push(id));

    out.push({
      employeeId: id, regime: regime || trim(r.regime), netTaxable: net,
      totalGross: num(r.totalGross, 0), projectedGross: num(r.projectedGross, 0),
      totalTax: num(r.totalTax, 0), previousTds: num(r.previousTds, 0),
      outsideTax: num(r.outsideTax, 0), tdsToDate: num(r.tdsToDate, 0),
      remainingMonths: Math.max(0, num(r.remainingMonths, 0)),
      asOn, flags, engineTotal
    });
  });

  if (!out.length) {
    return {
      ok: false,
      error: 'None of the ' + rows.length + ' rows belong to a participant on the portal, so nothing was loaded. ' +
        'Check the file is the right report and that participants have been synced.'
    };
  }

  return {
    ok: true, positions: out, received: rows.length, notParticipants: skipped, duplicates,
    participantsWithoutRow: Object.keys(participants).filter((id) => !seen[id]).length,
    flagged
  };
}
