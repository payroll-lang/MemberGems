/**
 * What the Settings screen may store (fix for review item 5: the legacy
 * saveConfig accepted any key and any value). Every key the portal reads is
 * catalogued with how its value is checked. Pure.
 */
import {
  CONFIG_DEFAULTS, REGIMES, normRegime, num, trim, type BandRow, type RuleRow, type RuleValue,
} from '@/domain';
import { PORTAL_TEXT_DEFAULTS } from '../../core/settings';

type Kind =
  | { type: 'bool' }
  | { type: 'number'; min: number; max: number; integer?: boolean }
  | { type: 'enum'; values: string[] }
  | { type: 'email' }
  | { type: 'emails' }
  | { type: 'list' }
  | { type: 'ids' }
  | { type: 'url' }
  | { type: 'text'; multiline?: boolean; max?: number };

export interface SettingSpec {
  key: string;
  group: 'Rules' | 'Email' | 'Company and notice' | 'Imports' | 'Share price' | 'Other';
  kind: Kind;
  defaultValue: string;
  note: string;
}

const RULES = CONFIG_DEFAULTS as Record<string, string>;
const TEXT = PORTAL_TEXT_DEFAULTS as Record<string, string>;

export const SETTINGS: SettingSpec[] = [
  { key: 'EXERCISE_PRICE', group: 'Rules', kind: { type: 'number', min: 0.01, max: 100000 }, defaultValue: RULES.EXERCISE_PRICE, note: '₹ per option when a grant carries no exercise price.' },
  { key: 'OPTION_LOT_SIZE', group: 'Rules', kind: { type: 'number', min: 1, max: 1000, integer: true }, defaultValue: RULES.OPTION_LOT_SIZE, note: 'Options are exercised in multiples of this (plans whose multiplier is not whole).' },
  { key: 'LOT_SCOPE', group: 'Rules', kind: { type: 'enum', values: ['grant', 'total'] }, defaultValue: RULES.LOT_SCOPE, note: '"grant": each grant in whole lots; "total": the lot applies to the total across grants.' },
  { key: 'DEFAULT_MULTIPLIER', group: 'Rules', kind: { type: 'number', min: 0.0001, max: 1000 }, defaultValue: RULES.DEFAULT_MULTIPLIER, note: 'Used at grant sync when the report leaves Multiplier blank.' },
  { key: 'ALLOWED_PLANS', group: 'Rules', kind: { type: 'list' }, defaultValue: RULES.ALLOWED_PLANS, note: 'Comma-separated plan names. Anything else in the report is ignored.' },
  { key: 'ALLOWED_GRANT_STATUSES', group: 'Rules', kind: { type: 'list' }, defaultValue: RULES.ALLOWED_GRANT_STATUSES, note: 'Comma-separated grant statuses whose options may be exercised.' },
  { key: 'WINDOW_OPEN_DAY', group: 'Rules', kind: { type: 'number', min: 0, max: 31, integer: true }, defaultValue: RULES.WINDOW_OPEN_DAY, note: 'Day of the month a new window opens (applies to windows created after the change).' },
  { key: 'WINDOW_CLOSE_DAY', group: 'Rules', kind: { type: 'number', min: 1, max: 31, integer: true }, defaultValue: RULES.WINDOW_CLOSE_DAY, note: 'Day of the month a window closes (capped at the month end).' },
  { key: 'TAX_DUE_DAY', group: 'Rules', kind: { type: 'number', min: 1, max: 31, integer: true }, defaultValue: RULES.TAX_DUE_DAY, note: 'Tax is due by this day of the payment month (or the next month when paid after it).' },
  { key: 'FLAT_TAX_ROUNDING', group: 'Rules', kind: { type: 'enum', values: ['rupee', 'paise'] }, defaultValue: RULES.FLAT_TAX_ROUNDING, note: 'Flat-rate tax rounded to whole rupees, or to the paise as the old portal did.' },
  { key: 'PAYMENT_REFERENCE_FORMAT', group: 'Rules', kind: { type: 'text', max: 140 }, defaultValue: RULES.PAYMENT_REFERENCE_FORMAT, note: 'Transfer narration shown to participants. {EMPLOYEE_ID} and {NAME} are filled in.' },
  { key: 'ELIGIBLE_EMPLOYEE_IDS', group: 'Rules', kind: { type: 'ids' }, defaultValue: '', note: 'The enabled list. Blank = everyone on the report. Easier to maintain on the Participants screen.' },
  { key: 'REQUIRE_GRANT_ACCEPTED', group: 'Rules', kind: { type: 'bool' }, defaultValue: '', note: 'Legacy switch: "false" accepts every grant status.' },
  { key: 'EMAILS_ENABLED', group: 'Email', kind: { type: 'bool' }, defaultValue: 'true', note: 'Off: every email is logged, none is sent.' },
  { key: 'BULK_EMAILS_ENABLED', group: 'Email', kind: { type: 'bool' }, defaultValue: 'false', note: 'Must be true for anything that emails participants en masse (window announcement, bulk invitations).' },
  { key: 'INVITE_EMAILS', group: 'Email', kind: { type: 'enum', values: ['manual', 'auto'] }, defaultValue: 'manual', note: '"auto" emails the one-time code when a login is created; "manual" shows it on screen.' },
  { key: 'SUPPORT_EMAIL', group: 'Email', kind: { type: 'email' }, defaultValue: '', note: 'Shown to participants as the address to write to.' },
  { key: 'ADMIN_NOTIFY_EMAILS', group: 'Email', kind: { type: 'emails' }, defaultValue: '', note: 'The ESOP team addresses told about submissions and missing prices.' },
  { key: 'EMAIL_SENDER_NAME', group: 'Email', kind: { type: 'text', max: 80 }, defaultValue: 'PhysicsWallah ESOP Team', note: 'Display name on outgoing mail.' },
  { key: 'EMAIL_REPLY_TO', group: 'Email', kind: { type: 'email' }, defaultValue: '', note: 'Reply-to address on outgoing mail.' },
  { key: 'EMAIL_FROM', group: 'Email', kind: { type: 'email' }, defaultValue: '', note: 'Only if it is a verified send-as alias of the sending mailbox.' },
  { key: 'COMPANY_NAME', group: 'Company and notice', kind: { type: 'text', max: 120 }, defaultValue: TEXT.COMPANY_NAME, note: '' },
  { key: 'COMPANY_FORMER_NAME', group: 'Company and notice', kind: { type: 'text', max: 160 }, defaultValue: TEXT.COMPANY_FORMER_NAME, note: '' },
  { key: 'COMPANY_ADDRESS', group: 'Company and notice', kind: { type: 'text', multiline: true, max: 400 }, defaultValue: TEXT.COMPANY_ADDRESS, note: '' },
  { key: 'PLAN_NAME', group: 'Company and notice', kind: { type: 'text', max: 160 }, defaultValue: TEXT.PLAN_NAME, note: 'As it appears on the exercise notice.' },
  { key: 'NOTICE_SHOW_SHARES', group: 'Company and notice', kind: { type: 'bool' }, defaultValue: 'true', note: 'Show the share count in the notice’s grant table.' },
  { key: 'COMPANY_BANK_DETAILS', group: 'Company and notice', kind: { type: 'text', multiline: true, max: 1000 }, defaultValue: TEXT.COMPANY_BANK_DETAILS, note: '"Label: value" lines. Where the exercise amount is paid.' },
  { key: 'TAX_BANK_DETAILS', group: 'Company and notice', kind: { type: 'text', multiline: true, max: 1000 }, defaultValue: TEXT.TAX_BANK_DETAILS, note: '"Label: value" lines. Where the tax is paid.' },
  { key: 'REPORT_HEADER_ROW', group: 'Imports', kind: { type: 'number', min: 1, max: 12, integer: true }, defaultValue: '4', note: 'Where the vesting report’s headings usually sit; other rows are searched too.' },
  { key: 'NSE_SYMBOL', group: 'Share price', kind: { type: 'text', max: 20 }, defaultValue: 'PWL', note: 'Shown in emails. Prices are entered by hand on this portal.' },
  { key: 'PORTAL_URL', group: 'Other', kind: { type: 'url' }, defaultValue: '', note: 'Informational: email links use the PORTAL_URL environment variable.' },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingSpec(key: string): SettingSpec | undefined {
  return BY_KEY.get(key);
}

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

/** Check and normalise one value. A blank value means "use the default". */
export function validateSetting(key: string, raw: unknown): { ok: true; key: string; value: string } | { ok: false; error: string } {
  const k = trim(key).toUpperCase();
  const spec = BY_KEY.get(k);
  if (!spec) return { ok: false, error: '"' + trim(key) + '" is not a setting the portal uses.' };
  let v = String(raw ?? '').replace(/\r\n/g, '\n');
  v = spec.kind.type === 'text' && spec.kind.multiline ? v.trim() : v.replace(/\s*\n\s*/g, ' ').trim();
  if (!v) return { ok: true, key: k, value: '' };
  const kind = spec.kind;
  switch (kind.type) {
    case 'bool': {
      const b = v.toLowerCase();
      if (b !== 'true' && b !== 'false') return { ok: false, error: k + ' must be true or false.' };
      return { ok: true, key: k, value: b };
    }
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n) || n < kind.min || n > kind.max || (kind.integer && !Number.isInteger(n))) {
        return { ok: false, error: k + ' must be ' + (kind.integer ? 'a whole number' : 'a number') + ' from ' + kind.min + ' to ' + kind.max + '.' };
      }
      return { ok: true, key: k, value: String(n) };
    }
    case 'enum': {
      const e = v.toLowerCase();
      if (!kind.values.includes(e)) return { ok: false, error: k + ' must be ' + kind.values.map((x) => '"' + x + '"').join(' or ') + '.' };
      return { ok: true, key: k, value: e };
    }
    case 'email':
      if (!EMAIL.test(v)) return { ok: false, error: '"' + v + '" does not look like an email address.' };
      return { ok: true, key: k, value: v };
    case 'emails': {
      const list = v.split(/[,;\s]+/).filter(Boolean);
      const bad = list.find((e) => !EMAIL.test(e));
      if (bad) return { ok: false, error: '"' + bad + '" does not look like an email address.' };
      return { ok: true, key: k, value: list.join(', ') };
    }
    case 'list': {
      const list = v.split(',').map((x) => x.trim()).filter(Boolean);
      return { ok: true, key: k, value: list.join(', ') };
    }
    case 'ids': {
      const ids: string[] = [];
      v.split(/[\s,;]+/).forEach((x) => { const id = x.trim().toUpperCase(); if (id && !ids.includes(id)) ids.push(id); });
      return { ok: true, key: k, value: ids.join(', ') };
    }
    case 'url':
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
      } catch {
        return { ok: false, error: k + ' must be a web address starting https://' };
      }
      return { ok: true, key: k, value: v };
    case 'text':
      if (kind.max && v.length > kind.max) return { ok: false, error: k + ' is limited to ' + kind.max + ' characters.' };
      return { ok: true, key: k, value: v };
  }
}

