'use client';

import { useRef, useState } from 'react';
import type { AdminResult, IssuedCodeView } from '../shared';
import { Codes, NoteList } from './ActionForm';

interface BatchData { done: boolean; cursor: string; total: number; skipped?: string[]; issued?: IssuedCodeView[]; sent?: number; processed?: number }

/**
 * Runs a batched admin action until it reports done: each call processes one
 * batch (~100) and returns a cursor for the next. Stoppable between batches.
 */
export function BatchRunner({ label, confirm, run, withEmailOption, emailLabel }: {
  label: string;
  confirm: string;
  run: (cursor: string, sendEmail: boolean) => Promise<AdminResult>;
  withEmailOption?: boolean;
  emailLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [stop, setStop] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<IssuedCodeView[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [sendEmail, setSendEmail] = useState(false);
  const stopRef = useRef(false);

  async function go() {
    if (!window.confirm(confirm)) return;
    setBusy(true); setError(''); setLog([]); setIssued([]); setSkipped([]); setStop(false); stopRef.current = false;
    let cursor = '';
    try {
      for (let i = 0; i < 200; i++) {
        const r = await run(cursor, sendEmail);
        if (!r.ok) { setError(r.error ?? 'Stopped.'); break; }
        const d = r.data as BatchData;
        setLog((l) => [...l, r.message ?? '']);
        if (d.issued?.length) setIssued((x) => [...x, ...d.issued!]);
        if (d.skipped?.length) setSkipped((x) => [...x, ...d.skipped!]);
        if (d.done || d.cursor === cursor) break;
        cursor = d.cursor;
        if (stopRef.current) { setLog((l) => [...l, 'Stopped by you. Press again to continue from where it left off (already-done people are skipped).']); break; }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      {withEmailOption ? (
        <div className="checkline"><input id={'em-' + label} type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} disabled={busy} />
          <label htmlFor={'em-' + label}>{emailLabel ?? 'Email the codes'}</label></div>
      ) : null}
      <div className="row" style={{ marginTop: 0 }}>
        <button type="button" className="btn" disabled={busy} onClick={go}>{label}</button>
        {busy ? <button type="button" className="btn ghost" disabled={stop} onClick={() => { stopRef.current = true; setStop(true); }}>Stop after this batch</button> : null}
      </div>
      {busy ? <p className="hint" role="status">Working — keep this page open…</p> : null}
      {error ? <div className="alert error" role="alert">{error}</div> : null}
      {log.length ? <ol className="remarks">{log.map((l, i) => <li key={i}>{l}</li>)}</ol> : null}
      {issued.length ? <Codes issued={issued} /> : null}
      {skipped.length ? <NoteList title={'Skipped (' + skipped.length + ')'} items={skipped} /> : null}
    </div>
  );
}
