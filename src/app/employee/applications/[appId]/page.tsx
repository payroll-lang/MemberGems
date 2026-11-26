import type { ReactNode } from 'react';
import Link from 'next/link';
import { count, inr, inr2, inWords, prettyDate, prettyStamp } from '@/domain';
import { taxExplain, taxLabel } from '@/components/calc';
import { Callout, FileLink, Kv, Line, Note, Panel, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { todayIst } from '@/lib/time';
import { UserError } from '@/server/errors';
import { loadOwnApplication, type ApplicationDetail } from '@/server/participant/dashboard';

export const metadata = { title: 'Application · ESOP Exercise Portal' };

/** One of the participant's own applications, read-only, with the notice as signed. */
export default async function ApplicationPage({ params }: { params: Promise<{ appId: string }> }) {
  const { user } = await requireRole('Employee');
  const { appId } = await params;
  let detail: ApplicationDetail;
  try {
    detail = await loadOwnApplication(user.userId, decodeURIComponent(appId));
  } catch (e) {
    if (e instanceof UserError) {
      return (
        <div className="stack">
          <p className="small"><Link href="/employee">← Your dashboard</Link></p>
          <Callout kind="crit" title="Could not open it"><p>{e.message}</p></Callout>
        </div>
      );
    }
    throw e;
  }
  const a = detail.view;
  const tsrc = { method: a.taxMethod, breakdown: a.taxBreakdown, tax: a.taxAmount, perquisite: a.perquisiteAmount, flatRate: a.taxRatePercent };
  return (
    <div className="stack">
      <p className="small"><Link href="/employee">← Your dashboard</Link></p>
      <div className="spread">
        <div>
          <div className="eyebrow">{a.windowLabel}</div>
          <h1 className="title mono-title">{a.appId}</h1>
        </div>
        <StatusPill status={a.status} />
      </div>
      {a.editable && a.windowId === todayIst().slice(0, 7) ? <p><Link className="btn" href="/employee/apply">Continue this application</Link></p> : null}

      <Panel title="Summary">
        <div className="grid2">
          <Kv rows={[
            ['Status', a.status],
            ['Window', a.windowLabel],
            ['Options exercised', count(a.totalOptions)],
            ['Equity shares', count(a.totalShares)],
            ['Exercise amount', inr(a.exerciseAmount)],
            ['FMV applied', a.fmvValue ? inr2(a.fmvValue) + ' (' + (prettyDate(a.fmvDate) || '—') + ')' : 'not priced'],
            ['Perquisite value', inr(a.perquisiteAmount)],
            [taxLabel(tsrc), inr(a.taxAmount)],
            ['Tax route', a.tax.mode === 'FundPartner' ? 'Funded by ' + (a.tax.fundPartnerName || 'a partner') : a.tax.mode === 'Self' ? 'Paid directly' : '—'],
            ['Exercise payment UTR', a.exercisePayment.utr || '—'],
            ['Paid on', prettyDate(a.exercisePayment.date) || '—'],
            ['Shares allotted to', (a.demat.dpId || '—') + ' / ' + (a.demat.clientId || '—') + (a.demat.source ? ' (held with ' + a.demat.source + ')' : '')],
            ['Signed', a.notice.signedAt ? 'as ' + a.notice.signatureName + ' on ' + prettyStamp(a.notice.signedAt) : 'not signed'],
            ['Submitted', prettyStamp(a.submittedAt) || '—'],
            ['Approved', prettyStamp(a.approvedAt) || '—'],
          ]} />
          <Note title="Application summary" sub={a.windowLabel + ' · ' + a.appId}>
            <Line label="Options exercised" amount={count(a.totalOptions)} />
            <Line label="Exercise amount paid" amount={inr(a.exerciseAmount)} kind="out" />
            <Line label={'FMV, ' + (prettyDate(a.fmvDate) || '—')} amount={a.fmvValue ? inr2(a.fmvValue) : '—'} />
            <Line label="Perquisite value" amount={inr(a.perquisiteAmount)} />
            <Line label={taxLabel(tsrc)} amount={inr(a.taxAmount)} kind="out" explain={taxExplain(tsrc)} />
            <Line label="Total cash committed" amount={inr(a.exerciseAmount + a.taxAmount)} kind="total" />
            <Line label={inWords(a.exerciseAmount + a.taxAmount)} kind="words" />
          </Note>
        </div>
      </Panel>

      {a.lines.length ? (
        <Panel title="Grants exercised">
          <div className="tablewrap">
            <table className="data">
              <thead><tr><th scope="col">Grant</th><th scope="col">Plan</th><th scope="col" className="n">Options</th><th scope="col" className="n">Shares</th><th scope="col" className="n">Exercise amount</th><th scope="col" className="n">Perquisite</th></tr></thead>
              <tbody>
                {a.lines.map((l) => (
                  <tr key={l.grantId}>
                    <td className="mono">{l.grantId}</td><td>{l.planName}</td><td className="n">{count(l.options)}</td>
                    <td className="n">{count(l.shares)}</td><td className="n">{inr(l.lineExerciseAmount)}</td><td className="n">{inr(l.linePerquisite)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      <Panel title="Documents">
        <Kv rows={[
          ['CML', <FileLink key="c" file={a.demat.cml} />],
          ['PAN card', <FileLink key="p" file={a.demat.panCard} />],
          ['Exercise payment proof', <FileLink key="e" file={a.exercisePayment.proof} />],
          ...a.tax.payments.map((p): [string, ReactNode] => ['Tax payment ' + p.seq + ' (' + inr(p.amount) + ', ' + p.utr + ')', <FileLink key={p.paymentId} file={p.proof} />]),
          ['Signed exercise notice', <FileLink key="n" file={a.notice.pdf} />],
        ]} />
      </Panel>

      {detail.noticeHtml ? (
        <Panel title="Exercise notice" aside={a.notice.signedAt ? 'As signed' : 'Not signed'}>
          <div className="noticebox" dangerouslySetInnerHTML={{ __html: detail.noticeHtml }} />
        </Panel>
      ) : null}
    </div>
  );
}
