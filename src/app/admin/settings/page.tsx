import { Callout, Panel } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { SETTINGS, settingSpec, type SettingSpec } from '@/server/admin/core/settingsRules';
import { loadConfigMap, loadTaxRulesText } from '@/server/admin/settingsStore';
import { saveSettingAction } from '../actions';
import { ActionForm } from '../_ui/ActionForm';
import { stamp } from '../_ui/format';
import { TaxRulesForm } from './TaxRulesForm';

export const metadata = { title: 'Settings · ESOP team' };

function Input({ spec, value }: { spec: SettingSpec; value: string }) {
  const id = 'set-' + spec.key;
  const k = spec.kind;
  if (k.type === 'bool' || k.type === 'enum') {
    const opts = k.type === 'bool' ? ['true', 'false'] : k.values;
    return (
      <select id={id} name="value" defaultValue={value}>
        <option value="">(default: {spec.defaultValue || 'blank'})</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if ((k.type === 'text' && k.multiline) || k.type === 'ids' || spec.key === 'ALLOWED_PLANS') {
    return <textarea id={id} name="value" rows={k.type === 'text' ? 5 : 3} defaultValue={value} placeholder={spec.defaultValue} />;
  }
  return <input id={id} type="text" name="value" defaultValue={value} placeholder={spec.defaultValue ? 'default: ' + spec.defaultValue : ''} />;
}

/** settings/portal.values (the Config tab) and settings/taxRules. Every change is validated and audited. */
export default async function SettingsPage() {
  await requireRole('Admin');
  const [config, tax] = await Promise.all([loadConfigMap(), loadTaxRulesText()]);
  const groups = [...new Set(SETTINGS.map((s) => s.group))];
  const unknown = Object.keys(config).filter((k) => !settingSpec(k)).sort();
  return (
    <div className="stack">
      <div><div className="eyebrow">Configuration</div><h1 className="title">Settings</h1>
        <p className="lede">A blank value means the default applies. Every change is checked against what the portal expects, and audited.</p></div>
      {groups.map((g) => (
        <Panel key={g} title={g}>
          {SETTINGS.filter((s) => s.group === g).map((s) => (
            <ActionForm key={s.key} action={saveSettingAction}>
              <input type="hidden" name="key" value={s.key} />
              <div className="settinggrid">
                <div>
                  <label htmlFor={'set-' + s.key} className="mono" style={{ margin: 0 }}>{s.key}</label>
                  {s.note ? <p className="hint" style={{ marginTop: 2 }}>{s.note}</p> : null}
                </div>
                <div className="inputrow">
                  <Input spec={s} value={config[s.key] ?? ''} />
                  <button className="btn ghost small">Save</button>
                </div>
              </div>
            </ActionForm>
          ))}
        </Panel>
      ))}
      {unknown.length ? (
        <Callout kind="plain" title="Other keys on record">
          <p>Carried over from the old Config tab and not used by this portal (kept, not editable here): <span className="mono">{unknown.join(', ')}</span>.</p>
        </Callout>
      ) : null}
      <Panel title="Tax rules" aside={tax.stored ? 'updated ' + stamp(tax.updatedAt) + ' by ' + (tax.updatedBy || '—') : 'built-in defaults (nothing stored yet)'}>
        <p className="hint">The sheet tax engine’s slabs, surcharge bands and rules (TaxSlabs, TaxSurcharge, TaxRules tabs). One row per line, comma separated; lines starting # are ignored. Preview shows the year’s tax at a few incomes before you save.</p>
        <TaxRulesForm initial={{ slabs: tax.slabs, surcharge: tax.surcharge, rules: tax.rules }} />
      </Panel>
    </div>
  );
}
