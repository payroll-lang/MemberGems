'use client';

import { useActionState } from 'react';
import { runImport, type ImportState } from './actions';

function Table({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data);
  if (!entries.length) return null;
  return (
    <>
      <h2 style={{ fontSize: 17, margin: '18px 0 6px' }}>{title}</h2>
      <table className="kv">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">{Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function ImportForm() {
  const [state, action, pending] = useActionState<ImportState, FormData>(runImport, {});
  return (
    <form action={action}>
      <label htmlFor="key">Setup key</label>
      <input id="key" name="key" type="password" autoComplete="off" required />
      <label htmlFor="workbook">Workbook (.xlsx)</label>
      <input id="workbook" name="workbook" type="file" accept=".xlsx" required />
      <fieldset style={{ border: 0, padding: 0, margin: '14px 0 0' }}>
        <legend className="small muted">What to do</legend>
        <label><input type="radio" name="mode" value="dry" defaultChecked /> Check only (writes nothing)</label>
        <label><input type="radio" name="mode" value="import" /> Import (can be repeated)</label>
        <label><input type="radio" name="mode" value="final" /> Final import before go-live (locks the import afterwards)</label>
      </fieldset>
      <button className="btn" disabled={pending}>{pending ? 'Working… this can take a minute' : 'Run'}</button>
      {state.error && <p className="alert error" role="alert">{state.error}</p>}
      {state.report && (
        <div role="status">
          <p className="alert ok">
            {state.dryRun ? 'Check complete. Nothing was written.' : state.result?.locked ? 'Final import complete. The import is now locked.' : 'Import complete.'}
          </p>
          <Table title="Read from the workbook" data={state.report.counts} />
          <Table title="Totals" data={state.report.totals} />
          <Table title="Not imported" data={state.report.skipped} />
          {state.result && <Table title="Written to the database" data={state.result.written} />}
          {state.result && <Table title="Removed (no longer in the workbook)" data={state.result.removed} />}
          {state.result && state.result.keptUpgradedPasswords > 0 && (
            <p className="small muted">{state.result.keptUpgradedPasswords} login(s) had already set a password on the new portal; those were kept.</p>
          )}
          {state.report.warnings.length > 0 && (
            <>
              <h2 style={{ fontSize: 17, margin: '18px 0 6px' }}>Warnings</h2>
              <ul className="small">{state.report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </form>
  );
}
