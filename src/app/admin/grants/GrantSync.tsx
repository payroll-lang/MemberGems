'use client';

import { useState } from 'react';
import { Result } from '@/components/Result';
import type { GrantSyncPreview } from '@/server/admin/grantSync';
import { previewGrantSyncAction, runGrantSyncAction } from '../actions';
import { NoteList } from '../_ui/ActionForm';
import type { AdminResult } from '../shared';
import { uploadImport } from '../_ui/upload';

const n = (x: number) => x.toLocaleString('en-IN');

/** Upload → dry run → run (GrantSync.run with dryRun, then for real). */
export function GrantSync() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<AdminResult>({});
  const [preview, setPreview] = useState<GrantSyncPreview | null>(null);

  async function check() {
    if (!file) { setResult({ error: 'Choose the report file first.', at: Date.now() }); return; }
    setPreview(null); setResult({});
    try {
      const path = await uploadImport('grantReport', file, setBusy);
      setBusy('Reading and checking the report…');
      const r = await previewGrantSyncAction(path);
      setResult(r);
      if (r.ok) setPreview(r.data as GrantSyncPreview);
    } catch (e) {
      setResult({ error: (e as Error).message, at: Date.now() });
    } finally { setBusy(''); }
  }

  async function run() {
    if (!preview) return;
    if (!window.confirm('Replace the grants with this report (' + n(preview.summary.grantRows) + ' grants for ' + n(preview.summary.employees) + ' participants)?')) return;
    setBusy('Syncing — this can take a minute…');
    try {
      const r = await runGrantSyncAction(preview.path);
      setResult(r);
      if (r.ok) setPreview(null);
    } catch (e) {
      setResult({ error: (e as Error).message, at: Date.now() });
    } finally { setBusy(''); }
  }

  const s = preview?.summary;
  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="gr">Vest wise Report (.xlsx or .csv, exactly as exported)</label>
        <input id="gr" type="file" accept=".xlsx,.csv" disabled={!!busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
      </div>
      <div className="row" style={{ marginTop: 0 }}>
        <button type="button" className="btn" disabled={!!busy || !file} onClick={check}>Check the report (dry run)</button>
        {preview ? <button type="button" className="btn" disabled={!!busy} onClick={run}>Run the sync</button> : null}
      </div>
      {busy ? <p className="hint" role="status">{busy}</p> : null}
      <Result state={result} />
      {s && preview ? (
        <div className="stack">
          <div className="grid2">
            <dl className="kv">
              <div className="kv-row"><dt>Report as on</dt><dd>{s.reportAsOn}{preview.sheet ? ' (sheet “' + preview.sheet + '”)' : ''}, headings on row {s.headerRow}</dd></div>
              <div className="kv-row"><dt>Rows read</dt><dd>{n(s.rowsRead)}</dd></div>
              <div className="kv-row"><dt>Rows used</dt><dd>{n(s.rowsUsed)}</dd></div>
              <div className="kv-row"><dt>Skipped — plan not allowed</dt><dd>{n(s.skippedPlan)}</dd></div>
              <div className="kv-row"><dt>Skipped — grant status</dt><dd>{n(s.skippedStatus)} {Object.keys(s.statusesSkipped).length ? '(' + Object.entries(s.statusesSkipped).map(([k, v]) => (k || 'blank') + ' ' + v).join(', ') + ')' : ''}</dd></div>
              <div className="kv-row"><dt>Skipped — no ID</dt><dd>{n(s.skippedNoId)}</dd></div>
              <div className="kv-row"><dt>Plans in the report</dt><dd>{Object.entries(s.plansSeen).map(([k, v]) => (k || 'blank') + ': ' + n(v)).join(' · ')}</dd></div>
              <div className="kv-row"><dt>Statuses allowed</dt><dd>{s.grantStatusesAllowed.join(', ')}</dd></div>
            </dl>
            <dl className="kv">
              <div className="kv-row"><dt>Would write</dt><dd><b>{n(s.grantRows)}</b> grants for <b>{n(s.employees)}</b> participants</dd></div>
              <div className="kv-row"><dt>Grants on record now</dt><dd>{n(preview.effect.grantsNow)} — {n(preview.effect.grantsRemoved)} would be removed</dd></div>
              <div className="kv-row"><dt>Fully closed grants left out</dt><dd>{n(s.grantsFullyClosed)}</dd></div>
              <div className="kv-row"><dt>Multiplier assumed</dt><dd>{n(s.grantsWithDefaultedMultiplier)} grant(s)</dd></div>
              <div className="kv-row"><dt>Participants</dt><dd>{n(preview.effect.employeesCreated)} new, {n(preview.effect.employeesUpdated)} updated</dd></div>
              <div className="kv-row"><dt>Without a tax rate</dt><dd>{n(preview.effect.employeesMissingTaxRate)}</dd></div>
              <div className="kv-row"><dt>Without an email</dt><dd>{n(preview.effect.employeesMissingEmail)}</dd></div>
              <div className="kv-row"><dt>Login addresses to update</dt><dd>{n(preview.effect.loginsToUpdate)}</dd></div>
              <div className="kv-row"><dt>Prefill columns found</dt><dd>{s.prefillColumnsFound.join(', ') || 'none'} ({n(s.participantsWithPrefills)} participant(s) carried a value)</dd></div>
            </dl>
          </div>
          <div className="callout">
            <h4>Lot rule ({s.preview.lotSize} options, scope “{s.preview.lotScope}”)</h4>
            <p>Vested {n(s.preview.vestedOptions)} → exercisable {n(s.preview.exercisableOptions)}; {n(s.preview.strandedBelowOneLot)} stranded below one lot
              across {n(s.preview.grantsUnderOneLot)} grant(s). {n(s.preview.employeesWithSomething)} participant(s) can exercise something, {n(s.preview.employeesWithNothing)} cannot.</p>
          </div>
          <div className="tablewrap">
            <table className="data compact">
              <thead><tr><th scope="col">Grant</th><th scope="col">Employee</th><th scope="col">Plan</th><th scope="col" className="n">×</th><th scope="col" className="n">Vested</th><th scope="col" className="n">Exercisable</th><th scope="col" className="n">Shares</th><th scope="col" className="n">Tranches</th><th scope="col">Next vest</th></tr></thead>
              <tbody>{s.sample.map((x) => (
                <tr key={x.grantId}><td className="mono">{x.grantId}</td><td>{x.employeeId}</td><td>{x.plan}</td><td className="n">{x.multiplier}</td><td className="n">{n(x.vested)}</td><td className="n">{n(x.exercisable)}</td><td className="n">{n(x.shares)}</td><td className="n">{x.tranches}</td><td>{x.nextVest || '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
          {s.warnings.length ? <NoteList title={'Warnings (' + s.warnings.length + ')'} items={s.warnings} /> : null}
          {s.unmatchedColumns.length ? <p className="hint">Columns not in this report (optional ones are fine): {s.unmatchedColumns.join(', ')}.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
