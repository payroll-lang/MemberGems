import Link from 'next/link';
import { count, prettyDate } from '@/domain';
import { Callout, Figure, Pill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { PARTICIPANT_FILTERS, type ParticipantFilter } from '@/server/admin/core/queue';
import { loadParticipants } from '@/server/admin/participants';
import { qs, sp, stamp } from '../_ui/format';

export const metadata = { title: 'Participants · ESOP team' };

export default async function ParticipantsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole('Admin');
  const p = await searchParams;
  const search = sp(p.q);
  const onlyRaw = sp(p.only);
  const only = (PARTICIPANT_FILTERS.some((f) => f.value === onlyRaw) ? onlyRaw : '') as ParticipantFilter;
  const d = await loadParticipants({ search, only, page: Number(sp(p.page)) || 1 });
  const s = d.summary;
  return (
    <div className="stack">
      <div className="spread">
        <div>
          <div className="eyebrow">Masters</div>
          <h1 className="title">Participants</h1>
          <p className="lede">Everyone on the vesting report. Exercisable is after the lot rule; it does not deduct applications in progress.</p>
        </div>
        <div className="row">
          <Link className="btn ghost small" href="/admin/participants/new" prefetch={false}>Add a participant</Link>
          <Link className="btn ghost small" href="/admin/participants/bulk" prefetch={false}>Bulk tools</Link>
        </div>
      </div>
      <div className="figures">
        <Figure label="Participants" value={count(s.participants)} sub={count(s.withExercisable) + ' with something exercisable'} />
        <Figure label="No tax basis" value={count(s.withoutTaxRate)} sub="exercisable, no sheet row or rate" kind={s.withoutTaxRate ? 'warn' : undefined} />
        <Figure label="On tax sheet" value={count(s.onTaxSheet)} sub={d.taxSheet.rows ? 'as on ' + (prettyDate(d.taxSheet.asOn) || '—') : 'no sheet loaded'} />
        <Figure label="No login" value={count(s.withoutLogin)} sub={count(s.withoutEmail) + ' exercisable without an email'} />
        <Figure label="Blocked" value={count(s.blocked)} sub={d.enabledIds.length ? d.enabledIds.length + ' on the enabled list' : 'open to everyone'} kind={s.blocked ? 'crit' : undefined} />
        <Figure label="Prefilled" value={count(s.withDemat)} sub={'demat · ' + count(s.withPan) + ' PAN'} />
      </div>
      {d.enabledIds.length ? <Callout kind="warn" title="Enabled list in force"><p>Only {d.enabledIds.length} participant(s) can use the portal. <Link href="/admin/participants/bulk" prefetch={false}>Change it</Link>.</p></Callout> : null}
      <section className="panel">
        <div className="panel-hd">
          <form className="filters" method="get" action="/admin/participants">
            <div className="field"><label htmlFor="pq">Search</label><input id="pq" type="text" name="q" defaultValue={search} placeholder="Name, employee ID or email" /></div>
            <div className="field">
              <label htmlFor="po">Show</label>
              <select id="po" name="only" defaultValue={only}>{PARTICIPANT_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</select>
            </div>
            <button className="btn ghost small">Filter</button>
          </form>
          <span className="dim">{count(d.matched)} match{d.matched === 1 ? '' : 'es'}</span>
        </div>
        <div className="panel-bd">
          {d.rows.length ? (
            <div className="tablewrap">
              <table className="data compact">
                <thead><tr>
                  <th scope="col">Participant</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Plans</th>
                  <th scope="col" className="n">Vested</th><th scope="col" className="n">Exercisable</th><th scope="col" className="n">Shares</th>
                  <th scope="col">Tax</th><th scope="col">PAN / demat</th><th scope="col">Login</th>
                </tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.employeeId} className={r.blocked || !r.enabled ? 'dim' : undefined}>
                      <td><Link href={'/admin/participants/' + encodeURIComponent(r.employeeId)} prefetch={false}>{r.name || r.employeeId}</Link><br /><span className="tag">{r.employeeId}{r.designation ? ' · ' + r.designation : ''}</span></td>
                      <td className="mini">{r.email || <span className="err-text">none</span>}</td>
                      <td>{r.employmentStatus}{r.separationDate ? <><br /><span className="mini">left {prettyDate(r.separationDate)}</span></> : null}
                        {r.blocked ? <><br /><Pill kind="bad">Blocked</Pill></> : null}{!r.enabled ? <><br /><Pill kind="neutral">Not enabled</Pill></> : null}</td>
                      <td className="mini">{r.plans || '—'}</td>
                      <td className="n">{count(r.vested)}</td><td className="n">{count(r.exercisable)}</td><td className="n">{count(r.shares)}</td>
                      <td>{r.taxBasis === 'sheet' ? <Pill kind="ok">Sheet</Pill> : r.taxBasis === 'flat' ? <Pill kind="neutral">{r.taxRatePercent}%</Pill> : <Pill kind="wait">None</Pill>}</td>
                      <td className="mini">{r.pan ? 'PAN' : '—'} / {r.hasDemat ? 'demat' : '—'}</td>
                      <td className="mini">{r.hasLogin ? r.loginStatus + (r.lastLoginAt ? ' · ' + stamp(r.lastLoginAt) : ' · never') : <span className="dim">none</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">No participants match.</p>}
          {d.pages > 1 ? (
            <div className="pager">
              {d.page > 1 ? <Link href={'/admin/participants' + qs({ q: search, only, page: d.page - 1 })} prefetch={false}>← Previous</Link> : null}
              <span>Page {d.page} of {d.pages}</span>
              {d.page < d.pages ? <Link href={'/admin/participants' + qs({ q: search, only, page: d.page + 1 })} prefetch={false}>Next →</Link> : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