/* ================= tax rules ================= */

export interface TaxRulesDoc {
  slabs: { regime: string; above: number; rate: number }[];
  surcharge: { regime: string; above: number; rate: number }[];
  rules: { regime: string; rule: string; value: RuleValue }[];
}

export const KNOWN_RULES = ['CessPercent', 'RoundIncomeTo', 'RebateIncomeLimit', 'RebateMaxAmount', 'RebateMarginalRelief', 'SurchargeMarginalRelief'];

/** Rows as "regime, above, rate" text, one per line. */
export function bandRowsText(rows: readonly BandRow[]): string {
  return rows.map((r) => [trim(r.regime), num(r.above, 0), num(r.rate, 0)].join(', ')).join('\n');
}

export function ruleRowsText(rows: readonly RuleRow[]): string {
  return rows.map((r) => [trim(r.regime), trim(r.rule), String(r.value)].join(', ')).join('\n');
}

function lines(text: string): string[][] {
  return String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\t|,/).map((c) => c.trim()));
}

function parseBands(text: string, what: string, errors: string[], maxRate: number) {
  const out: TaxRulesDoc['slabs'] = [];
  lines(text).forEach((c, i) => {
    const at = what + ' line ' + (i + 1) + ': ';
    const regime = normRegime(c[0]);
    const above = Number(String(c[1] ?? '').replace(/[,_\s]/g, ''));
    const rate = Number(String(c[2] ?? '').replace(/%$/, ''));
    if (!regime) { errors.push(at + 'the regime must be New or Old.'); return; }
    if (!Number.isFinite(above) || above < 0) { errors.push(at + '"' + (c[1] ?? '') + '" is not an income threshold.'); return; }
    if (!Number.isFinite(rate) || rate < 0 || rate > maxRate) { errors.push(at + 'the rate must be a percentage from 0 to ' + maxRate + '.'); return; }
    if (out.some((r) => r.regime === regime && r.above === above)) { errors.push(at + 'the ' + regime + ' threshold ' + above + ' is listed twice.'); return; }
    out.push({ regime, above, rate });
  });
  return out;
}

