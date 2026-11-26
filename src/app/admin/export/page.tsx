import { Callout, Panel, Pill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { EXPORT_COLUMNS } from '@/server/admin/core/exportRows';
import { loadWindows } from '@/server/admin/windows';
import { sp } from '../_ui/format';

export const metadata = { title: 'Export · ESOP team' };

/** AdminApi.exportWindow: one row per grant line, the 39 legacy columns, as .xlsx. */
export default async function ExportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole('Admin');
  const p = await searchParams;
  const d = await loadWindows();
  const hl = sp(p.window);
  return (
    <div className="stack">
      <div><div className="eyebrow">Reports</div><h1 className="title">Monthly export</h1>
        <p className="lede">For payroll and the registrar: every application in the window, one row per grant line, in the old portal’s 39 columns and order. Each download is audited.</p></div>
      <Panel title="Windows">
        <div className="tablewrap">
          <table className="data compact">
            <thead><tr><th scope="col">Window</th><th scope="col">Status</th><th scope="col" className="n">Applications</th><th scope="col">Download</th></tr></thead>
            <tbody>{d.windows.map((w) => (
              <tr key={w.windowId} className={w.windowId === hl ? 'clickable' : undefined}>
                <td>{w.label || w.windowId}</td><td><Pill kind={w.status === 'Open' ? 'ok' : 'neutral'}>{w.status}</Pill></td>
                <td className="n">{d.counts[w.windowId] ?? 0}</td>
                <td>{d.counts[w.windowId] ? <a href={'/admin/export/' + encodeURIComponent(w.windowId)} download>ESOP export {w.windowId}.xlsx</a> : <span className="dim">nothing to export</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
      <Callout title="Columns">
        <p className="mono small">{EXPORT_COLUMNS.join(' · ')}</p>
        <p>FolderURL, a Drive folder on the old portal, is now the application’s page on this portal (documents are opened from there). TaxPaymentDate is the latest tax remittance date, else the partner’s payment date. Timestamps are “yyyy-MM-dd HH:mm:ss” IST as before.</p>
      </Callout>
    </div>
  );
}
