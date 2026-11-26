import 'server-only';
import { DEFAULT_RULE_ROWS, DEFAULT_SLAB_ROWS, DEFAULT_SURCHARGE_ROWS, annualTax, buildTaxTables, type BandRow, type RuleRow } from '@/domain';
import { audit } from '@/lib/audit';
import { db } from '@/lib/firebase';
import { COL, type UserDoc } from '@/lib/schema';
import { nowIso } from '@/lib/time';
import { configMapFrom } from '../core/settings';
import { UserError, type ActionResult } from '../core/errors';
import { bandRowsText, parseTaxRules, ruleRowsText, validateSetting } from './core/settingsRules';
import { parseHolidays } from './core/prices';
import { runAdmin } from './run';

/**
 * settings/portal.values, settings/taxRules and settings/holidays. Every
 * change is validated and audited (the legacy saveConfig accepted anything).
 */

function portalRef() {
  return db().collection(COL.settings).doc('portal');
}

/** Write one key into settings/portal.values (legacy Files.setConfigValue). */
export async function saveConfigValue(key: string, value: string, by: string): Promise<{ before: string }> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(portalRef());
    const before = configMapFrom(snap.data())[key] ?? '';
    const raw = snap.data() ?? {};
    // Stored flat by an older writer: move everything under `values` once.
    const values = raw.values && typeof raw.values === 'object' ? { ...(raw.values as Record<string, unknown>) } : configMapFrom(raw);
    values[key] = value;
    tx.set(portalRef(), { values, updatedAt: nowIso(), updatedBy: by }, raw.values ? { merge: true } : {});
    return { before };
  });
}

export async function loadConfigMap(): Promise<Record<string, string>> {
  return configMapFrom((await portalRef().get()).data());
}

/** AdminApi.saveConfig, with validation for every known key. */
export function saveSetting(user: UserDoc, key: string, value: string): Promise<ActionResult> {
  return runAdmin(user, 'saveSetting', async () => {
    const v = validateSetting(key, value);
    if (!v.ok) throw new UserError(v.error);
    const { before } = await saveConfigValue(v.key, v.value, user.userId);
    if (before === v.value) return { message: v.key + ' was already ' + (v.value ? '"' + v.value + '"' : 'blank (the default)') + '. Nothing changed.' };
    const show = (x: string) => (x.length > 200 ? x.slice(0, 200) + '…' : x) || '(default)';
    return {
      message: v.key + ' saved' + (v.value ? '.' : ' — blank, so the default applies.'),
      effects: [() => audit(user.userId, 'Admin', 'CONFIG_SET', v.key + ': ' + show(before) + ' → ' + show(v.value))],
    };
  });
}

/* ================= tax rules ================= */

export async function loadTaxRulesText(): Promise<{ slabs: string; surcharge: string; rules: string; stored: boolean; updatedAt: string; updatedBy: string }> {
  const d = (await db().collection(COL.settings).doc('taxRules').get()).data() ?? {};
  const rows = <T,>(v: unknown, dflt: readonly T[]) => (Array.isArray(v) && v.length ? (v as T[]) : dflt);
  return {
    slabs: bandRowsText(rows<BandRow>(d.slabs, DEFAULT_SLAB_ROWS)),
    surcharge: bandRowsText(rows<BandRow>(d.surcharge, DEFAULT_SURCHARGE_ROWS)),
    rules: ruleRowsText(rows<RuleRow>(d.rules, DEFAULT_RULE_ROWS)),
    stored: Array.isArray(d.slabs) && d.slabs.length > 0,
    updatedAt: String(d.updatedAt ?? ''),
    updatedBy: String(d.updatedBy ?? ''),
  };
}

/** The tax on a few incomes under both regimes, to sanity-check a change. */
export function taxPreview(input: { slabs: string; surcharge: string; rules: string }) {
  const p = parseTaxRules(input);
  if (!p.ok) return { ok: false as const, errors: p.errors };
  const tables = buildTaxTables(p.doc.slabs, p.doc.surcharge, p.doc.rules);
  const incomes = [700000, 1200000, 1500000, 2500000, 6000000, 12000000];
  return {
    ok: true as const,
    rows: incomes.map((x) => ({ income: x, New: annualTax('New', x, tables).total, Old: annualTax('Old', x, tables).total })),
  };
}

export function saveTaxRules(user: UserDoc, input: { slabs: string; surcharge: string; rules: string }): Promise<ActionResult> {
  return runAdmin(user, 'saveTaxRules', async () => {
    const p = parseTaxRules(input);
    if (!p.ok) throw new UserError('Nothing was saved:\n• ' + p.errors.join('\n• '));
    const ref = db().collection(COL.settings).doc('taxRules');
    const before = (await ref.get()).data() ?? {};
    await ref.set({ ...p.doc, updatedAt: nowIso(), updatedBy: user.userId });
    const count = (d: Record<string, unknown>) => ['slabs', 'surcharge', 'rules'].map((k) => k + ' ' + (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0)).join(', ');
    return {
      message: 'Tax rules saved. Applications are priced with them from their next save; submitted ones keep their tax unless repriced.',
      effects: [() => audit(user.userId, 'Admin', 'TAX_RULES_SET', 'before: ' + count(before) + '; after: ' + count(p.doc as unknown as Record<string, unknown>) +
        ' — ' + JSON.stringify(p.doc).slice(0, 3500))],
    };
  });
}

/* ================= exchange holidays ================= */

export function saveHolidays(user: UserDoc, text: string): Promise<ActionResult> {
  return runAdmin(user, 'saveHolidays', async () => {
    const p = parseHolidays(text);
    if (!p.ok) throw new UserError('Nothing was saved:\n• ' + p.errors.join('\n• '));
    const ref = db().collection(COL.settings).doc('holidays');
    const before = ((await ref.get()).data()?.dates ?? []) as string[];
    await ref.set({ dates: p.dates, updatedAt: nowIso(), updatedBy: user.userId });
    const added = p.dates.filter((d) => !before.includes(d));
    const removed = before.filter((d) => !p.dates.includes(d));
    return {
      message: 'Holiday calendar saved: ' + p.dates.length + ' date(s)' + (added.length ? ', ' + added.length + ' added' : '') + (removed.length ? ', ' + removed.length + ' removed' : '') + '.',
      effects: [() => audit(user.userId, 'Admin', 'HOLIDAYS_SET', 'added: ' + (added.join(', ') || 'none') + '; removed: ' + (removed.join(', ') || 'none'))],
    };
  });
}
