import Link from 'next/link';
import { inr2, prettyDate } from '@/domain';
import { Callout, Panel } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { loadPrices } from '@/server/admin/prices';
import { saveHolidaysAction } from '../actions';
import { ActionForm } from '../_ui/ActionForm';
import { sp, stamp } from '../_ui/format';
import { PriceForm } from './PriceForm';

export const metadata = { title: 'Share price · ESOP team' };
export const maxDuration = 120;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default async function PricesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole('Admin');
  const p = await searchParams;
  const d = await loadPrices();
  const editDate = sp(p.date);
  const editing = d.rows.find((r) => r.date === editDate);
  const dow = (k: string) => DOW[new Date(k + 'T00:00:00Z').getUTCDay()];
  return (
    <div className="stack">
      <div><div className="eyebrow">Masters</div><h1 className="title">Share price and FMV</h1>
        <p className="lede">An exercise is priced at the average of the PWL opening and closing price on the trading day before the participant paid the exercise amount.
          If that day has no price the participant cannot record the payment until it is entered (agreed rule — no fallback to an older price).</p></div>
      <Callout kind="info" title="Prices are entered by hand">
        <p>The old portal’s NSE fetch was switched off and Google Finance works only inside Sheets, so this portal has no automatic price source yet. Enter each trading day’s prices here.</p>
      </Callout>

      {d.missing.length ? (
        <Callout kind="crit" title={d.missing.length + ' trading day(s) in the last 60 days have no price'}>
          <p>{d.missing.map((k, i) => <span key={k}>{i ? ', ' : ''}<Link href={'/admin/prices?date=' + k} prefetch={false}>{dow(k)} {prettyDate(k)}</Link></span>)}</p>
          <p>If the exchange was closed on one of these days, add it to the holiday calendar below instead.</p>
        </Callout>
      ) : <Callout title="No gaps"><p>Every weekday in the last 60 days that is not on the holiday calendar has a price.</p></Callout>}

      <div className="grid2">
        <Panel title={editing ? 'Correct ' + prettyDate(editing.date) : 'Enter a price'}>
          <PriceForm today={d.today} initial={{ date: editDate || '', open: editing ? String(editing.openPrice || '') : '', close: editing ? String(editing.closePrice || '') : '' }} />
          <p className="hint">Saving a corrected price reprices draft and sent-back applications priced on that day. Submitted ones are listed so you can reprice them explicitly.</p>
        </Panel>
        <Panel title="Exchange holidays" aside={d.holidays.length + ' dates'}>
          <ActionForm action={saveHolidaysAction}>
            <div className="field">
              <label htmlFor="hol">One date per line (anything after the date is ignored)</label>
              <textarea id="hol" name="dates" rows={12} className="mono" defaultValue={d.holidays.join('\n')} placeholder={'2026-11-08 Diwali\n2026-12-25 Christmas'} />
            </div>
            <button className="btn">Save calendar</button>
          </ActionForm>
          <p className="hint">Weekends are never trading days. A date here is skipped when finding “the trading day before”.</p>
        </Panel>
      </div>

      <Panel title="Recent prices" aside={d.rows.length + ' shown'}>
        {d.rows.length ? (
          <div className="tablewrap">
            <table className="data compact">
              <thead><tr><th scope="col">Date</th><th scope="col" className="n">Open</th><th scope="col" className="n">Close</th><th scope="col" className="n">FMV</th><th scope="col">Source</th><th scope="col">Entered</th><th scope="col"><span className="sr-only">Edit</span></th></tr></thead>
              <tbody>{d.rows.map((r) => (
                <tr key={r.date} className={d.holidays.includes(r.date) ? 'dim' : undefined}>
                  <td>{dow(r.date)} {prettyDate(r.date)}{d.holidays.includes(r.date) ? ' (holiday)' : ''}</td>
                  <td className="n">{r.openPrice ? inr2(r.openPrice) : '—'}</td><td className="n">{r.closePrice ? inr2(r.closePrice) : '—'}</td><td className="n">{inr2(r.fmv)}</td>
                  <td>{r.source}</td><td className="mini">{r.enteredBy} · {stamp(r.enteredAt)}</td>
                  <td><Link href={'/admin/prices?date=' + r.date} prefetch={false}>Edit</Link></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="empty">No prices on record.</p>}
      </Panel>
    </div>
  );
}
