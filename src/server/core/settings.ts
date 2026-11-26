/**
 * Settings as stored in Firestore, turned into what the rules and screens use.
 * Pure: the loader in ../settings.ts does the reading.
 *
 *   settings/portal    the legacy Config tab as a key → value map. Accepted
 *                      either flat ({COMPANY_NAME: '…'}) or under `values`.
 *   settings/taxRules  { slabs: BandRow[], surcharge: BandRow[], rules: RuleRow[] }
 *   settings/holidays  { dates: string[] }  exchange holidays, 'yyyy-MM-dd'
 */
import {
  buildTaxTables, settingsFromConfig, toDateKey, trim,
  type BandRow, type ConfigMap, type PortalSettings, type RuleRow, type TaxTables,
} from '@/domain';

/**
 * Config keys the screens, notice and mail read that the rules engine does
 * not (CONFIG_DEFAULTS in Config.gs). The rule keys live in domain/config.
 */
export const PORTAL_TEXT_DEFAULTS = {
  COMPANY_NAME: 'Physicswallah Limited',
  COMPANY_FORMER_NAME: 'Formerly known as ‘Physicswallah Private Limited’',
  COMPANY_ADDRESS: 'Plot No. B-8, Tower A 101-119,\nKLJ Noida One, 1st Floor, Sector-62, UP- 201309.',
  PLAN_NAME: 'Employees’ Stock Option Plan',
  NOTICE_SHOW_SHARES: 'true',
  SUPPORT_EMAIL: '',
  ADMIN_NOTIFY_EMAILS: '',
  COMPANY_BANK_DETAILS:
    'Account Name: Physicswallah Limited\n' +
    'Bank Name: ICICI Bank\n' +
    'IFSC Code: ICIC0000816\n' +
    'Account Number: 081605012055\n' +
    'Branch: Noida, Sector-63\n' +
    'Account Type: Current Account\n' +
    'Mode: NEFT / RTGS / IMPS / Bank Transfer only',
  TAX_BANK_DETAILS:
    'Account Name: Physicswallah Limited\n' +
    'Bank Name: ICICI Bank\n' +
    'IFSC Code: ICIC0000816\n' +
    'Account Number: 081605012055\n' +
    'Branch: Noida, Sector-63\n' +
    'Account Type: Current Account\n' +
    'Mode: NEFT / RTGS / IMPS / Bank Transfer only',
} as const;

export type PortalTextKey = keyof typeof PORTAL_TEXT_DEFAULTS;

export interface Settings {
  /** The raw map as stored (strings), for anything not modelled below. */
  config: Record<string, string>;
  /** The rule settings (lot size, windows, plans …). */
  portal: PortalSettings;
  tax: TaxTables;
  /** Exchange holidays, 'yyyy-MM-dd', sorted. */
  holidays: string[];
  text: Record<PortalTextKey, string>;
  noticeShowShares: boolean;
  adminEmails: string[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The key → value map from settings/portal, as strings. */
export function configMapFrom(doc: unknown): Record<string, string> {
  const d = asRecord(doc);
  const src = d.values && typeof d.values === 'object' ? asRecord(d.values) : d;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'values' || k === 'updatedAt' || k === 'updatedBy') continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    out[k.trim()] = String(v);
  }
  return out;
}

/** cfg(): the stored value, or the default when blank. */
export function cfgText(config: Record<string, string>, key: PortalTextKey): string {
  const v = config[key];
  return v !== undefined && v !== '' ? v : PORTAL_TEXT_DEFAULTS[key];
}

export function emailList(v: string): string[] {
  return trim(v).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function rows<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((r) => r && typeof r === 'object') as T[]) : [];
}

export function taxTablesFrom(doc: unknown): TaxTables {
  const d = asRecord(doc);
  return buildTaxTables(rows<BandRow>(d.slabs), rows<BandRow>(d.surcharge), rows<RuleRow>(d.rules));
}

export function holidaysFrom(doc: unknown): string[] {
  const d = asRecord(doc);
  const list = Array.isArray(d.dates) ? d.dates : [];
  const out = new Set<string>();
  list.forEach((x) => {
    const k = toDateKey(x);
    if (k) out.add(k);
  });
  return [...out].sort();
}

export function buildSettings(portalDoc: unknown, taxDoc: unknown, holidaysDoc: unknown): Settings {
  const config = configMapFrom(portalDoc);
  const text = Object.fromEntries(
    (Object.keys(PORTAL_TEXT_DEFAULTS) as PortalTextKey[]).map((k) => [k, cfgText(config, k)]),
  ) as Record<PortalTextKey, string>;
  return {
    config,
    portal: settingsFromConfig(config as ConfigMap),
    tax: taxTablesFrom(taxDoc),
    holidays: holidaysFrom(holidaysDoc),
    text,
    noticeShowShares: text.NOTICE_SHOW_SHARES.toLowerCase() !== 'false',
    adminEmails: emailList(text.ADMIN_NOTIFY_EMAILS),
  };
}

/** COMPANY_BANK_DETAILS is kept as "Label: value" lines. */
export function parseBankDetails(text: string): { pairs: [string, string][]; loose: string[] } {
  const pairs: [string, string][] = [];
  const loose: string[] = [];
  String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean).forEach((line) => {
    const at = line.indexOf(':');
    if (at > 0) pairs.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    else loose.push(line);
  });
  return { pairs, loose };
}
