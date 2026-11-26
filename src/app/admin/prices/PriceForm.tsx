'use client';

import { useState } from 'react';
import { savePriceAction } from '../actions';
import { ActionForm } from '../_ui/ActionForm';

/** Manual entry: open and close → FMV preview, then save (Domain.upsertFmv). */
export function PriceForm({ today, initial }: { today: string; initial: { date: string; open: string; close: string } }) {
  const [open, setOpen] = useState(initial.open);
  const [close, setClose] = useState(initial.close);
  const o = Number(open), c = Number(close);
  const fmv = o > 0 && c > 0 ? Math.round(((o + c) / 2) * 100) / 100 : null;
  return (
    <ActionForm action={savePriceAction} key={initial.date + initial.open}>
      <div className="row2">
        <div className="field"><label htmlFor="pd">Trading day</label><input id="pd" type="date" name="date" max={today} defaultValue={initial.date} required /></div>
        <div className="field"><label htmlFor="ps">Source</label><input id="ps" type="text" name="source" placeholder="Manual entry (e.g. NSE bhavcopy)" /></div>
        <div className="field"><label htmlFor="po">Opening price (₹)</label><input id="po" type="number" step="0.01" min="0" name="open" value={open} onChange={(e) => setOpen(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pc">Closing price (₹)</label><input id="pc" type="number" step="0.01" min="0" name="close" value={close} onChange={(e) => setClose(e.target.value)} required /></div>
      </div>
      <p className="hint" aria-live="polite">{fmv !== null ? 'FMV = (' + o + ' + ' + c + ') ÷ 2 = ₹' + fmv.toFixed(2) : 'FMV = (open + close) ÷ 2, to 2 decimals.'}</p>
      <button className="btn">Save price</button>
    </ActionForm>
  );
}
