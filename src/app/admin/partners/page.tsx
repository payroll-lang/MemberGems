import { Callout, Panel, Pill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { loadPartners } from '@/server/admin/partners';
import { emailSwitches } from '@/server/admin/views';
import { loadSettings } from '@/server/settings';
import { partnerLoginAction, partnerStatusAction, savePartnerAction } from '../actions';
import { ActionForm } from '../_ui/ActionForm';
import { stamp } from '../_ui/format';

export const metadata = { title: 'Fund partners · ESOP team' };

/** Partners.gs: never deleted, only retired; the name never changes once created. */
export default async function PartnersPage() {
  await requireRole('Admin');
  const [rows, settings] = await Promise.all([loadPartners(), loadSettings()]);
  const sw = emailSwitches(settings.config);
  return (
    <div className="stack">
      <div><div className="eyebrow">Access</div><h1 className="title">Fund partners</h1>
        <p className="lede">Partners who pay the tax (and may supply the demat account) for participants. A partner can be chosen only while active and with at least one active login.</p></div>

      {rows.map((p) => (
        <Panel key={p.partnerId} title={p.name} aside={p.partnerId}>
          <div className="row" style={{ marginTop: 0 }}>
            <Pill kind={p.status === 'Active' ? 'ok' : 'neutral'}>{p.status}</Pill>
            {p.selectable ? <Pill kind="ok">Selectable by participants</Pill> : <Pill kind="wait">{p.status !== 'Active' ? 'Retired' : 'Not selectable — needs an active login'}</Pill>}
            <span className="mini">{p.openRequests} open request(s){p.openAppIds.length ? ': ' + p.openAppIds.join(', ') : ''} · {p.totalRequests} ever · updated {stamp(p.updatedAt)} by {p.updatedBy || '—'}</span>
          </div>
          <div className="grid2">
            <ActionForm action={savePartnerAction}>
              <input type="hidden" name="partnerId" value={p.partnerId} />
              <div className="field"><label htmlFor={'ce' + p.partnerId}>Contact emails (told about every request)</label><input id={'ce' + p.partnerId} type="text" name="contactEmails" defaultValue={p.contactEmails.join(', ')} /></div>
              <div className="field"><label htmlFor={'no' + p.partnerId}>Notes</label><textarea id={'no' + p.partnerId} name="notes" rows={2} defaultValue={p.notes} /></div>
              <button className="btn small">Save contacts</button>
            </ActionForm>
            <div className="stack" style={{ gap: 10 }}>
              <div>
                <b>Logins</b>
                {p.logins.length ? <ul className="remarks">{p.logins.map((l) => <li key={l.userId}><span className="mono">{l.userId}</span> · {l.email} · {l.status} · last sign-in {l.lastLoginAt ? stamp(l.lastLoginAt) : 'never'}</li>)}</ul> : <p className="hint">None yet.</p>}
              </div>
              <ActionForm action={partnerLoginAction}>
                <input type="hidden" name="partnerId" value={p.partnerId} />
                <div className="field"><label htmlFor={'le' + p.partnerId}>Login email</label><input id={'le' + p.partnerId} type="email" name="email" placeholder={p.contactEmails[0] ?? 'contact address'} /></div>
                <div className="checkline"><input id={'ls' + p.partnerId} type="checkbox" name="sendEmail" value="1" defaultChecked /><label htmlFor={'ls' + p.partnerId}>Email the one-time code</label></div>
                <div className="row"><button className="btn ghost small">Create or reset a partner login</button></div>
              </ActionForm>
              <ActionForm action={partnerStatusAction} confirm={p.status === 'Active' ? 'Retire ' + p.name + '? No new application can choose them.' : 'Reinstate ' + p.name + '?'}>
                <input type="hidden" name="partnerId" value={p.partnerId} />
                <input type="hidden" name="status" value={p.status === 'Active' ? 'Retired' : 'Active'} />
                <button className="btn ghost small">{p.status === 'Active' ? 'Retire' : 'Reinstate'}</button>
              </ActionForm>
            </div>
          </div>
        </Panel>
      ))}
      {!rows.length ? <Callout kind="warn" title="No fund partners"><p>Participants can only pay the tax themselves until a partner is added.</p></Callout> : null}

      <Panel title="Add a fund partner">
        <ActionForm action={savePartnerAction}>
          <div className="row2">
            <div className="field"><label htmlFor="np">Name (cannot be changed later)</label><input id="np" type="text" name="name" /></div>
            <div className="field"><label htmlFor="nc">Contact emails</label><input id="nc" type="text" name="contactEmails" placeholder="ops@partner.com, rm@partner.com" /></div>
          </div>
          <div className="field"><label htmlFor="nn">Notes</label><textarea id="nn" name="notes" rows={2} /></div>
          <div className="checkline"><input id="nl" type="checkbox" name="createLogin" value="1" defaultChecked /><label htmlFor="nl">Create their portal login with the first contact address</label></div>
          <div className="checkline"><input id="ns" type="checkbox" name="sendEmail" value="1" defaultChecked={sw.emails} /><label htmlFor="ns">Email the one-time code</label></div>
          <div className="row"><button className="btn">Add partner</button></div>
        </ActionForm>
      </Panel>
    </div>
  );
}
