import Link from 'next/link';
import { count, inr, prettyDate } from '@/domain';
import { Callout, Kv, Panel, Pill, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import type { EmployeeDoc } from '@/lib/schema';
import { blankEmployee } from '@/server/admin/core/grantReport';
import { loadParticipant, type ParticipantDetail } from '@/server/admin/participants';
import { saveEmployeeAction, setBlockedAction } from '../../actions';
import { ActionForm } from '../../_ui/ActionForm';
import { stamp } from '../../_ui/format';

export const metadata = { title: 'Participant · ESOP team' };
export const maxDuration = 120;

function Field({ name, label, value, type = 'text', hint, wide }: { name: string; label: string; value: string | number | null; type?: string; hint?: string; wide?: boolean }) {
  return (
    <div className="field" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label htmlFor={'f-' + name}>{label}</label>
      <input id={'f-' + name} name={name} type={type} defaultValue={value ?? ''} />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/** AdminApi.saveEmployee / setBlocked: one participant's record. `/admin/participants/new` adds one. */
export default async function ParticipantPage({ params }: { params: Promise<{ employeeId: string }> }) {
  await requireRole('Admin');
  const raw = decodeURIComponent((await params).employeeId);
  const isNew = raw.toLowerCase() === 'new';
  const detail: ParticipantDetail | null = isNew ? null : await loadParticipant(raw);
  if (!isNew && !detail) {
    return <div className="stack"><p className="small"><Link href="/admin/participants" prefetch={false}>← Participants</Link></p><Callout kind="crit" title="Not found"><p>No participant record for {raw}.</p></Callout></div>;
  }
  const e: EmployeeDoc = detail?.employee ?? blankEmployee('', '');
  return (
    <div className="stack">
      <p className="small"><Link href="/admin/participants" prefetch={false}>← Participants</Link></p>
      <div>
        <div className="eyebrow">{isNew ? 'New participant' : e.employeeId}</div>
        <h1 className="title">{isNew ? 'Add a participant' : e.name || e.employeeId}</h1>
        {!isNew ? <p className="lede">{e.designation || '—'} · {e.employmentStatus || 'Active'}{e.blocked ? ' · ' : ''}{e.blocked ? <Pill kind="bad">Blocked</Pill> : null}</p> : null}
      </div>
      {isNew ? <Callout kind="info" title="Normally created by the grant sync"><p>Add one by hand only for someone not yet on the vesting report; the next sync brings their identity fields into line with the report.</p></Callout> : null}

      <Panel title="Record">
        <ActionForm action={saveEmployeeAction}>
          <input type="hidden" name="isNew" value={isNew ? '1' : '0'} />
          {!isNew ? <input type="hidden" name="employeeId" value={e.employeeId} /> : null}
          <div className="row2">
            {isNew ? <Field name="employeeId" label="Employee ID" value="" /> : null}
            <Field name="name" label="Name" value={e.name} hint={isNew ? undefined : 'From the vesting report; the next sync overwrites it.'} />
            <Field name="designation" label="Designation" value={e.designation} />
            <Field name="employmentStatus" label="Employment status" value={e.employmentStatus} />
            <Field name="separationDate" label="Separation date" type="date" value={e.separationDate} />
            <Field name="emailOverride" label="Email override" type="email" value={e.emailOverride} hint={'Used instead of the report’s addresses (' + ([e.accessEmail, e.secondaryEmail].filter(Boolean).join(', ') || 'none on record') + '). Also becomes a sign-in address.'} />
            <Field name="mobile" label="Mobile" value={e.mobile} />
            <Field name="nationality" label="Nationality" value={e.nationality} />
            <Field name="pan" label="PAN" value={e.pan} />
            <Field name="address" label="Address" value={e.address} wide />
            <Field name="ctc" label="CTC (₹)" type="number" value={e.ctc} hint="Blank leaves it as it is." />
            <Field name="taxRatePercent" label="Flat tax rate (%)" type="number" value={e.taxRatePercent} hint="0–60. Used when the tax sheet cannot price them. Changing it reprices their draft applications." />
          </div>
          <h3 className="sub">Demat account (prefill)</h3>
          <div className="row2">
            <div className="field">
              <label htmlFor="f-accountType">Account type</label>
              <select id="f-accountType" name="accountType" defaultValue={e.demat.accountType}><option value="">—</option><option>NSDL</option><option>CDSL</option></select>
            </div>
            <Field name="dpName" label="Depository participant" value={e.demat.dpName} />
            <Field name="dpId" label="DP ID" value={e.demat.dpId} />
            <Field name="clientId" label="Client ID" value={e.demat.clientId} />
            <Field name="accountName" label="Account holder name" value={e.demat.accountName} />
          </div>
          <div className="field"><label htmlFor="f-remarks">Remarks (internal)</label><textarea id="f-remarks" name="remarks" rows={2} defaultValue={e.remarks} /></div>
          <button className="btn">{isNew ? 'Add participant' : 'Save'}</button>
        </ActionForm>
      </Panel>

      {detail ? (
        <>
          <Panel title={e.blocked ? 'Blocked' : 'Block'}>
            {e.blocked ? <p>Blocked {stamp(e.blockedAt)} by {e.blockedBy || '—'}: “{e.blockedReason}”. They cannot sign in or act.</p>
              : <p className="hint">A blocked participant keeps their record, grants and history, and cannot sign in or act. A sync never changes this. They are shown the reason.</p>}
            <ActionForm action={setBlockedAction} confirm={e.blocked ? 'Unblock ' + e.employeeId + '?' : 'Block ' + e.employeeId + '? Their sessions end.'}>
              <input type="hidden" name="employeeId" value={e.employeeId} />
              <input type="hidden" name="blocked" value={e.blocked ? '0' : '1'} />
              {!e.blocked ? <div className="field"><label htmlFor="br">Reason <span className="req">required</span></label><input id="br" type="text" name="reason" /></div> : null}
              <button className="btn ghost">{e.blocked ? 'Unblock' : 'Block'}</button>
            </ActionForm>
          </Panel>

          <Panel title="Login">
            {detail.login ? <Kv rows={[
              ['User ID', detail.login.userId], ['Status', detail.login.status], ['Sign-in addresses', detail.login.loginEmails.join(', ') || '—'],
              ['Notifications to', detail.login.notifyEmail || '—'], ['Last sign-in', stamp(detail.login.lastLoginAt ?? '')],
              ['Password', detail.login.mustResetPassword ? 'not set yet / must reset' : 'set'],
            ]} /> : <p>No login yet.</p>}
            <p><Link href={'/admin/logins?user=' + encodeURIComponent(e.employeeId)} prefetch={false}>Manage on the Logins screen →</Link></p>
          </Panel>

          <Panel title="Tax basis">
            {detail.taxPosition ? <Kv rows={[
              ['Tax sheet', detail.taxPosition.regime + ' regime · net taxable ' + inr(detail.taxPosition.netTaxable) + ' · as on ' + (prettyDate(detail.taxPosition.asOn) || '—')],
              ['Flags', detail.taxPosition.flags || 'none'],
              ['Flat rate', e.taxRatePercent === null ? '—' : e.taxRatePercent + '%'],
            ]} /> : <p>No tax-sheet row. Flat rate: {e.taxRatePercent === null ? 'none' : e.taxRatePercent + '%'}.</p>}
          </Panel>

          <Panel title="Grants" aside={detail.grants.length ? 'report as on ' + (prettyDate(detail.grants[0].reportAsOn) || '—') : undefined}>
            {detail.grants.length ? (
              <div className="tablewrap">
                <table className="data compact">
                  <thead><tr><th scope="col">Grant</th><th scope="col">Plan</th><th scope="col">Granted on</th><th scope="col">Status</th><th scope="col" className="n">Vested</th><th scope="col" className="n">In applications</th><th scope="col" className="n">Exercisable</th><th scope="col" className="n">Unvested</th><th scope="col">Next vest</th></tr></thead>
                  <tbody>{detail.grants.map((g) => (
                    <tr key={g.grantId}><td className="mono">{g.grantId}</td><td>{g.planName} ×{g.multiplier}</td><td>{g.prettyGrantDate}</td><td>{g.grantStatus}</td>
                      <td className="n">{count(g.vestedOptions)}</td><td className="n">{count(g.pledgedElsewhere)}</td><td className="n">{count(g.exercisableOptions)}</td><td className="n">{count(g.unvestedOptions)}</td><td>{g.prettyNextVestDate || '—'}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p className="empty">No grants on record.</p>}
          </Panel>

          <Panel title="Applications">
            {detail.applications.length ? (
              <div className="tablewrap">
                <table className="data compact">
                  <thead><tr><th scope="col">Reference</th><th scope="col">Window</th><th scope="col">Status</th><th scope="col" className="n">Options</th><th scope="col" className="n">Tax</th><th scope="col">Updated</th></tr></thead>
                  <tbody>{detail.applications.map((a) => (
                    <tr key={a.appId}><td className="mono"><a href={'/admin/applications/' + encodeURIComponent(a.appId)}>{a.appId}</a></td><td>{a.windowId}</td><td><StatusPill status={a.status} /></td>
                      <td className="n">{count(a.totalOptions)}</td><td className="n">{inr(a.taxAmount)}</td><td className="mini">{stamp(a.updatedAt)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            ) : <p className="empty">None.</p>}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
