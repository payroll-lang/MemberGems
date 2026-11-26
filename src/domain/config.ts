/**
 * Settings and enumerations that the rules depend on (Config.gs).
 */
import { trim } from './util';

/* ================= enumerations ================= */

export const STATUS = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  SENT_BACK: 'Sent Back',
  APPROVED: 'Approved',
  REJECTED: 'Rejected'
} as const;
export type AppStatus = (typeof STATUS)[keyof typeof STATUS];

export const REVIEW = { PENDING: 'Pending', OK: 'Verified', BACK: 'Sent Back' } as const;
export type ReviewState = (typeof REVIEW)[keyof typeof REVIEW];

export const ROLE = { EMPLOYEE: 'Employee', ADMIN: 'Admin', PARTNER: 'FundPartner' } as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

export const TAX_MODE = { SELF: 'Self', PARTNER: 'FundPartner' } as const;
export type TaxMode = (typeof TAX_MODE)[keyof typeof TAX_MODE];

export const DEMAT_TYPES = ['NSDL', 'CDSL'] as const;
export type DematType = (typeof DEMAT_TYPES)[number];

/**
 * Partner request statuses. 'Withdrawn' was written as a bare string by the
 * legacy code (participant switched to paying themselves, or the application
 * was closed) and is now a named member.
 */
export const PARTNER_STATUS = {
  ASSIGNED: 'Assigned',
  PAID: 'Payment Fed',
  VERIFIED: 'Verified',
  SENT_BACK: 'Sent Back',
  DECLINED: 'Declined',
  WITHDRAWN: 'Withdrawn'
} as const;
export type PartnerStatus = (typeof PARTNER_STATUS)[keyof typeof PARTNER_STATUS];

export const STAGES = [
  { key: 'options', label: 'Options to exercise' },
  { key: 'demat', label: 'Applicant, demat & PAN' },
  { key: 'exercise', label: 'Exercise payment' },
  { key: 'tax', label: 'Tax payment' },
  { key: 'notice', label: 'Exercise notice' },
  { key: 'submit', label: 'Submit' }
] as const;
export type StageKey = (typeof STAGES)[number]['key'];

/** The five sections the ESOP team reviews, and their legacy column names. */
export const SECTIONS = [
  { key: 'options', column: 'ReviewOptions', label: 'options' },
  { key: 'demat', column: 'ReviewDemat', label: 'demat and PAN' },
  { key: 'exercisePayment', column: 'ReviewExercisePayment', label: 'exercise payment' },
  { key: 'taxPayment', column: 'ReviewTaxPayment', label: 'tax payment' },
  { key: 'notice', column: 'ReviewNotice', label: 'exercise notice' }
] as const;
export type SectionKey = (typeof SECTIONS)[number]['key'];

/* ================= settings ================= */

export type LotScope = 'grant' | 'total';

/**
 * How the FLAT tax is rounded.
 *   'rupee'  AGREED CHANGE (default): Math.round(perquisite × rate / 100).
 *   'paise'  legacy: Math.round(perquisite × rate) / 100.
 */
export type FlatTaxRounding = 'rupee' | 'paise';

export interface PortalSettings {
  /** ₹ per option when a grant carries none (EXERCISE_PRICE). */
  exercisePrice: number;
  /** OPTION_LOT_SIZE as configured; use lotSize() to read it. */
  optionLotSize: number;
  lotScope: LotScope;
  /** Used at grant sync when the report leaves Multiplier blank. */
  defaultMultiplier: number;
  allowedPlans: string[];
  /** null = every grant status is accepted. */
  allowedGrantStatuses: string[] | null;
  windowOpenDay: number;
  windowCloseDay: number;
  taxDueDay: number;
  /** Empty = everyone on the vesting report. Upper-cased IDs. */
  eligibleEmployeeIds: string[];
  paymentReferenceFormat: string;
  flatTaxRounding: FlatTaxRounding;
}

/**
 * CONFIG_DEFAULTS, the keys the rules read. ALLOWED_PLANS omits "Test Plan"
 * (agreed: test data is not migrated).
 */
