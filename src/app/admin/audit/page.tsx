import Link from 'next/link';
import { Panel } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { AUDIT_LIMIT, queryAudit } from '@/server/admin/auditLog';
import { sp, stamp } from '../_ui/format';

export const metadata = { title: 'Audit log · ESOP team' };

/** Every audited action (legacy had no viewer for its AuditLog tab). */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole('Admin');
  const p = await searchParams;
  const f = { appId: sp(p.app), actor: sp(p.actor), action: sp(p.action), text: sp(p.text), from: sp(p.from), to: sp(p.to) };
  const r = await queryAudit(f);
  return (
    <div className="stack">
      <div><div className="eyebrow">Reports</div><h1 className="title">Audit log</h1>
        <p className="lede">Newest first. Filter by application, person or action; the date range and text search narrow further.</p></div>
      <Panel title="Filter">
        <form className="filters" method="get" action="/admin/audit">
          <div className="field"><label htmlFor="aa">Application</label><input id="aa" type="text" name="app" defaultValue={f.appId} placeholder="APP-…" /></div>
          <div className="field"><label htmlFor="ac">Who</label><input id="ac" type="text" name="actor" defaultValue={f.actor} placeholder="user ID or system" /></div>
          <div className="field"><label htmlFor="at">Action</label><input id="at" type="text" name="action" defaultValue={f.action} placeholder="e.g. APP_APPROVED" /></div>
          <div className="field"><label htmlFor="af">From</label><input id="af" type="date" name="from" defaultValue={f.from} /></div>
          <div className="field"><label htmlFor="au">To</label><input id="au" type="date" name="to" defaultValue={f.to} /></div>
          <div className="field"><label htmlFor="ax">Text</label><input id="ax" type="text" name="text" defaultValue={f.text} /></div>
          <button className="btn ghost small">Filter</button>
          <Link href="/admin/audit" prefetch={false} className="small">Clear</Link>
        </form>
      </Panel>
      <Panel title="Entries" aside={r.rows.length + (r.rows.length >= AUDIT_LIMIT ? '+ (first ' + AUDIT_LIMIT + ')' : '') + (r.capped ? ' · scanned the latest ' + r.scanned + ' — narrow the filter' : '')}>
        {r.rows.length ? (
          <div className="tablewrap">
            <table className="data compact">
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Application</th><th scope="col">Details</th></tr></thead>
              <tbody>{r.rows.map((x) => (
                <tr key={x.id}>
                  <td className="mini nowrap">{stamp(x.at)}</td>
                  <td><Link href={'/admin/audit?actor=' + encodeURIComponent(x.actor)} prefetch={false}>{x.actor}</Link> <span className="mini">{x.role}</span></td>
                  <td className="mono"><Link href={'/admin/audit?action=' + encodeURIComponent(x.action)} prefetch={false}>{x.action}</Link></td>
                  <td className="mono">{x.appId ? <a href={'/admin/applications/' + encodeURIComponent(x.appId)}>{x.appId}</a> : ''}</td>
                  <td>{x.details}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="empty">Nothing matches.</p>}
      </Panel>
    </div>
  );
}
