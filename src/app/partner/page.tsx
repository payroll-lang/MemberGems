import Link from 'next/link';
import { count, inr, inWords } from '@/domain';
import { Callout, Figure, Panel, Pill, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { UserError } from '@/server/errors';
import { loadPartnerDashboard, type PartnerDashboard } from '@/server/partner/dashboard';

export const metadata = { title: 'Fund partner · ESOP Exercise Portal' };

export default async function PartnerHome() {
  const { user } = await requireRole('FundPartner');
  let d: PartnerDashboard;
  try {
    d = await loadPartnerDashboard(user);
  } catch (e) {
    if (e instanceof UserError) return <Callout kind="crit" title="Your requests are not available"><p>{e.message}</p></Callout>;
    throw e;
  }
  const s = d.summary;
  const open = d.rows.filter((r) => r.editable);

  return (
    <div className="stack">
      <div>
        <div className="eyebrow">Fund partner</div>
        <h1 className="title">{d.partnerName}</h1>
        <p className="lede">
          Employees who have asked you to fund the tax on their ESOP exercise. For each one you record <b>the demat
          account they hold with you</b> — the shares are allotted there — and then the tax payment itself.
        </p>
      </div>

      <div className="figures">
        <Figure label="Awaiting payment" value={count(s.awaitingPayment)} kind={s.overdue ? 'crit' : undefined}
          sub={s.overdue ? count(s.overdue) + ' past the due date' : 'none overdue'} />
        <Figure label="Amount to pay" value={inr(s.awaitingAmount)} kind="accent" sub="across open requests" explain={{
          title: 'Amount to pay',
          formula: 'the sum of the tax on every request still awaiting payment',
          steps: [...open.map((r): [string, string] => [r.employeeName + ' · ' + r.appId, inr(r.taxAmount)]),
            ['Total to pay', inr(s.awaitingAmount), 'total']],
          result: inr(s.awaitingAmount),
          resultWords: inWords(s.awaitingAmount),
          notes: ['Each request is paid separately, against its own UTR — this total is for your funding position, not a single transfer.'],
        }} />
        <Figure label="Fed, not yet verified" value={count(s.fedNotVerified)} sub="with the ESOP team" />
        <Figure label="Verified" value={count(s.verified)} sub="completed" />
      </div>

      {d.bankDetails ? (
        <Callout kind="info" title="Where to transfer">
          <div className="bankbox">{d.bankDetails}</div>
        </Callout>
      ) : null}

      <Panel title="Requests">
        {d.rows.length ? (
          <div className="tablewrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Request</th><th scope="col">Employee</th><th scope="col" className="n">Options</th>
                  <th scope="col" className="n">Shares</th><th scope="col">Demat for allotment</th>
                  <th scope="col" className="n">Perquisite</th><th scope="col" className="n">Tax to pay</th>
                  <th scope="col">Due</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.requestId}>
                    <td className="mono">{r.requestId}<br /><span className="tag">{r.appId}</span></td>
                    <td>{r.employeeName || '—'}<br /><span className="tag">{r.employeeId}</span></td>
                    <td className="n">{count(r.totalOptions)}</td>
                    <td className="n">{count(r.totalShares)}</td>
                    <td>{r.demat.complete ? <span className="mono small">{r.demat.dpId} / {r.demat.clientId}</span> : <Pill kind="bad">Needed</Pill>}</td>
                    <td className="n">{inr(r.perquisiteAmount)}</td>
                    <td className="n"><b>{inr(r.taxAmount)}</b></td>
                    <td className="nowrap">{r.prettyTaxDueDate || '—'}{r.overdue ? <><br /><Pill kind="bad">Overdue</Pill></> : null}</td>
                    <td><StatusPill status={r.status} />{r.payment.utr ? <><br /><span className="tag">UTR {r.payment.utr}</span></> : null}</td>
                    <td>
                      <Link className={'btn small' + (r.editable ? '' : ' ghost')} href={'/partner/requests/' + encodeURIComponent(r.requestId)}>
                        {r.editable ? 'Enter payment' : 'View'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">No requests have been routed to you yet.</div>}
      </Panel>
    </div>
  );
}