export const CONFIG_DEFAULTS = {
  EXERCISE_PRICE: '1',
  OPTION_LOT_SIZE: '10',
  DEFAULT_MULTIPLIER: '1',
  LOT_SCOPE: 'grant',
  ALLOWED_PLANS: 'ESOP Plan 2022, ESOP Plan 2025',
  ALLOWED_GRANT_STATUSES: 'Accepted, PendingAcceptance',
  WINDOW_OPEN_DAY: '1',
  WINDOW_CLOSE_DAY: '30',
  TAX_DUE_DAY: '25',
  ELIGIBLE_EMPLOYEE_IDS: '',
  PAYMENT_REFERENCE_FORMAT: 'ESOP Exercise – {EMPLOYEE_ID} – {NAME}',
  FLAT_TAX_ROUNDING: 'rupee'
} as const;

export type ConfigMap = Partial<Record<string, string | number | boolean | null | undefined>>;

function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Parse ELIGIBLE_EMPLOYEE_IDS the way Domain.enabledSet does. */
export function parseEmployeeIdList(raw: string): string[] {
  const out: string[] = [];
  trim(raw).split(/[\s,;]+/).forEach((x) => {
    const id = trim(x).toUpperCase();
    if (id && out.indexOf(id) < 0) out.push(id);
  });
  return out;
}

/**
 * Build typed settings from a key/value map (the legacy Config tab), with
 * exactly the legacy fallbacks: a blank value means the default; cfgNum's
 * non-numeric value means the default.
 */
export function settingsFromConfig(map: ConfigMap = {}): PortalSettings {
  const raw = (key: keyof typeof CONFIG_DEFAULTS | 'REQUIRE_GRANT_ACCEPTED'): string | undefined => {
    const v = map[key];
    if (v === undefined || v === null) return undefined;
    return String(v);
  };
  const cfg = (key: keyof typeof CONFIG_DEFAULTS): string => {
    const v = raw(key);
    return v !== undefined && v !== '' ? v : CONFIG_DEFAULTS[key];
  };
  const cfgNum = (key: keyof typeof CONFIG_DEFAULTS, fallback: number): number => {
    const v = raw(key);
    const n = Number(v !== undefined && v !== '' ? v : String(fallback));
    return isNaN(n) ? (fallback || 0) : n;
  };

  const statuses = splitList(cfg('ALLOWED_GRANT_STATUSES'));
  const legacyAll = raw('REQUIRE_GRANT_ACCEPTED');
  const allowAll = legacyAll !== undefined && legacyAll.toLowerCase() === 'false';

  return {
    exercisePrice: cfgNum('EXERCISE_PRICE', 1),
    optionLotSize: cfgNum('OPTION_LOT_SIZE', 10),
    lotScope: trim(cfg('LOT_SCOPE')).toLowerCase() === 'total' ? 'total' : 'grant',
    defaultMultiplier: cfgNum('DEFAULT_MULTIPLIER', 1) || 1,
    allowedPlans: splitList(cfg('ALLOWED_PLANS')),
    allowedGrantStatuses: allowAll || !statuses.length ? null : statuses,
    windowOpenDay: cfgNum('WINDOW_OPEN_DAY', 1),
    windowCloseDay: cfgNum('WINDOW_CLOSE_DAY', 30),
    taxDueDay: cfgNum('TAX_DUE_DAY', 25),
    eligibleEmployeeIds: parseEmployeeIdList(cfg('ELIGIBLE_EMPLOYEE_IDS')),
    paymentReferenceFormat: cfg('PAYMENT_REFERENCE_FORMAT'),
    flatTaxRounding: trim(cfg('FLAT_TAX_ROUNDING')).toLowerCase() === 'paise' ? 'paise' : 'rupee'
  };
}

export const DEFAULT_SETTINGS: PortalSettings = settingsFromConfig({});

/** Domain.lotSize */
export function lotSize(s: PortalSettings): number {
  return s.optionLotSize > 0 ? s.optionLotSize : 10;
}

/** Domain.paymentReference */
export function paymentReference(s: PortalSettings, employee: { employeeId: string; name: string }): string {
  return String(s.paymentReferenceFormat)
    .replace(/\{EMPLOYEE_ID\}/g, trim(employee.employeeId))
    .replace(/\{NAME\}/g, trim(employee.name));
}
