import Link from 'next/link';
import { count, inr, inr2, inWords, prettyDate } from '@/domain';
import { Callout, Figure, Pill, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { loadQueue } from '@/server/admin/views';
import { shortInr, sp, stamp } from './_ui/format';

export const metadata = { title: 'Verification queue · ESOP team' };

/** AdminApi.queue: every application, Submitted first, with the health of the masters. */
export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole('Admin');
  const p = await searchParams;
  const filters = { windowId: sp(p.window), status: sp(p.status), search: sp(p.q) };
  const d = await loadQueue(filters);
  const w = d.currentWindow;
  const h = d.health;
  const testBits: string[] = [];
  if (h.emailsOff) testBits.push('No emails are being sent at all (EMAILS_ENABLED is off) — every message is logged instead. Login codes appear on screen.');
  if (h.bulkEmailsOff) testBits.push('Window announcements and bulk invitations are off (BULK_EMAILS_ENABLED). Set it to true in Settings when participants should be told.');
  if (h.enabledCount) testBits.push('The portal is limited to ' + h.enabledCount + ' participant(s) on the enabled list; for everyone else the window reports closed. Clear the list on Participants → Bulk tools to open it to all.');

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <div className="eyebrow">{w.label} window · {prettyDate(w.openDate) || '—'} to {prettyDate(w.closeDate) || '—'}</div>
          <h1 className="title">Verification queue</h1>
          <p className="lede">
            {w.state.open ? <Pill kind="ok">Window open</Pill> : <Pill kind="bad">Window closed</Pill>} {w.state.reason}
            {w.taxDueDate ? ' · tax due ' + prettyDate(w.taxDueDate) : ''}
            {d.latestFmv ? ' · latest FMV ' + inr2(d.latestFmv.fmv) + ' (' + d.latestFmv.prettyDate + ')' : ' · no share price on record'}
          </p>
        </div>
        <div className="row">
          <Link className="btn ghost small" href="/admin/grants" prefetch={false}>Grant report</Link>
          <Link className="btn ghost small" href="/admin/windows" prefetch={false}>Announce window</Link>
          <Link className="btn ghost small" href={'/admin/export?window=' + encodeURIComponent(filters.windowId || w.windowId)} prefetch={false}>Export window</Link>
        </div>
      </div>

      {testBits.length ? (
        <Callout kind="warn" title="Test mode — read this before go-live"><ul className="remarks">{testBits.map((b, i) => <li key={i}>{b}</li>)}</ul></Callout>
      ) : <Callout title="Live settings"><p>Emails are on, window announcements are on, and the portal is open to every participant on the report.</p></Callout>}

      <Callout kind={h.grantRows ? 'plain' : 'crit'} title="Masters">
        <p>
          {h.grantRows ? count(h.grantRows) + ' grants on record, report as on ' + (prettyDate(h.reportAsOn) || '—') + ', synced ' + stamp(h.lastSyncedAt) + '.' : 'No grants on record — sync the vesting report first.'}{' '}
          {h.participantsWithoutTaxRate ? <><b>{h.participantsWithoutTaxRate}</b> participant(s) with vested options have no tax basis (no sheet row, no flat rate) — <Link href="/admin/participants?only=noTaxRate" prefetch={false}>see them</Link>. </> : 'Every participant with vested options has a tax basis. '}
          Lot rule: {h.lotSize} options, scope “{h.lotScope}”.
        </p>
      </Callout>

      <div className="figures">
        <Figure label="Awaiting verification" value={count((d.counts['Submitted'] || 0) + (d.counts['Under Review'] || 0))} sub="submitted or open" kind="accent" />
        <Figure label="Options listed" value={count(d.totals.options)} sub={count(d.totals.shares) + ' shares'} />
        <Figure label="Exercise amount" value={shortInr(d.totals.exerciseAmount)} sub="on these rows" />
        <Figure label="Perquisite" value={shortInr(d.totals.perquisite)} sub="on these rows" explain={{
          title: 'Total perquisite on these rows', formula: 'the sum of (FMV × shares) − exercise amount, across every application listed',
          steps: [['Applications listed', count(d.rows.length)], ['Options', count(d.totals.options)], ['Total perquisite', inr(d.totals.perquisite), 'total']],
          result: inr(d.totals.perquisite), resultWords: inWords(d.totals.perquisite),
          notes: ['This follows the filter applied to the list, so it is not necessarily the whole window. Each application has its own FMV, fixed by its own payment date.'],
        }} />
        <Figure label="Tax" value={shortInr(d.totals.tax)} sub="on these rows" kind="warn" explain={{
          title: 'Total tax on these rows', formula: 'the sum of each application’s tax',
          steps: [['Total perquisite', inr(d.totals.perquisite)], ['Total tax', inr(d.totals.tax), 'total']],
          result: inr(d.totals.tax), resultWords: inWords(d.totals.tax),
          notes: ['Each application is taxed on its participant’s own position (tax sheet) or flat rate, so this is not one percentage of the perquisite. An application with no rate loaded contributes nil.'],
        }} />
      </div>

      <section className="panel">
        <div className="panel-hd">
          <form className="filters" method="get" action="/admin">
            <div className="field">
              <label htmlFor="qw">Window</label>
              <select id="qw" name="window" defaultValue={filters.windowId}>
                <option value="">All windows</option>
                {d.windows.map((x) => <option key={x.windowId} value={x.windowId}>{x.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="qs">Status</label>
              <select id="qs" name="status" defaultValue={filters.status}>
                <option value="">All statuses</option>
                {d.statuses.map((s) => <option key={s} value={s}>{s} ({d.counts[s] || 0})</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="qq">Search</label>
              <input id="qq" type="text" name="q" defaultValue={filters.search} placeholder="Name, employee ID or reference" />
            </div>
            <button className="btn ghost small">Filter</button>
            {filters.windowId || filters.status || filters.search ? <Link href="/admin" prefetch={false} className="small">Clear</Link> : null}
          </form>
          <span className="dim">{d.rows.length} application{d.rows.length === 1 ? '' : 's'}</span>
        </div>
        <div className="panel-bd">
          {d.rows.length ? (
            <div className="tablewrap">
              <table className="data compact">
                <thead>
                  <tr>
                    <th scope="col">Participant</th><th scope="col">Reference</th><th scope="col" className="n">Options</th><th scope="col" className="n">Shares</th>
                    <th scope="col" className="n">Exercise</th><th scope="col" className="n">Perquisite</th><th scope="col" className="n">Tax</th>
                    <th scope="col">Route</th><th scope="col">Status</th><th scope="col" className="n">Verified</th><th scope="col">Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => {
                    const href = '/admin/applications/' + encodeURIComponent(r.appId);
                    return (
                      <tr key={r.appId}>
                        <td><a className="rowlink" href={href}>{r.employeeName || r.employeeId}</a><br /><span className="tag">{r.employeeId}{r.employmentStatus !== 'Active' ? ' · ' + r.employmentStatus.toLowerCase() : ''}</span></td>
                        <td className="mono"><a href={href}>{r.appId}</a></td>
                        <td className="n">{count(r.totalOptions)}</td>
                        <td className="n">{count(r.totalShares)}</td>
                        <td className="n">{inr(r.exerciseAmount)}</td>
                        <td className="n">{inr(r.perquisiteAmount)}</td>
                        <td className="n">{inr(r.taxAmount)}</td>
                        <td>{r.taxMode === 'FundPartner' ? <Pill kind="neutral">{r.fundPartnerName || 'Partner'}</Pill> : r.taxMode === 'Self' ? <Pill kind="neutral">Self</Pill> : <span className="dim">—</span>}</td>
                        <td>
                          <StatusPill status={r.status} />
                          {r.awaitingParticipant ? <><br /><Pill kind="wait">Partner paid · awaiting participant</Pill></>
                            : r.partnerStatus === 'Payment Fed' || r.partnerStatus === 'Verified' ? <><br /><span className="tag">partner {r.partnerStatus.toLowerCase()}</span></>
                              : r.status === 'Draft' || r.status === 'Sent Back' ? <><br /><span className="tag">{r.pendingLabels[0] ?? 'ready to submit'}</span></> : null}
                        </td>
                        <td className="n">{r.verifiedSections}/5{r.sentBackSections ? <><br /><Pill kind="bad">{r.sentBackSections} back</Pill></> : null}</td>
                        <td className="mini">{stamp(r.submittedAt || r.updatedAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="empty">No applications match.</div>}
        </div>
      </section>
    </div>
  );
}
