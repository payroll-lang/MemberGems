import Link from 'next/link';
import { Callout, Panel } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { DETAILS_COLUMNS } from '@/server/admin/core/bulkPaste';
import { loadSettings } from '@/server/settings';
import { bulkBlockAction, bulkDetailsAction, bulkTaxRatesAction, enabledListAction } from '../../actions';
import { ActionForm } from '../../_ui/ActionForm';

export const metadata = { title: 'Participant bulk tools · ESOP team' };
export const maxDuration = 300;

/** AdminApi bulkTaxRates / bulkParticipantDetails / setEnabledList / bulkBlock. */
export default async function BulkPage() {
  await requireRole('Admin');
  const settings = await loadSettings();
  const enabled = settings.portal.eligibleEmployeeIds;
  return (
    <div className="stack">
      <p className="small"><Link href="/admin/participants" prefetch={false}>← Participants</Link></p>
      <div><div className="eyebrow">Masters</div><h1 className="title">Bulk tools</h1>
        <p className="lede">Paste straight from a spreadsheet: one participant per line, tab or comma separated.</p></div>

      <Panel title="CTC and flat tax rates">
        <p className="hint">Employee ID, CTC, tax % — or just Employee ID, tax %. Rates must be 0–60. Draft and sent-back applications are repriced; submitted ones are listed so you can reprice each explicitly.</p>
        <ActionForm action={bulkTaxRatesAction}>
          <div className="field"><label htmlFor="rates">Rows</label><textarea id="rates" name="rows" rows={8} className="mono" placeholder={'PW-4471\t2800000\t31.2\nPW-5210\t1900000\t20.8'} /></div>
          <button className="btn">Apply rates</button>
        </ActionForm>
      </Panel>

      <Panel title="PAN and demat details (prefills)">
        <p className="hint">Nine columns in this order: <span className="mono">{DETAILS_COLUMNS.join(' · ')}</span>. Leave a cell blank to leave that value as it is — only the Employee ID is required. These prefill the participant’s next application; they still see and confirm every value, attach a CML, and the section is still verified.</p>
        <ActionForm action={bulkDetailsAction}>
          <div className="field"><label htmlFor="det">Rows</label><textarea id="det" name="rows" rows={8} className="mono" placeholder={'PW4872\tABCDE1234F\tNSDL\tHDFC Securities\tIN300123\t12345678\tKamesh Isame\t9876543210\tNoida'} /></div>
          <button className="btn">Apply details</button>
        </ActionForm>
      </Panel>

      <Panel title="Enabled list" aside={enabled.length ? enabled.length + ' enabled' : 'open to everyone'}>
        {enabled.length ? <Callout kind="warn" title="Limited start in force"><p>Only the participants listed can sign in and exercise; nobody else is given a login or invited.</p></Callout>
          : <p className="hint">Empty: the portal is open to every participant on the report. A list limits it to those codes — for a controlled start.</p>}
        <ActionForm action={enabledListAction}>
          <div className="field"><label htmlFor="enl">Employee codes</label><textarea id="enl" name="ids" rows={5} className="mono" defaultValue={enabled.join(', ')} /></div>
          <div className="row">
            <button className="btn" name="clear" value="0">Save list</button>
            <button className="btn ghost" name="clear" value="1">Clear — open to everyone</button>
          </div>
        </ActionForm>
      </Panel>

      <Panel title="Block or release a list">
        <ActionForm action={bulkBlockAction}>
          <div className="field"><label htmlFor="bids">Employee codes</label><textarea id="bids" name="ids" rows={4} className="mono" /></div>
          <div className="field"><label htmlFor="brs">Reason (shown to them; required to block)</label><input id="brs" type="text" name="reason" /></div>
          <div className="row">
            <button className="btn" name="blocked" value="1">Block these</button>
            <button className="btn ghost" name="blocked" value="0">Release these</button>
          </div>
        </ActionForm>
      </Panel>
    </div>
  );
}
