import { monthYear, prettyDate } from '@/domain';
import { Callout, Panel, Pill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { stateOf } from '@/server/windows';
import { loadWindows } from '@/server/admin/windows';
import { emailSwitches } from '@/server/admin/views';
import { loadSettings } from '@/server/settings';
import { createWindowAction, saveWindowAction } from '../actions';
import { ActionForm } from '../_ui/ActionForm';
import { stamp } from '../_ui/format';
import { Announce } from './Announce';

export const metadata = { title: 'Windows · ESOP team' };
export const maxDuration = 300;

/** Exercise windows: legacy had no screen for them (they were created and closed by the daily job). */
export default async function WindowsPage() {
  await requireRole('Admin');
  const [d, settings] = await Promise.all([loadWindows(), loadSettings()]);
  const current = d.windows.find((w) => w.windowId === d.today.slice(0, 7)) ?? null;
  const sw = emailSwitches(settings.config);
  const nextMonth = (() => { const [y, m] = d.today.split('-').map(Number); return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0'); })();
  return (
    <div className="stack">
      <div><div className="eyebrow">Masters</div><h1 className="title">Exercise windows</h1>
        <p className="lede">One window per month (open day {settings.portal.windowOpenDay}, close day {settings.portal.windowCloseDay}, tax due day {settings.portal.taxDueDay}). The daily job creates and closes them; change one here when the dates must differ.</p></div>

      <Panel title="Announce the current window">
        {current ? <p>{current.label}: {prettyDate(current.openDate)} to {prettyDate(current.closeDate)} — {stateOf(current, d.today).reason}</p> : <p>There is no window for this month yet.</p>}
        {!sw.bulk ? <Callout kind="warn" title="Bulk emails are off"><p>BULK_EMAILS_ENABLED is not true, so the announcement will refuse to send. Switch it on in Settings first, then back off afterwards.</p></Callout> : null}
        <p className="hint">Sent in batches of 100. Each participant is told at most once per window (shared with the scheduled announcement), so pressing it again only reaches those not yet told.</p>
        <Announce />
      </Panel>

      <Panel title="Windows">
        {d.windows.map((w) => (
          <details key={w.windowId} className="tranches" open={w.windowId === d.today.slice(0, 7)}>
            <summary><b>{w.label || monthYear(w.windowId + '-01')}</b> · {prettyDate(w.openDate)} – {prettyDate(w.closeDate)} · tax due {prettyDate(w.taxDueDate)} ·{' '}
              <Pill kind={w.status === 'Open' ? 'ok' : 'neutral'}>{w.status}</Pill> · {d.counts[w.windowId] ?? 0} application(s)</summary>
            <ActionForm action={saveWindowAction}>
              <input type="hidden" name="windowId" value={w.windowId} />
              <div className="row2">
                <div className="field"><label htmlFor={'l' + w.windowId}>Label</label><input id={'l' + w.windowId} type="text" name="label" defaultValue={w.label} /></div>
                <div className="field"><label htmlFor={'s' + w.windowId}>Status</label>
                  <select id={'s' + w.windowId} name="status" defaultValue={w.status}><option>Open</option><option>Closed</option></select></div>
                <div className="field"><label htmlFor={'o' + w.windowId}>Opens</label><input id={'o' + w.windowId} type="date" name="openDate" defaultValue={w.openDate} /></div>
                <div className="field"><label htmlFor={'c' + w.windowId}>Closes</label><input id={'c' + w.windowId} type="date" name="closeDate" defaultValue={w.closeDate} /></div>
                <div className="field"><label htmlFor={'t' + w.windowId}>Tax due (default for new applications)</label><input id={'t' + w.windowId} type="date" name="taxDueDate" defaultValue={w.taxDueDate} /></div>
                <div className="field"><label htmlFor={'r' + w.windowId}>Remarks</label><input id={'r' + w.windowId} type="text" name="remarks" defaultValue={w.remarks} /></div>
              </div>
              <p className="mini">Created {stamp(w.createdAt)}{w.closedAt ? ' · closed ' + stamp(w.closedAt) : ''}</p>
              <button className="btn small">Save window</button>
            </ActionForm>
          </details>
        ))}
        {!d.windows.length ? <p className="empty">No windows yet.</p> : null}
        <ActionForm action={createWindowAction}>
          <h3 className="sub">Create a window</h3>
          <div className="filters">
            <div className="field"><label htmlFor="nm">Month</label><input id="nm" type="text" name="month" placeholder="yyyy-mm" defaultValue={nextMonth} /></div>
            <button className="btn ghost small">Create with the configured days</button>
          </div>
        </ActionForm>
      </Panel>
    </div>
  );
}