/** Parse and check the three tax tables from the editor's text. */
export function parseTaxRules(input: { slabs: string; surcharge: string; rules: string }): { ok: true; doc: TaxRulesDoc } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const slabs = parseBands(input.slabs, 'Slabs', errors, 60);
  const surcharge = parseBands(input.surcharge, 'Surcharge', errors, 60);
  const rules: TaxRulesDoc['rules'] = [];
  lines(input.rules).forEach((c, i) => {
    const at = 'Rules line ' + (i + 1) + ': ';
    const regime = normRegime(c[0]);
    const rule = trim(c[1]);
    const raw = trim(c.slice(2).join(','));
    if (!regime) { errors.push(at + 'the regime must be New or Old.'); return; }
    if (!KNOWN_RULES.includes(rule)) { errors.push(at + '"' + rule + '" is not a rule the tax engine reads (' + KNOWN_RULES.join(', ') + ').'); return; }
    let value: RuleValue;
    if (rule.endsWith('MarginalRelief')) {
      const b = raw.toUpperCase();
      if (b !== 'TRUE' && b !== 'FALSE') { errors.push(at + rule + ' must be TRUE or FALSE.'); return; }
      value = b;
    } else {
      const n = Number(raw.replace(/[,_\s]/g, ''));
      if (!Number.isFinite(n) || n < 0) { errors.push(at + rule + ' must be a number.'); return; }
      value = n;
    }
    if (rules.some((r) => r.regime === regime && r.rule === rule)) { errors.push(at + regime + ' ' + rule + ' is listed twice.'); return; }
    rules.push({ regime, rule, value });
  });
  REGIMES.forEach((g) => {
    const s = slabs.filter((r) => r.regime === g);
    if (!s.length) errors.push('Slabs: the ' + g + ' regime has no slabs.');
    else if (!s.some((r) => r.above === 0)) errors.push('Slabs: the ' + g + ' regime needs a first slab starting at 0.');
  });
  return errors.length ? { ok: false, errors } : { ok: true, doc: { slabs, surcharge, rules } };
}
