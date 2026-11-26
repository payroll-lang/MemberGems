import type { ReactNode } from 'react';
import Link from 'next/link';
import { count, inr, inr2, prettyDate, prettyStamp } from '@/domain';
import { exerciseExplain, fmvExplain, perquisiteExplain, sharesExplain, taxExplain, taxLabel } from '@/components/calc';
import { Callout, Figure, Kv, Panel, Pill, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import type { SectionKey } from '@/lib/schema';
import type { FileRef } from '@/server/core/view';
import { SECTION_KEYS } from '@/server/core/applications';
import { SECTION_DONE, SECTION_LABEL } from '@/server/admin/core/review';
import { openForReview } from '@/server/admin/review';
import { loadAdminDetail, type AdminDetail } from '@/server/admin/views';
import {
  approveAction, rejectAction, repriceAction, reviewSectionAction, sendBackAction, verifySectionsAction,
} from '../../actions';
import { ActionForm } from '../../_ui/ActionForm';
import { stamp } from '../../_ui/format';

export const metadata = { title: 'Application · ESOP team' };
export const maxDuration = 60;

const REVIEW_PILL: Record<string, 'ok' | 'wait' | 'bad'> = { Verified: 'ok', Pending: 'wait', 'Sent Back': 'bad' };

/** AdminApi.detail: one application in full, with the section review and the decisions. */
export default async function AdminApplicationPage({ params }: { params: Promise<{ appId: string }> }) {
  const { user } = await requireRole('Admin');
  const appId = decodeURIComponent((await params).appId);
  // Opening a Submitted application puts it Under Review (audited), as legacy did.
  try { await openForReview(user, appId); } catch (e) { console.error('openForReview ' + appId, e); }
  const d = await loadAdminDetail(appId);
  if (!d) {
    return (
      <div className="stack">
        <p className="small"><Link href="/admin" prefetch={false}>← Queue</Link></p>
        <Callout kind="crit" title="Not found"><p>There is no application {appId}.</p></Callout>
      </div>
    );
  }
  const a = d.view;
  const reviewable = a.status === 'Submitted' || a.status === 'Under Review';
  const closed = a.status === 'Approved' || a.status === 'Rejected';
  const hidden = <><input type="hidden" name="appId" value={a.appId} /><input type="hidden" name="rev" value={a.rev} /></>;
  const tsrc = { method: a.taxMethod, breakdown: a.taxBreakdown, tax: a.taxAmount, perquisite: a.perquisiteAmount, flatRate: a.taxRatePercent };
  const unverified = SECTION_KEYS.filter((k) => a.review[k] !== 'Verified');
  const canApprove = reviewable && !unverified.length && a.progress.complete;

  return (
    <div className="stack">
      <p className="small"><Link href="/admin" prefetch={false}>← Queue</Link></p>
      <div className="spread">
        <div>
          <div className="eyebrow">{a.windowLabel} · {a.employeeId}</div>
          <h1 className="title mono-title">{a.appId}</h1>
          <p className="lede">
            <Link href={'/admin/participants/' + encodeURIComponent(a.employeeId)} prefetch={false}>{a.employeeName || a.employeeId}</Link>
            {d.employee ? ' · ' + (d.employee.designation || '—') + ' · ' + d.employee.employmentStatus + (d.employee.separationDate ? ' (left ' + prettyDate(d.employee.separationDate) + ')' : '') + ' · ' + (d.employee.email || 'no email') : ''}
          </p>
        </div>
        <div className="stack" style={{ alignItems: 'flex-end', gap: 6 }}>
          <StatusPill status={a.status} />
          <span className="mini">rev {a.rev} · updated {stamp(a.updatedAt)}</span>
        </div>
      </div>

      {d.missingEmployee ? <Callout kind="crit" title="No participant record"><p>{a.employeeId} has no participant record, so grants, balances and the notice cannot be shown.</p></Callout> : null}
      {d.employee?.blocked ? <Callout kind="warn" title="Participant is blocked"><p>{d.employee.blockedReason || 'No reason recorded.'}</p></Callout> : null}
      {d.employee && !d.employee.enabled ? <Callout kind="warn" title="Not on the enabled list"><p>This participant is outside the enabled list, so the portal is closed to them.</p></Callout> : null}
      {a.status === 'Draft' || a.status === 'Sent Back' ? (
        <Callout kind="info" title="With the participant">
          <p>{a.status === 'Sent Back' ? 'Sent back for correction. ' : 'Not submitted yet. '}Nothing is reviewable until they submit.
            {a.progress.pendingLabels.length ? ' Still to finish: ' + a.progress.pendingLabels.join(', ') + '.' : ' Every section is complete; they have not submitted.'}</p>
        </Callout>
      ) : null}
      {a.tax.partnerRequest && a.tax.partnerRequest.status === 'Payment Fed' && !reviewable && !closed ? (
        <Callout kind="info" title="Partner paid · awaiting participant"><p>{a.tax.partnerRequest.partner} has recorded the tax payment; the participant has not submitted yet.</p></Callout>
      ) : null}

      <div className="figures">
        <Figure label="Options" value={count(a.totalOptions)} sub={count(a.totalShares) + ' shares'} explain={sharesExplain(a.lines.map((l) => ({ planName: l.planName, grantId: l.grantId, options: l.options, multiplier: l.multiplier, shares: l.shares })), a.totalShares)} />
        <Figure label="Exercise amount" value={inr(a.exerciseAmount)} sub={a.exercisePayment.utr ? 'paid, UTR ' + a.exercisePayment.utr : 'not paid'} explain={exerciseExplain(a.totalOptions, a.exercisePrice, a.exerciseAmount)} />
        <Figure label="FMV" value={a.fmvValue ? inr2(a.fmvValue) : '—'} sub={a.fmvDate ? prettyDate(a.fmvDate) : 'not fixed yet'}
          explain={a.fmvValue ? fmvExplain(d.fmvRow ? { date: d.fmvRow.date, fmv: a.fmvValue, open: d.fmvRow.open, close: d.fmvRow.close } : { date: a.fmvDate, fmv: a.fmvValue },
            'Fixed by the exercise payment date: the trading day before it.' + (d.fmvRow && d.fmvRow.fmv !== a.fmvValue ? ' The price on record for that day is now ' + inr2(d.fmvRow.fmv) + ' — use Reprice if it was corrected.' : '')) : undefined} />
        <Figure label="Perquisite" value={inr(a.perquisiteAmount)} explain={perquisiteExplain({ fmv: a.fmvValue, shares: a.totalShares, exerciseAmount: a.exerciseAmount, perquisite: a.perquisiteAmount })} />
        <Figure label={taxLabel(tsrc)} value={inr(a.taxAmount)} sub={(a.taxMethod || 'not priced') + (a.taxFrozenAt ? ' · frozen ' + prettyDate(a.taxFrozenAt) : '') + ' · due ' + (prettyDate(a.taxDueDate) || '—')} kind="warn" explain={taxExplain(tsrc, { admin: true })} />
        <Figure label="Tax paid" value={inr(a.tax.paidTotal)} sub={a.tax.remaining > 1 ? inr(a.tax.remaining) + ' outstanding' : 'settled'} kind={a.tax.remaining > 1 ? 'crit' : undefined} />
      </div>

      {!closed ? <Decisions d={d} hidden={hidden} reviewable={reviewable} canApprove={canApprove} unverified={unverified} /> : (
        <Callout kind={a.status === 'Approved' ? 'info' : 'warn'} title={a.status}>
          <p>{a.status === 'Approved' ? 'Approved ' + stamp(a.approvedAt) : 'Closed ' + stamp(a.review.reviewedAt)} by {a.review.reviewedBy || '—'}. No further decisions are possible.</p>
        </Callout>
      )}

      <Panel title="Section review" aside={(5 - unverified.length) + '/5 verified'}>
        {reviewable ? (
          <ActionForm action={verifySectionsAction}>
            {hidden}
            <input type="hidden" name="all" value="1" />
            <div className="row" style={{ marginTop: 0 }}>
              <button className="btn small" disabled={!unverified.length}>Verify all remaining sections</button>
              <span className="hint">Only sections the participant has completed are verified.</span>
            </div>
          </ActionForm>
        ) : null}
        {SECTION_KEYS.map((k) => (
          <SectionRow key={k} section={k} d={d} hidden={hidden} reviewable={reviewable} />
        ))}
        {reviewable && unverified.length > 1 ? (
          <ActionForm action={verifySectionsAction}>
            {hidden}
            <div className="checks">
              {unverified.map((k) => (
                <label key={k}><input type="checkbox" name="section" value={k} disabled={!a.progress.done[SECTION_DONE[k]]} /> {SECTION_LABEL[k]}</label>
              ))}
            </div>
            <div className="row"><button className="btn ghost small">Verify selected</button></div>
          </ActionForm>
        ) : null}
      </Panel>

      {a.lines.length ? (
        <Panel title="Grant lines">
          <div className="tablewrap">
            <table className="data compact">
              <thead><tr><th scope="col">Grant</th><th scope="col">Plan</th><th scope="col">Granted</th><th scope="col" className="n">Options</th><th scope="col" className="n">×</th><th scope="col" className="n">Shares</th><th scope="col" className="n">Price</th><th scope="col" className="n">Exercise amount</th><th scope="col" className="n">Perq./share</th><th scope="col" className="n">Perquisite</th></tr></thead>
              <tbody>
                {a.lines.map((l) => (
                  <tr key={l.grantId}>
                    <td className="mono">{l.grantId}</td><td>{l.planName}</td><td>{prettyDate(l.grantDate) || '—'}</td><td className="n">{count(l.options)}</td>
                    <td className="n">{l.multiplier}</td><td className="n">{count(l.shares)}</td><td className="n">{inr2(l.exercisePrice)}</td>
                    <td className="n">{inr(l.lineExerciseAmount)}</td><td className="n">{inr2(l.perquisitePerShare)}</td><td className="n">{inr(l.linePerquisite)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={3}>Total</td><td className="n">{count(a.totalOptions)}</td><td /><td className="n">{count(a.totalShares)}</td><td /><td className="n">{inr(a.exerciseAmount)}</td><td /><td className="n">{inr(a.perquisiteAmount)}</td></tr></tfoot>
            </table>
          </div>
        </Panel>
      ) : null}

      {d.grants.length ? (
        <Panel title="Participant’s grants" aside="balances excluding this application">
          <div className="tablewrap">
            <table className="data compact">
              <thead><tr><th scope="col">Grant</th><th scope="col">Plan</th><th scope="col">Status</th><th scope="col" className="n">Vested</th><th scope="col" className="n">Held elsewhere</th><th scope="col" className="n">Exercisable</th><th scope="col" className="n">Unvested</th><th scope="col">Next vest</th></tr></thead>
              <tbody>
                {d.grants.map((g) => (
                  <tr key={g.grantId}>
                    <td className="mono">{g.grantId}</td><td>{g.planName} ×{g.multiplier}</td><td>{g.grantStatus}</td><td className="n">{count(g.vestedOptions)}</td>
                    <td className="n">{count(g.pledgedElsewhere)}</td><td className="n">{count(g.exercisableOptions)}</td><td className="n">{count(g.unvestedOptions)}</td><td>{g.prettyNextVestDate || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">Report as on {prettyDate(d.grants[0].reportAsOn) || '—'}.</p>
        </Panel>
      ) : null}

      <Panel title="Documents" aside="each view is audited">
        <Docs files={[
          ['CML (client master)', a.demat.cml],
          ['PAN card', a.demat.panCard],
          ['Exercise payment proof', a.exercisePayment.proof],
          ...a.tax.payments.map((p): [string, FileRef | null] => ['Tax payment ' + p.seq + ' — ' + inr(p.amount) + ' · ' + p.utr, p.proof]),
          ...(a.tax.partnerRequest ? [['Partner’s tax payment proof', a.tax.partnerRequest.proof] as [string, FileRef | null]] : []),
          ['Signed exercise notice', a.notice.pdf],
        ]} />
      </Panel>

      {d.noticeHtml ? (
        <Panel title="Exercise notice" aside={a.notice.signedAt ? 'Signed ' + stamp(a.notice.signedAt) : 'Not signed'}>
          <div className="noticebox" dangerouslySetInnerHTML={{ __html: d.noticeHtml }} />
        </Panel>
      ) : null}

      <Panel title="Remarks">
        {a.review.remarks.length ? (
          <ul className="remarks">
            {a.review.remarks.map((r, i) => (
              <li key={i}><span className="mini">{stamp(r.at)} · {r.by}{r.section ? ' · ' + SECTION_LABEL[r.section] : ''}</span><br />{r.text}</li>
            ))}
          </ul>
        ) : <p className="empty">No remarks.</p>}
      </Panel>

      <Panel title="Audit trail" aside={d.trail.length + ' entries'}>
        {d.trail.length ? (
          <div className="tablewrap">
            <table className="data compact">
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Details</th></tr></thead>
              <tbody>
                {d.trail.map((t) => <tr key={t.id}><td className="mini nowrap">{stamp(t.at)}</td><td>{t.actor} <span className="mini">{t.role}</span></td><td className="mono">{t.action}</td><td>{t.details}</td></tr>)}
              </tbody>
            </table>
          </div>
        ) : <p className="empty">Nothing recorded.</p>}
      </Panel>
    </div>
  );
}

function Decisions({ d, hidden, reviewable, canApprove, unverified }: { d: AdminDetail; hidden: ReactNode; reviewable: boolean; canApprove: boolean; unverified: SectionKey[] }) {
  const a = d.view;
  return (
    <Panel title="Decision">
      <div className="grid2">
        <div className="stack">
          <ActionForm action={approveAction} confirm={'Approve ' + a.appId + '? The participant is emailed and the options are committed for allotment.'}>
            {hidden}
            <h3 className="sub">Approve</h3>
            {!reviewable ? <p className="hint">Only a submitted application can be approved.</p>
              : !canApprove ? <p className="hint">{unverified.length ? 'Verify every section first. Still unverified: ' + unverified.map((k) => SECTION_LABEL[k]).join(', ') + '.' : 'Incomplete: ' + a.progress.pendingLabels.join(', ') + '.'}</p> : null}
            <div className="field"><label htmlFor="apr">Remarks (optional, emailed)</label><textarea id="apr" name="remarks" rows={2} /></div>
            <button className="btn" disabled={!canApprove}>Approve</button>
          </ActionForm>
          <ActionForm action={repriceAction} confirm={'Reprice ' + a.appId + ' from the current masters? The new figures are audited and emailed to the participant.'}>
            {hidden}
            <h3 className="sub">Reprice</h3>
            <p className="hint">Submitted applications are frozen. This reworks the lines and tax from the current grant record, the price on record for {prettyDate(a.fmvDate) || 'the FMV date'}, the participant’s tax rate and the tax sheet.</p>
            <div className="field"><label htmlFor="rpr">Reason <span className="req">required</span></label><input id="rpr" type="text" name="reason" /></div>
            <button className="btn ghost">Reprice</button>
          </ActionForm>
        </div>
        <div className="stack">
          <ActionForm action={sendBackAction} confirm="Send this application back to the participant for correction? They are emailed your remarks.">
            {hidden}
            <h3 className="sub">Send back for correction</h3>
            {!reviewable ? <p className="hint">Only a submitted application can be sent back.</p> : null}
            <div className="checks">
              {SECTION_KEYS.map((k) => (
                <label key={k}><input type="checkbox" name="section" value={k} defaultChecked={a.review[k] === 'Sent Back'} /> {SECTION_LABEL[k]}</label>
              ))}
            </div>
            <div className="field" style={{ marginTop: 10 }}><label htmlFor="sbr">What needs correcting <span className="req">required</span></label><textarea id="sbr" name="remarks" rows={3} /></div>
            <button className="btn ghost" disabled={!reviewable}>Send back</button>
          </ActionForm>
          <ActionForm action={rejectAction} confirm={'Close ' + a.appId + ' without processing? This cannot be undone; the options are released and the participant is emailed.'}>
            {hidden}
            <h3 className="sub">Close without processing (reject)</h3>
            <div className="field"><label htmlFor="rjr">Why <span className="req">required</span></label><textarea id="rjr" name="remarks" rows={2} /></div>
            <button className="btn ghost">Reject</button>
          </ActionForm>
        </div>
      </div>
    </Panel>
  );
}

function SectionRow({ section, d, hidden, reviewable }: { section: SectionKey; d: AdminDetail; hidden: ReactNode; reviewable: boolean }) {
  const a = d.view;
  const state = a.review[section];
  const done = a.progress.done[SECTION_DONE[section]];
  const pr = a.tax.partnerRequest;
  const facts: [ReactNode, ReactNode][] = section === 'options' ? [
    ['Options → shares', count(a.totalOptions) + ' → ' + count(a.totalShares)],
    ['Grants', a.lines.map((l) => l.grantId + ' (' + count(l.options) + ')').join(', ') || '—'],
  ] : section === 'demat' ? [
    ['Applicant', [a.applicant.address, a.applicant.mobile, a.applicant.nationality, a.applicant.designation].filter(Boolean).join(' · ') || '—'],
    ['PAN', a.applicant.pan || '—'],
    ['Demat', [a.demat.accountType, a.demat.dpName, a.demat.dpId, a.demat.clientId, a.demat.accountName].filter(Boolean).join(' · ') || '—'],
    ...(a.demat.source ? [['Account held with', a.demat.source] as [ReactNode, ReactNode]] : []),
  ] : section === 'exercisePayment' ? [
    ['UTR', a.exercisePayment.utr || '—'],
    ['Paid', (prettyDate(a.exercisePayment.date) || '—') + ' · ' + inr(a.exercisePayment.amount) + ' of ' + inr(a.exerciseAmount) + (a.exercisePayment.bank ? ' · ' + a.exercisePayment.bank : '')],
  ] : section === 'taxPayment' ? [
    ['Route', a.tax.mode === 'FundPartner' ? 'Fund partner: ' + (a.tax.fundPartnerName || '—') : a.tax.mode === 'Self' ? 'Paid directly' : 'not chosen'],
    ['Paid', inr(a.tax.paidTotal) + ' of ' + inr(a.tax.due) + ' (' + a.tax.payments.length + ' payment' + (a.tax.payments.length === 1 ? '' : 's') + ')'],
    ...a.tax.payments.map((p): [ReactNode, ReactNode] => ['  #' + p.seq, p.utr + ' · ' + prettyDate(p.date) + ' · ' + inr(p.amount) + ' · ' + p.paidBy + (p.fundPartnerName ? ' (' + p.fundPartnerName + ')' : '')]),
    ...(pr ? [['Partner request', <span key="pr"><StatusPill status={pr.status} /> {pr.partner} · {inr(pr.amount)}{pr.utr ? ' · UTR ' + pr.utr + ' on ' + prettyDate(pr.date) + ' · ' + inr(pr.paidAmount) : ''}{pr.remarks ? ' — ' + pr.remarks : ''}</span>] as [ReactNode, ReactNode]] : []),
  ] : [
    ['Signed', a.notice.signedAt ? 'as “' + a.notice.signatureName + '” at ' + a.notice.place + ', ' + prettyStamp(a.notice.signedAt) : 'not signed'],
    ['PDF', a.notice.pdf ? 'on file' : a.notice.signedAt ? 'not generated yet' : '—'],
  ];
  return (
    <div className="reviewrow">
      <div>
        <b>{SECTION_LABEL[section]}</b><br />
        <Pill kind={REVIEW_PILL[state] ?? 'wait'}>{state}</Pill>{' '}
        {done ? <span className="mini">complete</span> : <span className="mini err-text">not completed</span>}
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <Kv rows={facts} />
        {reviewable ? (
          <ActionForm action={reviewSectionAction}>
            {hidden}
            <input type="hidden" name="section" value={section} />
            <div className="field" style={{ margin: 0 }}>
              <label className="sr-only" htmlFor={'rm-' + section}>Remarks on {SECTION_LABEL[section]}</label>
              <textarea id={'rm-' + section} name="remarks" rows={1} placeholder="Remarks (required to send back; the participant sees them)" />
            </div>
            <div className="acts" style={{ marginTop: 6 }}>
              {state !== 'Verified' ? <button className="btn small" name="verdict" value="Verified" disabled={!done}>Verify</button> : null}
              <button className="btn ghost small" name="verdict" value="Sent Back" disabled={!done}>Mark for correction</button>
              {state !== 'Pending' ? <button className="btn ghost small" name="verdict" value="Pending">Reopen</button> : null}
            </div>
            {section === 'taxPayment' && a.tax.mode === 'FundPartner' ? <p className="hint">Verifying or marking this section also updates {a.tax.fundPartnerName || 'the partner'}’s request.</p> : null}
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}

function Docs({ files }: { files: [string, FileRef | null][] }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      {files.map(([label, f], i) => (
        <div key={i}>
          {!f ? <><b>{label}</b> <Pill kind="wait">Not uploaded</Pill></> : (
            <details>
              <summary><b>{label}</b> — {f.name} <span className="mini">({f.sizeKb} KB, {stamp(f.uploadedAt)})</span>{' '}
                <a href={'/api/files/' + encodeURIComponent(f.fileId) + '?inline=1'} target="_blank" rel="noopener noreferrer">open in a new tab</a>
              </summary>
              <div className="docview">
                {f.contentType.startsWith('image/')
                  // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL; next/image cannot optimise it
                  ? <img src={'/api/files/' + encodeURIComponent(f.fileId) + '?inline=1'} alt={label} loading="lazy" />
                  : <iframe src={'/api/files/' + encodeURIComponent(f.fileId) + '?inline=1'} title={label} loading="lazy" />}
              </div>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

