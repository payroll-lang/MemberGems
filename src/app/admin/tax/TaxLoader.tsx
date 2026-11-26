'use client';

import { useState } from 'react';
import { Result } from '@/components/Result';
import { readTaxCsv } from '@/server/admin/core/taxSheet';
import type { TaxLoadReport } from '@/server/admin/taxSheet';
import { loadTaxSheetAction } from '../actions';
import type { AdminResult } from '../shared';
import { uploadImport } from '../_ui/upload';
import { FlagBlocks } from './FlagBlocks';

/**
 * Tax.load from the HRIMS report. A .csv is read here, in the browser, and
 * only the ten tax columns are sent — names, PAN, date of birth and every
 * deduction stay on this computer, as on the old portal. An .xlsx is
 * uploaded, reduced to the same ten columns on the server, and deleted.
 */
export function TaxLoader({ today }: { today: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [asOn, setAsOn] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<AdminResult>({});

  async function go() {
    setResult({});
    try {
      if (!file) throw new Error('Choose the tax report file first.');
      if (!asOn) throw new Error('Enter the date payroll was processed up to.');
      let r: AdminResult;
      if (file.name.toLowerCase().endsWith('.csv')) {
        setBusy('Reading the file on this computer…');
        const parsed = readTaxCsv(await file.text());
        if (parsed.empty || (!parsed.missing.length && !parsed.rows.length)) throw new Error('That file has no data rows.');
        if (parsed.missing.length) throw new Error('That file is missing these columns: ' + parsed.missing.join('; ') + '. Is it the HRIMS tax report?');
        setBusy('Loading ' + parsed.rows.length.toLocaleString('en-IN') + ' rows and repricing drafts…');
        r = await loadTaxSheetAction({ asOn, rows: parsed.rows });
      } else if (file.name.toLowerCase().endsWith('.xlsx')) {
        const path = await uploadImport('taxSheet', file, setBusy);
        setBusy('Loading and repricing drafts…');
        r = await loadTaxSheetAction({ asOn, path });
      } else {
        throw new Error('Choose the report as a .csv or .xlsx file.');
      }
      setResult(r);
    } catch (e) {
      setResult({ error: (e as Error).message, at: Date.now() });
    } finally { setBusy(''); }
  }

  const rep = result.ok ? (result.data as TaxLoadReport | undefined) : undefined;
  return (
    <div className="stack">
      <div className="row2">
        <div className="field">
          <label htmlFor="tf">Tax report (.csv, or .xlsx)</label>
          <input id="tf" type="file" accept=".csv,.xlsx,text/csv" disabled={!!busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div className="field">
          <label htmlFor="ta">Payroll processed up to <span className="req">required</span></label>
          <input id="ta" type="date" max={today} value={asOn} onChange={(e) => setAsOn(e.target.value)} disabled={!!busy} />
          <p className="hint">The last day of the payroll month the report reflects. Exercises approved after this date are added on top automatically.</p>
        </div>
      </div>
      <div className="row" style={{ marginTop: 0 }}><button type="button" className="btn" disabled={!!busy} onClick={go}>Load tax sheet</button></div>
      {busy ? <p className="hint" role="status">{busy}</p> : null}
      <Result state={result} />
      {rep ? (
        <div className="stack">
          <dl className="kv">
            <div className="kv-row"><dt>Rows received</dt><dd>{rep.received.toLocaleString('en-IN')} ({rep.notParticipants} not participants, {rep.duplicates} duplicates)</dd></div>
            <div className="kv-row"><dt>Loaded</dt><dd>{rep.loaded.toLocaleString('en-IN')} participants, as on {rep.asOn}</dd></div>
            <div className="kv-row"><dt>Participants with no row</dt><dd>{rep.participantsWithoutRow} — priced at their flat percentage</dd></div>
            <div className="kv-row"><dt>Drafts repriced</dt><dd>{rep.repriced}</dd></div>
            <div className="kv-row"><dt>Submitted, left frozen</dt><dd>{rep.frozen.length ? rep.frozen.join(', ') : 'none'}</dd></div>
          </dl>
          <FlagBlocks flagged={rep.flagged} />
        </div>
      ) : null}
    </div>
  );
}
