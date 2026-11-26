'use client';

import { Result } from '@/components/Result';
import { useFormAction } from '@/components/useFormAction';
import { saveTaxRulesAction } from '../actions';
import type { AdminResult } from '../shared';

/** settings/taxRules: the slabs, surcharge bands and rules, as editable text, with a preview. */
export function TaxRulesForm({ initial }: { initial: { slabs: string; surcharge: string; rules: string } }) {
  const { state, pending, onSubmit } = useFormAction(saveTaxRulesAction);
  const rows = (state as AdminResult).data as { income: number; New: number; Old: number }[] | undefined;
  const n = (x: number) => '₹' + x.toLocaleString('en-IN');
  return (
    <form onSubmit={(e) => {
      const intent = ((e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
      if (intent === 'save' && !window.confirm('Save these tax rules? Draft applications use them from their next save; submitted ones keep their tax.')) { e.preventDefault(); return; }
      onSubmit(e);
    }}>
      <fieldset className="plain" disabled={pending}>
        <div className="grid2">
          <div className="field"><label htmlFor="tr-s">Slabs — regime, income above, rate %</label><textarea id="tr-s" name="slabs" rows={13} className="mono" defaultValue={initial.slabs} /></div>
          <div className="stack" style={{ gap: 0 }}>
            <div className="field"><label htmlFor="tr-u">Surcharge — regime, income above, rate %</label><textarea id="tr-u" name="surcharge" rows={8} className="mono" defaultValue={initial.surcharge} /></div>
            <div className="field"><label htmlFor="tr-r">Rules — regime, rule, value</label><textarea id="tr-r" name="rules" rows={12} className="mono" defaultValue={initial.rules} /></div>
          </div>
        </div>
        <div className="row">
          <button className="btn ghost" name="intent" value="preview">Preview</button>
          <button className="btn" name="intent" value="save">Save tax rules</button>
        </div>
      </fieldset>
      <Result state={state} />
      {rows?.length ? (
        <div className="tablewrap">
          <table className="data compact">
            <thead><tr><th scope="col">Taxable income</th><th scope="col" className="n">New regime: year’s tax</th><th scope="col" className="n">Old regime: year’s tax</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.income}><td>{n(r.income)}</td><td className="n">{n(r.New)}</td><td className="n">{n(r.Old)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
    </form>
  );
}
