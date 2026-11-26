'use client';

import { useState } from 'react';
import { inr } from '@/domain';
import { FileUpload, type CurrentFile } from '@/components/FileUpload';
import { Result } from '@/components/Result';
import { Callout } from '@/components/ui';
import { useFormAction } from '@/components/useFormAction';
import { declineAction, partnerRequestAction } from '../../actions';

export interface RequestFormProps {
  requestId: string;
  appId: string;
  partnerName: string;
  employeeName: string;
  taxAmount: number;
  today: string;
  demat: { accountType: string; dpName: string; accountName: string; dpId: string; clientId: string; cml: CurrentFile | null; set: boolean };
  payment: { utr: string; date: string; amount: number; bank: string; proof: CurrentFile | null };
}

/**
 * The account and the payment in one form (App.html partnerForm). The demat
 * account comes first: the shares are the security for the funding, so the
 * money is not recorded before the account they land in is known.
 */
export function RequestForm(props: RequestFormProps) {
  const { state, pending, onSubmit } = useFormAction(partnerRequestAction);
  const d = props.demat;
  const [amount, setAmount] = useState(String(props.payment.amount || props.taxAmount || ''));
  const entered = Number(amount) || 0;
  const tally = !entered ? '' : entered + 1 < props.taxAmount
    ? 'Short of the tax due (' + inr(props.taxAmount) + ') by ' + inr(props.taxAmount - entered) + '.'
    : Math.abs(entered - props.taxAmount) <= 1 ? 'Matches the tax due.' : 'More than the tax due of ' + inr(props.taxAmount) + '.';

  return (
    <form onSubmit={onSubmit}>
      <input type="hidden" name="requestId" value={props.requestId} />

      <h3 className="sub">The demat account for allotment</h3>
      <div className="grid2">
        <div>
          <div className="field"><label htmlFor="pd-type">Demat account type <span className="req">required</span></label>
            <select id="pd-type" name="accountType" defaultValue={d.accountType}>
              <option value="">Choose…</option><option value="NSDL">NSDL</option><option value="CDSL">CDSL</option>
            </select></div>
          <div className="field"><label htmlFor="pd-name">Depository participant</label>
            <input id="pd-name" name="dpName" type="text" defaultValue={d.dpName || props.partnerName} />
            <p className="hint">Defaults to your own name. Change it only if the account sits with a different DP.</p></div>
          <div className="field"><label htmlFor="pd-acname">Account holder name <span className="req">required</span></label>
            <input id="pd-acname" name="accountName" type="text" defaultValue={d.accountName || props.employeeName} />
            <p className="hint">As it appears on the account. The ESOP team checks it against the ESOP register.</p></div>
        </div>
        <div>
          <div className="row2">
            <div className="field"><label htmlFor="pd-dpid">DP ID <span className="req">required</span></label>
              <input id="pd-dpid" name="dpId" type="text" className="mono" defaultValue={d.dpId} placeholder="IN300000" autoCapitalize="characters" /></div>
            <div className="field"><label htmlFor="pd-client">Client ID <span className="req">required</span></label>
              <input id="pd-client" name="clientId" type="text" className="mono" inputMode="numeric" defaultValue={d.clientId} placeholder="12345678" /></div>
          </div>
          <p className="hint">NSDL: an 8-character DP ID starting &quot;IN&quot;, plus an 8-digit client ID. CDSL: a 16-digit BO ID, split 8 and 8.</p>
          <FileUpload name="cmlFileId" purpose="partnerCml" appId={props.appId} requestId={props.requestId}
            label="Client master list (CML)" required current={d.cml}
            hint="The CML for this demat account, from your depository system. PDF, JPG or PNG up to 8 MB." />
          <div className="row">
            <button className="btn ghost" name="intent" value="demat" disabled={pending}>{d.set ? 'Update just the account' : 'Save just the account'}</button>
          </div>
          <p className="hint">You do not need this button for a new request — <b>Submit the account and payment</b> below records both at once.
            Use it only to correct the account on its own. Either way the employee is emailed a copy to check, and the ESOP team re-verifies the section.</p>
        </div>
      </div>

      <div className="divider" />
      <h3 className="sub">The tax payment</h3>
      <div className="grid2">
        <div>
          <div className="field"><label htmlFor="pf-utr">UTR / transaction reference <span className="req">required</span></label>
            <input id="pf-utr" name="utr" type="text" className="mono" defaultValue={props.payment.utr} autoCapitalize="characters" /></div>
          <div className="field"><label htmlFor="pf-date">Date of payment <span className="req">required</span></label>
            <input id="pf-date" name="paymentDate" type="date" max={props.today} defaultValue={props.payment.date} /></div>
          <div className="row2">
            <div className="field"><label htmlFor="pf-amt">Amount paid (₹)</label>
              <input id="pf-amt" name="amount" type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(e.currentTarget.value)} />
              <p className="hint" aria-live="polite">{tally}</p></div>
            <div className="field"><label htmlFor="pf-bank">Bank</label>
              <input id="pf-bank" name="bank" type="text" defaultValue={props.payment.bank} /></div>
          </div>
        </div>
        <div>
          <FileUpload name="proofFileId" purpose="partnerTaxProof" appId={props.appId} requestId={props.requestId}
            label="Payment proof" required current={props.payment.proof}
            hint="The payment advice or bank statement for this transfer. PDF, JPG or PNG up to 8 MB." />
          <div className="row">
            <button className="btn" name="intent" value="submit" disabled={pending}>{pending ? 'Working…' : 'Submit the account and payment'}</button>
            <button className="btn ghost" name="intent" value="save" disabled={pending}>Save without submitting</button>
          </div>
          <p className="hint">One button does both: the allotment account above and the payment here are recorded together, the employee
            and the ESOP team are notified, and these fields lock. <b>&quot;Save without submitting&quot; keeps the payment details you typed but
            sends nothing</b> — the ESOP team will not see it, and the demat account is not saved by it.</p>
          <Result state={state} next={state.ok ? { href: '/partner', label: 'Back to your requests' } : undefined} />
        </div>
      </div>
    </form>
  );
}

export function DeclineForm(props: { requestId: string; summary: string }) {
  const { state, pending, onSubmit } = useFormAction(declineAction);
  return (
    <details className="decline">
      <summary>Decline this request</summary>
      <form onSubmit={onSubmit}>
        <input type="hidden" name="requestId" value={props.requestId} />
        <p className="lede">{props.summary}</p>
        <Callout kind="warn" title="What happens">
          <p>The participant is told you declined, and why, and is released to choose another partner or pay the tax themselves.
            Any demat account entered on their behalf is put back to theirs. Their options, payment and notice are untouched.</p>
        </Callout>
        <div className="field"><label htmlFor="dc-why">Reason <span className="req">required</span></label>
          <textarea id="dc-why" name="reason" rows={3} minLength={5} maxLength={1000}
            placeholder="e.g. Account could not be opened in time for the tax due date" />
          <p className="hint">The participant sees this exactly as written.</p></div>
        <div className="row">
          <button className="btn danger" disabled={pending}>{pending ? 'Declining…' : 'Decline the request'}</button>
        </div>
        <Result state={state} next={state.ok ? { href: '/partner', label: 'Back to your requests' } : undefined} />
      </form>
    </details>
  );
}
