import { Callout, Panel, Pill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { loadLogins } from '@/server/admin/logins';
import { emailSwitches } from '@/server/admin/views';
import { listPartners } from '@/server/partners';
import { loadSettings } from '@/server/settings';
import { createLoginAction, newCodeAction, setUserStatusAction } from '../actions';
import { ActionForm } from '../_ui/ActionForm';
import { sp, stamp } from '../_ui/format';
import { BulkLogins } from './BulkLogins';

export const metadata = { title: 'Logins · ESOP team' };
export const maxDuration = 300;

export default async function LoginsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user } = await requireRole('Admin');
  const p = await searchParams;
  const q = sp(p.user).trim().toLowerCase();
  const [rows, partners, settings] = await Promise.all([loadLogins(), listPartners(), loadSettings()]);
  const sw = emailSwitches(settings.config);
  const shown = q ? rows.filter((r) => r.userId.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.loginEmails.some((e) => e.includes(q))) : rows;
  const byRole = (role: string) => rows.filter((r) => r.role === role).length;
  return (
    <div className="stack">
      <div><div className="eyebrow">Access</div><h1 className="title">Logins</h1>
        <p className="lede">{byRole('Employee')} participant, {byRole('Admin')} ESOP team and {byRole('FundPartner')} fund-partner logins. A new login gets a one-time code; with it the person sets their own password.</p></div>
      {!sw.emails ? <Callout kind="warn" title="Emails are off"><p>EMAILS_ENABLED is off, so codes are never emailed — they are shown here instead.</p></Callout> : null}

      <div className="grid2">
        <Panel title="Create a login">
          <ActionForm action={createLoginAction}>
            <div className="row2">
              <div className="field"><label htmlFor="cu">User ID</label><input id="cu" type="text" name="userId" placeholder="Employee code, or e.g. ESOP-ANITA" /></div>
              <div className="field"><label htmlFor="cr">Role</label>
                <select id="cr" name="role" defaultValue="Employee"><option value="Employee">Employee (participant)</option><option value="Admin">Admin (ESOP team)</option><option value="FundPartner">Fund partner</option></select></div>
              <div className="field"><label htmlFor="cn">Name</label><input id="cn" type="text" name="name" placeholder="From the record if blank" /></div>
              <div className="field"><label htmlFor="ce">Email</label><input id="ce" type="email" name="email" placeholder="From the record if blank" /></div>
              <div className="field"><label htmlFor="cp">Fund partner (partner logins)</label>
                <select id="cp" name="partnerId" defaultValue=""><option value="">—</option>{partners.map((x) => <option key={x.partnerId} value={x.partnerId}>{x.name}{x.status !== 'Active' ? ' (retired)' : ''}</option>)}</select></div>
            </div>
            <div className="checkline"><input id="cs" type="checkbox" name="sendEmail" value="1" defaultChecked={sw.inviteAuto} /><label htmlFor="cs">Email the one-time code (otherwise it is shown here once)</label></div>
            <div className="row"><button className="btn">Create login</button></div>
          </ActionForm>
        </Panel>
        <Panel title="Bulk: participants without a login">
          <p className="hint">Everyone with something exercisable who is not blocked, is on the enabled list (if one is set) and has an email. Codes not emailed are listed once at the end, with their 30-minute expiry — or people can use “Set or reset password” on the sign-in screen themselves.</p>
          <BulkLogins bulkEmails={sw.bulk} />
        </Panel>
      </div>

      <Panel title="All logins" aside={shown.length + ' shown'}>
        <form className="filters" method="get" action="/admin/logins">
          <div className="field"><label htmlFor="lq">Find</label><input id="lq" type="text" name="user" defaultValue={sp(p.user)} placeholder="User ID, name or email" /></div>
          <button className="btn ghost small">Find</button>
        </form>
        <div className="tablewrap">
          <table className="data compact">
            <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Sign-in addresses</th><th scope="col">Status</th><th scope="col">Password</th><th scope="col">Last sign-in</th><th scope="col">Actions</th></tr></thead>
            <tbody>{shown.slice(0, 500).map((r) => (
              <tr key={r.userId} className={r.status !== 'Active' ? 'dim' : undefined}>
                <td className="mono">{r.userId}<br /><span className="tag">{r.name}</span></td>
                <td>{r.role}{r.fundPartnerName ? <><br /><span className="tag">{r.fundPartnerName}</span></> : null}</td>
                <td className="mini">{r.loginEmails.join(', ') || '—'}</td>
                <td><Pill kind={r.status === 'Active' ? 'ok' : 'neutral'}>{r.status}</Pill>{r.locked ? <><br /><Pill kind="bad">Locked</Pill></> : null}</td>
                <td className="mini">{r.hasPassword ? (r.mustResetPassword ? 'set · must reset' : 'set') : 'not set'}</td>
                <td className="mini">{r.lastLoginAt ? stamp(r.lastLoginAt) : 'never'}</td>
                <td>
                  <ActionForm action={newCodeAction} confirm={'Issue a new code for ' + r.userId + '? Their current password stops working and every session they have ends.'}>
                    <input type="hidden" name="userId" value={r.userId} />
                    <div className="acts">
                      <button className="btn ghost small" name="sendEmail" value="1">New code — email it</button>
                      <button className="btn ghost small" name="sendEmail" value="0">New code — show me</button>
                    </div>
                  </ActionForm>
                  {r.userId !== user.userId ? (
                    <ActionForm action={setUserStatusAction} confirm={(r.status === 'Active' ? 'Disable ' : 'Enable ') + r.userId + '?'}>
                      <input type="hidden" name="userId" value={r.userId} />
                      <input type="hidden" name="status" value={r.status === 'Active' ? 'Disabled' : 'Active'} />
                      <button className="btn link small">{r.status === 'Active' ? 'Disable' : 'Enable'}</button>
                    </ActionForm>
                  ) : <span className="mini">you</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {shown.length > 500 ? <p className="hint">Showing the first 500 — use Find to narrow.</p> : null}
      </Panel>
    </div>
  );
}
