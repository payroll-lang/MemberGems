'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { count, inr, inr2, inWords } from '@/domain';
import { exerciseExplain, fmvExplain, perquisiteExplain, sharesExplain, taxExplain, taxLabel } from '@/components/calc';
import { FileUpload, type CurrentFile } from '@/components/FileUpload';
import { Result } from '@/components/Result';
import { Callout, Line, Note } from '@/components/ui';
import { useFormAction } from '@/components/useFormAction';
import {
  addTaxPaymentAction, chooseTaxModeAction, deleteTaxPaymentAction, quoteAction, saveDematAction, saveExerciseAction,
  saveOptionsAction, signNoticeAction, submitAction,
} from '../actions';
import type { Quote } from '@/server/participant/mutations';

type Next = { href: string; label: string };

function Rev({ appId, rev }: { appId: string; rev: number }) {
  return (
    <>
      <input type="hidden" name="appId" value={appId} />
      <input type="hidden" name="rev" value={rev} />
    </>
  );
}

/* ================= 1. options ================= */

export interface OptionGrant {
  grantId: string;
  planName: string;
  prettyGrantDate: string;
  exercisableOptions: number;
  exercisePrice: number;
  step: number;
}

export function OptionsForm(props: {
  appId: string; rev: number; grants: OptionGrant[]; existing: Record<string, number>; locked: boolean;
  exercisePrice: number; next: Next;
}) {
  const { state, pending, onSubmit } = useFormAction(saveOptionsAction);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.grants.map((g) => [g.grantId, props.existing[g.grantId] ? String(props.existing[g.grantId]) : ''])));
  const [quote, setQuote] = useState<{ q: Quote | null; error: string }>({ q: null, error: '' });
  const seq = useRef(0);

  const lines = useMemo(() => Object.entries(values)
    .map(([grantId, v]) => ({ grantId, options: Number(v) || 0 }))
    .filter((l) => l.options > 0), [values]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!lines.length) return;
    const t = setTimeout(() => {
      quoteAction(lines).then((r) => {
        if (mine !== seq.current) return;
        setQuote(r.ok ? { q: r.quote, error: '' } : { q: null, error: r.error });
      }).catch(() => { /* a quote is a convenience; saving still validates */ });
    }, 350);
    return () => clearTimeout(t);
  }, [lines]);

  const shown = lines.length ? quote : { q: null, error: '' };

  return (
    <form onSubmit={onSubmit} className="grid2">
      <div>
        <Rev appId={props.appId} rev={props.rev} />
        <div className="tablewrap">
          <table className="data">
            <thead><tr><th scope="col">Grant</th><th scope="col" className="n">Available</th><th scope="col" className="n">Price</th><th scope="col">Options to exercise</th></tr></thead>
            <tbody>
              {props.grants.map((g) => {
                const disabled = props.locked || g.exercisableOptions <= 0;
                const id = 'opt-' + g.grantId;
                return (
                  <tr key={g.grantId}>
                    <td><label htmlFor={id} className="inline-label"><span className="mono">{g.grantId}</span></label><br /><span className="tag">{g.planName} · granted {g.prettyGrantDate}</span></td>
                    <td className="n">{count(g.exercisableOptions)}</td>
                    <td className="n">{inr2(g.exercisePrice)}</td>
                    <td>
                      <div className="inputrow">
                        <input
                          id={id} name={'opt:' + g.grantId} type="number" inputMode="numeric" min={0} step={g.step}
                          max={g.exercisableOptions} placeholder="0" disabled={disabled} value={values[g.grantId] ?? ''}
                          onChange={(e) => { const v = e.currentTarget.value; setValues((s) => ({ ...s, [g.grantId]: v })); }}
                          aria-describedby={id + '-step'}
                        />
                        {disabled ? null : (
                          <button type="button" className="btn ghost small" onClick={() => setValues((s) => ({ ...s, [g.grantId]: String(g.exercisableOptions) }))}>
                            Max
                          </button>
                        )}
                      </div>
                      <span id={id + '-step'} className="tag">{g.step === 1 ? 'any whole number' : 'multiples of ' + g.step}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <QuoteBox q={shown.q} error={shown.error} exercisePrice={props.exercisePrice} />
        {props.locked ? null : (
          <>
            <div className="row">
              <button className="btn" disabled={pending}>{pending ? 'Saving…' : 'Save and continue'}</button>
            </div>
            <p className="hint">You can save now and come back — nothing is submitted until the last step.</p>
          </>
        )}
        <Result state={state} next={props.next} />
      </div>
    </form>
  );
}

function QuoteBox({ q, error, exercisePrice }: { q: Quote | null; error: string; exercisePrice: number }) {
  if (error) return <Callout kind="crit" title="Check the options entered"><p>{error}</p></Callout>;
  if (!q) {
    return (
      <Note title="Exercise summary" sub="Enter options to see the amounts">
        <Line label="Options" amount="—" />
        <Line label="Exercise amount" amount="—" kind="total" />
      </Note>
    );
  }
  const total = q.exerciseAmount + q.taxAmount;
  const tsrc = { method: q.taxMethod, breakdown: q.taxBreakdown, tax: q.taxAmount, perquisite: q.perquisiteAmount, flatRate: q.taxRatePercent };
  return (
    <Note
      title="Exercise summary"
      sub={count(q.totalOptions) + ' options across ' + q.lines.length + ' grant' + (q.lines.length === 1 ? '' : 's')}
      foot={q.taxRatePercent || q.taxMethod === 'Sheet' ? undefined : 'Your tax percentage has not been loaded yet, so the tax line shows nil. The ESOP team uploads it before the window closes.'}
    >
      <Line label="Options" amount={count(q.totalOptions)} />
      <Line label="Equity shares you receive" amount={count(q.totalShares)} explain={sharesExplain(q.lines, q.totalShares)} />
      <Line label="Exercise amount payable" amount={inr(q.exerciseAmount)} kind="out" explain={exerciseExplain(q.totalOptions, exercisePrice, q.exerciseAmount)} />
      {q.fmv ? (
        <>
          <Line label="FMV applied" amount={inr2(q.fmv)} explain={fmvExplain({ date: q.fmvDate, fmv: q.fmv }, q.fmvFixed
            ? 'Fixed by the date you paid the exercise amount.'
            : 'The latest price on record. Yours is set by the trading day before you actually pay, so this figure will change.')} />
          <Line label={(q.fmvFixed ? 'fixed by your payment date, ' : 'indicative, latest price ') + q.fmvDate} kind="sub" amount="" />
        </>
      ) : <Line label="No share price on record — perquisite cannot be estimated yet" kind="sub" amount="" />}
      <Line label="Perquisite value" amount={inr(q.perquisiteAmount)} explain={perquisiteExplain({ fmv: q.fmv ?? 0, shares: q.totalShares, exerciseAmount: q.exerciseAmount, perquisite: q.perquisiteAmount })} />
      <Line label={taxLabel(tsrc)} amount={inr(q.taxAmount)} kind="out" explain={taxExplain(tsrc)} />
      <Line label="Total cash needed" amount={inr(total)} kind="total" />
      <Line label={inWords(total)} kind="words" />
    </Note>
  );
}

/* ================= 2. applicant, demat & PAN ================= */

export interface DematDefaults {
  name: string; email: string;
  designation: string; address: string; nationality: string; mobile: string;
  accountType: string; dpName: string; accountName: string; dpId: string; clientId: string; pan: string;
  cml: CurrentFile | null; panCard: CurrentFile | null;
  partnerSource: string;
}

export function DematForm(props: { appId: string; rev: number; d: DematDefaults; locked: boolean; next: Next }) {
  const { state, pending, onSubmit } = useFormAction(saveDematAction);
  const d = props.d;
  const dis = props.locked;
  const held = !!d.partnerSource;
  return (
    <form onSubmit={onSubmit}>
      <Rev appId={props.appId} rev={props.rev} />
      <h3 className="sub">Section A — your details, as they will print on the notice</h3>
      <p className="hint">Everything marked <span className="req">required</span> has to be filled in before this section can be submitted. <b>Save for later</b> works at any time, complete or not.</p>
      <div className="grid2">
        <div>
          <div className="field"><label htmlFor="dm-name">Name of the applicant</label>
            <input id="dm-name" type="text" value={d.name} disabled readOnly />
            <p className="hint">From the ESOP register. If it is wrong, tell the ESOP team — your signature must match it.</p></div>
          <div className="field"><label htmlFor="dm-desig">Designation <span className="req">required</span></label>
            <input id="dm-desig" name="designation" type="text" defaultValue={d.designation} disabled={dis} autoComplete="organization-title" /></div>
          <div className="field"><label htmlFor="dm-nat">Nationality</label>
            <input id="dm-nat" name="nationality" type="text" defaultValue={d.nationality || 'Indian'} disabled={dis} /></div>
        </div>
        <div>
          <div className="field"><label htmlFor="dm-addr">Address <span className="req">required</span></label>
            <textarea id="dm-addr" name="address" defaultValue={d.address} disabled={dis} rows={3} placeholder="Flat / house, street, locality, city, state, PIN" autoComplete="street-address" /></div>
          <div className="field"><label htmlFor="dm-mob">Mobile number <span className="req">required</span></label>
            <input id="dm-mob" name="mobile" type="tel" className="mono" defaultValue={d.mobile} disabled={dis} placeholder="10 digits" autoComplete="tel" /></div>
          <div className="field"><label htmlFor="dm-email">Email ID</label>
            <input id="dm-email" type="email" value={d.email} disabled readOnly />
            <p className="hint">Where every portal email goes. Ask the ESOP team to change it if needed.</p></div>
        </div>
      </div>

      <h3 className="sub">Demat account and PAN</h3>
      {held ? (
        <Callout kind="warn" title={'Your shares are going to your ' + d.partnerSource + ' account'}>
          <p>You chose <b>{d.partnerSource}</b> to fund the tax, so the shares from this exercise are credited to the demat account you hold with them: <b>{d.accountType} {d.dpId} / {d.clientId}</b>. Only {d.partnerSource} can change it. To use your own account instead, go back to step 4 and choose to pay the tax yourself.</p>
        </Callout>
      ) : null}
      <div className="grid2">
        <div>
          <div className="field"><label htmlFor="dm-type">Demat account type <span className="req">required</span></label>
            <select id="dm-type" name="accountType" defaultValue={d.accountType} disabled={dis || held}>
              <option value="">Choose…</option><option value="NSDL">NSDL</option><option value="CDSL">CDSL</option>
            </select>
            <p className="hint">On your CML. NSDL DP IDs begin &quot;IN&quot;; CDSL accounts are a 16-digit BO ID.</p></div>
          <div className="field"><label htmlFor="dm-dp">Depository participant <span className="req">required</span></label>
            <input id="dm-dp" name="dpName" type="text" defaultValue={d.dpName} disabled={dis || held} placeholder="e.g. Zerodha, HDFC Securities" /></div>
          <div className="field"><label htmlFor="dm-acname">Account holder name, as on the CML <span className="req">required</span></label>
            <input id="dm-acname" name="accountName" type="text" defaultValue={d.accountName} disabled={dis || held} /></div>
          <div className="row2">
            <div className="field"><label htmlFor="dm-dpid">DP ID <span className="req">required</span></label>
              <input id="dm-dpid" name="dpId" type="text" className="mono" defaultValue={d.dpId} disabled={dis || held} placeholder="IN300000" autoCapitalize="characters" /></div>
            <div className="field"><label htmlFor="dm-client">Client ID <span className="req">required</span></label>
              <input id="dm-client" name="clientId" type="text" className="mono" inputMode="numeric" defaultValue={d.clientId} disabled={dis || held} placeholder="12345678" /></div>
          </div>
          <p className="hint">NSDL: an 8-character DP ID starting &quot;IN&quot;, plus an 8-digit client ID. CDSL: a 16-digit BO ID, split 8 and 8.</p>
          <div className="field"><label htmlFor="dm-pan">PAN <span className="req">required</span></label>
            <input id="dm-pan" name="pan" type="text" className="mono" maxLength={10} defaultValue={d.pan} disabled={dis} placeholder="ABCDE1234F" autoCapitalize="characters" /></div>
        </div>
        <div>
          {held ? null : (
            <FileUpload name="cmlFileId" purpose="cml" appId={props.appId} label="Client master report (CML)" required current={d.cml} disabled={dis}
              hint="Download it from your broker or DP. It must show the DP ID, client ID, name and PAN. PDF, JPG or PNG up to 8 MB." />
          )}
          <FileUpload name="panFileId" purpose="pan" appId={props.appId} label="PAN card" required current={d.panCard} disabled={dis}
            hint="A clear scan or photograph of the card. PDF, JPG or PNG up to 8 MB." />
          {dis ? null : (
            <div className="row">
              <button className="btn" name="finalise" value="1" disabled={pending}>{pending ? 'Saving…' : 'Submit these details'}</button>
              <button className="btn ghost" name="finalise" value="0" disabled={pending}>Save for later</button>
            </div>
          )}
          <Result state={state} next={props.next} />
        </div>
      </div>
    </form>
  );
}

/* ================= 3. exercise payment ================= */

export function ExerciseForm(props: {
  appId: string; rev: number; locked: boolean; due: number; today: string; next: Next;
  d: { utr: string; date: string; amount: number; bank: string; proof: CurrentFile | null };
}) {
  const { state, pending, onSubmit } = useFormAction(saveExerciseAction);
  const [amount, setAmount] = useState(String(props.d.amount || props.due || ''));
  const entered = Number(amount) || 0;
  const tally = !entered ? '' : Math.abs(entered - props.due) <= 1 ? 'Matches the exercise amount due.'
    : 'The exercise amount due is ' + inr(props.due) + ' — this differs by ' + inr(Math.abs(entered - props.due)) + '.';
  const dis = props.locked;
  return (
    <form onSubmit={onSubmit}>
      <Rev appId={props.appId} rev={props.rev} />
      <div className="field"><label htmlFor="ex-utr">UTR / transaction reference</label>
        <input id="ex-utr" name="utr" type="text" className="mono" defaultValue={props.d.utr} disabled={dis} autoCapitalize="characters" />
        <p className="hint">Copy it exactly as it appears in your bank statement.</p></div>
      <div className="field"><label htmlFor="ex-date">Date of payment</label>
        <input id="ex-date" name="paymentDate" type="date" max={props.today} defaultValue={props.d.date} disabled={dis} />
        <p className="hint">This date fixes your FMV, perquisite, tax and tax due date.</p></div>
      <div className="row2">
        <div className="field"><label htmlFor="ex-amt">Amount transferred (₹)</label>
          <input id="ex-amt" name="amount" type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(e.currentTarget.value)} disabled={dis} />
          <p className="hint" aria-live="polite">{tally}</p></div>
        <div className="field"><label htmlFor="ex-bank">Bank</label>
          <input id="ex-bank" name="bank" type="text" defaultValue={props.d.bank} disabled={dis} placeholder="Remitting bank" /></div>
      </div>
      <FileUpload name="proofFileId" purpose="exerciseProof" appId={props.appId} label="Payment proof" current={props.d.proof} disabled={dis}
        hint="The payment advice, UPI receipt or the statement line showing this transfer. PDF, JPG or PNG up to 8 MB." />
      {dis ? null : (
        <div className="row">
          <button className="btn" name="finalise" value="1" disabled={pending}>{pending ? 'Saving…' : 'Submit payment details'}</button>
          <button className="btn ghost" name="finalise" value="0" disabled={pending}>Save for later</button>
        </div>
      )}
      <Result state={state} next={props.next} />
    </form>
  );
}

/* ================= 4. tax ================= */

export function TaxModeForm(props: {
  appId: string; rev: number; locked: boolean; mode: string; partnerId: string;
  partners: { partnerId: string; name: string }[]; taxAmount: number; totalShares: number; dueDate: string; next: Next;
}) {
  const { state, pending, onSubmit } = useFormAction(chooseTaxModeAction);
  const [mode, setMode] = useState(props.mode);
  const dis = props.locked;
  return (
    <form onSubmit={onSubmit}>
      <Rev appId={props.appId} rev={props.rev} />
      <fieldset className="radiocards" disabled={dis}>
        <legend className="sr-only">How the tax will be paid</legend>
        <label className={'radiocard' + (mode === 'Self' ? ' sel' : '')}>
          <input type="radio" name="mode" value="Self" checked={mode === 'Self'} onChange={() => setMode('Self')} />
          <span><span className="t">I will pay the tax myself</span>
            <span className="d">Transfer {inr(props.taxAmount)} and record the UTR, date and proof below. You can pay in instalments.</span></span>
        </label>
        <label className={'radiocard' + (mode === 'FundPartner' ? ' sel' : '')}>
          <input type="radio" name="mode" value="FundPartner" checked={mode === 'FundPartner'} onChange={() => setMode('FundPartner')} />
          <span><span className="t">Pay through a fund partner</span>
            <span className="d">A partner funds the tax against the shares you are receiving. Your shares are then credited to a demat account you hold with that partner, not to your own account.</span></span>
        </label>
      </fieldset>
      {mode === 'FundPartner' ? (
        <>
          <Callout kind="warn" title="How funding through a partner works">
            <ol className="steps">
              <li>You open a demat account with the partner, if you do not already hold one.</li>
              <li>The {count(props.totalShares)} equity shares from this exercise are credited to <b>that</b> account — not to the demat account you entered in step 2.</li>
              <li>The partner funds your tax of {inr(props.taxAmount)} against those shares.</li>
              <li>Later, when you ask the partner to sell, they sell enough to clear what you owe them and its interest. Whatever is left stays yours.</li>
            </ol>
            <p>The funding terms — interest, charges, how and when you sell — are a matter between you and the partner. <b>PhysicsWallah is not a party to them</b> and the portal does not track them. Ask the partner for their terms in writing before you choose this route.</p>
            <p>The tax reaching us by {props.dueDate || 'the due date'} remains <b>your</b> responsibility, whoever pays it.</p>
          </Callout>
          <div className="field"><label htmlFor="fp-sel">Fund partner</label>
            <select id="fp-sel" name="partnerId" defaultValue={props.partnerId} disabled={dis}>
              <option value="">Choose a partner…</option>
              {props.partners.map((p) => <option key={p.partnerId} value={p.partnerId}>{p.name}</option>)}
            </select>
            {props.partners.length ? null : <p className="hint">No fund partner is available at the moment. Pay the tax yourself, or contact the ESOP team.</p>}
          </div>
        </>
      ) : null}
      {dis ? null : (
        <div className="row"><button className="btn" disabled={pending || !mode}>{pending ? 'Saving…' : 'Confirm this choice'}</button></div>
      )}
      <Result state={state} next={props.next} />
    </form>
  );
}

export function AddTaxPaymentForm(props: { appId: string; rev: number; remaining: number; dueTotal: number; today: string; next: Next }) {
  const { state, pending, onSubmit } = useFormAction(addTaxPaymentAction);
  return (
    <form onSubmit={onSubmit}>
      <Rev appId={props.appId} rev={props.rev} />
      <div className="grid2">
        <div>
          <div className="field"><label htmlFor="tx-utr">UTR / transaction reference</label>
            <input id="tx-utr" name="utr" type="text" className="mono" placeholder="As it appears in your statement" autoCapitalize="characters" /></div>
          <div className="field"><label htmlFor="tx-date">Date of payment</label>
            <input id="tx-date" name="paymentDate" type="date" max={props.today} /></div>
          <div className="row2">
            <div className="field"><label htmlFor="tx-amt">Amount paid (₹)</label>
              <input id="tx-amt" name="amount" type="number" step="0.01" min={0} defaultValue={props.remaining} /></div>
            <div className="field"><label htmlFor="tx-bank">Bank</label>
              <input id="tx-bank" name="bank" type="text" placeholder="Remitting bank" /></div>
          </div>
        </div>
        <div>
          <FileUpload name="proofFileId" purpose="taxProof" appId={props.appId} label="Proof of this payment" required
            hint="The advice or statement line for this transfer alone. PDF, JPG or PNG up to 8 MB." />
          <div className="row"><button className="btn" disabled={pending}>{pending ? 'Recording…' : 'Record this payment'}</button></div>
          <Result state={state} next={props.next} />
        </div>
      </div>
    </form>
  );
}

export function DeleteTaxPaymentButton(props: { appId: string; rev: number; paymentId: string; label: string }) {
  const { state, pending, onSubmit } = useFormAction(deleteTaxPaymentAction);
  return (
    <form onSubmit={(e) => { if (!window.confirm('Remove ' + props.label + '? Its proof stays on file for the record.')) { e.preventDefault(); return; } onSubmit(e); }}>
      <Rev appId={props.appId} rev={props.rev} />
      <input type="hidden" name="paymentId" value={props.paymentId} />
      <button className="btn link" disabled={pending} aria-label={'Remove ' + props.label}>{pending ? 'Removing…' : 'Remove'}</button>
      {state.error ? <span className="err-text" role="alert"> {state.error}</span> : null}
    </form>
  );
}

/* ================= 5. notice ================= */

export function SignForm(props: { appId: string; rev: number; expectedName: string; place: string; next: Next }) {
  const { state, pending, onSubmit } = useFormAction(signNoticeAction);
  const first = props.expectedName.split(/\s+/).filter(Boolean)[0] || props.expectedName;
  return (
    <form onSubmit={onSubmit} className="signform">
      <Rev appId={props.appId} rev={props.rev} />
      <div className="checkline">
        <input id="nt-accept" type="checkbox" name="accepted" value="yes" />
        <label htmlFor="nt-accept">I have read the notice above and the declarations in it. The options, demat account, PAN and payment details stated are mine and are correct. I understand that signing here has the same effect as signing the notice by hand.</label>
      </div>
      <div className="row2">
        <div className="field"><label htmlFor="nt-name">Type your name to sign</label>
          <input id="nt-name" name="signatureName" type="text" placeholder={first} autoComplete="name" />
          <p className="hint">Your first name is enough — &quot;{first}&quot;. The full name on your record, {props.expectedName}, is printed on the notice either way.</p></div>
        <div className="field"><label htmlFor="nt-place">Place</label>
          <input id="nt-place" name="place" type="text" defaultValue={props.place} placeholder="City" autoComplete="address-level2" />
          <p className="hint">Printed on the notice beside the date.</p></div>
      </div>
      <div className="row"><button className="btn" disabled={pending}>{pending ? 'Signing…' : 'Sign the notice'}</button></div>
      <Result state={state} next={props.next} />
    </form>
  );
}

/* ================= 6. submit ================= */

export function SubmitForm(props: { appId: string; rev: number }) {
  const { state, pending, onSubmit } = useFormAction(submitAction);
  return (
    <form onSubmit={onSubmit}>
      <Rev appId={props.appId} rev={props.rev} />
      <div className="row"><button className="btn" disabled={pending}>{pending ? 'Submitting…' : 'Submit application'}</button></div>
      <Result state={state} next={{ href: '/employee', label: 'Back to your dashboard' }} />
    </form>
  );
}
