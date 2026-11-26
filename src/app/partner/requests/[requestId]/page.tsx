import Link from 'next/link';
import { notFound } from 'next/navigation';
import { count, inr, inr2, inWords } from '@/domain';
import { Callout, FileLink, Kv, Panel, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { UserError } from '@/server/errors';
import { loadPartnerDashboard, type PartnerDashboard } from '@/server/partner/dashboard';
import { DeclineForm, RequestForm } from './forms';

export const metadata = { title: 'Fund partner request · ESOP Exercise Portal' };

export default async function PartnerRequestPage({ params }: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await params;
  const { user } = await requireRole('FundPartner');
  let d: PartnerDashboard;
  try {
    d = await loadPartnerDashboard(user);
  } catch (e) {
    if (e instanceof UserError) return <Callout kind="crit" title="This request is not available"><p>{e.message}</p></Callout>;
    throw e;
  }
  const r = d.rows.find((x) => x.requestId === decodeURIComponent(requestId));
  if (!r) notFound();

  return (
    <div className="stack">
      <div>
        <p className="small"><Link href="/partner">← All requests</Link></p>
        <div className="eyebrow">{r.requestId} · {r.appId}</div>
        <h1 className="title">{r.editable ? 'Enter payment details' : 'Payment details'}</h1>
        <p className="lede">{r.employeeName} ({r.employeeId}) · <StatusPill status={r.status} />{r.overdue ? ' · past the due date' : ''}</p>
      </div>

      <Panel title="The request">
        <Kv rows={[
          ['Employee', <>{r.employeeName} <span className="dim">({r.employeeId})</span></>],
          ['Contact', <>{r.employeeEmail || '—'}{r.employeeMobile ? ' · ' + r.employeeMobile : ''}</>],
          ['PAN', <span key="pan" className="mono">{r.pan || '—'}</span>],
          ['Options exercised', count(r.totalOptions)],
          ['Equity shares to allot', count(r.totalShares)],
          ['Exercise amount', inr(r.exerciseAmount)],
          ['FMV applied', r.fmvValue ? inr2(r.fmvValue) + (r.prettyFmvDate ? ' (' + r.prettyFmvDate + ')' : '') : '—'],
          ['Perquisite value', inr(r.perquisiteAmount)],
          ['Tax to be paid', <><b>{inr(r.taxAmount)}</b><br /><span className="words">{inWords(r.taxAmount)}</span></>],
          ['Due by', r.prettyTaxDueDate || '—'],
          ['Assigned', r.assignedAt || '—'],
        ]} />
        <p className="hint">Pay this in <b>one</b> transfer. Part payments are not accepted on a fund partner request — the ESOP team
          verifies a single UTR against this exact amount.</p>
        {r.remarks ? <div className="remarks">{r.remarks}</div> : null}
      </Panel>

      {d.bankDetails ? <Callout kind="info" title="Where to transfer"><div className="bankbox">{d.bankDetails}</div></Callout> : null}

      <Panel title="The demat account and the payment">
        <p className="lede">The {count(r.totalShares)} equity shares from this exercise are credited to the account the employee holds
          with you. Enter it here — the ESOP team needs it before allotment, and the employee is emailed a copy to check.</p>
        {r.demat.complete ? (
          <Callout kind="info" title="Recorded">
            <p>{r.demat.accountType} · <b>{r.demat.dpId} / {r.demat.clientId}</b>{r.demat.accountName ? ' · ' + r.demat.accountName : ''}</p>
            <p className="dim small">Set by {r.demat.providedBy || '—'} on {r.demat.providedAt || '—'}. {r.editable
              ? 'It can still be corrected below until the payment is recorded.'
              : 'It is now locked. Contact the ESOP team if it needs correcting.'}</p>
          </Callout>
        ) : null}
        {r.mismatch ? (
          <Callout kind="warn" title="This differs from what the employee entered">
            <p>They gave {r.ownDemat.dpId} / {r.ownDemat.clientId} earlier in their application. Yours is the account that will be used,
              since the shares are held with you — but it is worth confirming with them that this is deliberate.</p>
          </Callout>
        ) : null}

        {r.editable ? (
          <>
            <RequestForm
              requestId={r.requestId} appId={r.appId} partnerName={d.partnerName} employeeName={r.employeeName}
              taxAmount={r.taxAmount} today={d.today}
              demat={{ accountType: r.demat.accountType, dpName: r.demat.dpName, accountName: r.demat.accountName, dpId: r.demat.dpId,
                clientId: r.demat.clientId, cml: r.demat.cml, set: r.demat.complete }}
              payment={{ utr: r.payment.utr, date: r.payment.date, amount: r.payment.amount, bank: r.payment.bank, proof: r.payment.proof }}
            />
            <div className="divider" />
            <DeclineForm requestId={r.requestId} summary={r.employeeName + ' (' + r.employeeId + ') · ' + r.appId + ' · tax ' + inr(r.taxAmount)} />
          </>
        ) : (
          <>
            <Kv rows={[
              ['Demat account', r.demat.dpId ? r.demat.accountType + ' ' + r.demat.dpId + ' / ' + r.demat.clientId : '—'],
              ['CML', <FileLink key="cml" file={r.demat.cml} />],
              ['UTR', <span key="utr" className="mono">{r.payment.utr || '—'}</span>],
              ['Payment date', r.payment.prettyDate || '—'],
              ['Amount', r.payment.amount ? inr(r.payment.amount) : '—'],
              ['Bank', r.payment.bank || '—'],
              ['Payment proof', <FileLink key="proof" file={r.payment.proof} />],
            ]} />
            <Callout kind="info" title={r.status}>
              <p>{r.fedBy ? 'Fed by ' + r.fedBy + ' on ' + (r.fedAt || '—') + '.' : 'Nothing further can be entered on this request.'}</p>
            </Callout>
          </>
        )}
      </Panel>
    </div>
  );
}
