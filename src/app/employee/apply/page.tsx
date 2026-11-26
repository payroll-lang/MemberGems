import Link from 'next/link';
import { STAGES, count, inr, inr2, inWords, prettyDate, prettyStamp, type StageKey } from '@/domain';
import { fmvExplain, perquisiteExplain, sharesExplain, taxExplain, taxLabel, type TaxSource } from '@/components/calc';
import { BankBox, Callout, FileLink, Figure, Line, Note, Panel, Pill, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { stageSentBack, type AppView } from '@/server/core/view';
import { UserError } from '@/server/errors';
import { loadCurrentNotice, loadDashboard, type Dashboard } from '@/server/participant/dashboard';
import {
  AddTaxPaymentForm, DeleteTaxPaymentButton, DematForm, ExerciseForm, OptionsForm, SignForm, SubmitForm, TaxModeForm,
} from './forms';

export const metadata = { title: 'Exercise application · ESOP Exercise Portal' };

type Search = Promise<Record<string, string | string[] | undefined>>;

const KEYS = STAGES.map((s) => s.key) as StageKey[];

export default async function ApplyPage({ searchParams }: { searchParams: Search }) {
  const { user } = await requireRole('Employee');
  const sp = await searchParams;
  let d: Dashboard;
  try {
    d = await loadDashboard(user.userId);
  } catch (e) {
    if (e instanceof UserError) return <Callout kind="crit" title="Your record is not available"><p>{e.message}</p></Callout>;
    throw e;
  }
  const startingNew = sp.new === '1' && !d.applicationIsLive && d.canStartAnother;
  const app = startingNew ? null : d.application;
  const wanted = typeof sp.step === 'string' && (KEYS as string[]).includes(sp.step) ? (sp.step as StageKey) : null;
  const step: StageKey = wanted ?? (app && app.editable ? app.progress.stage : 'options');
  const q = startingNew ? '&new=1' : '';
  const href = (k: StageKey) => '/employee/apply?step=' + k + q;
  const nextOf = (k: StageKey) => {
    const i = KEYS.indexOf(k);
    const n = KEYS[Math.min(KEYS.length - 1, i + 1)];
    return { href: '/employee/apply?step=' + n, label: 'Continue to step ' + (KEYS.indexOf(n) + 1) };
  };

  if (!app && d.totals.exercisable <= 0) {
    return (
      <div className="stack">
        <BackLink />
        <Callout kind="warn" title="Nothing to exercise">
          <p>There are no options available to exercise on your record at the moment. Your dashboard explains why.</p>
        </Callout>
      </div>
    );
  }

  const lock = lockOf(d, app);

  return (
    <div className="stack">
      <BackLink />
      <div className="spread">
        <div>
          <div className="eyebrow">{d.window.label} window{app ? ' · ' + app.appId : startingNew ? ' · new application' : ''}</div>
          <h1 className="title">Exercise application</h1>
        </div>
        {app ? <StatusPill status={app.status} /> : null}
      </div>

      <nav aria-label="Application steps">
        <ol className="stepper">
          {STAGES.map((s, i) => {
            const back = stageSentBack(app?.review, s.key);
            const done = !!app?.progress.done[s.key] && !back;
            return (
              <li key={s.key}>
                <Link href={href(s.key)} className={'step' + (done ? ' done' : '') + (back ? ' back' : '')} aria-current={step === s.key ? 'step' : undefined}>
                  <span className="n"><span className="tick" aria-hidden="true" />Step {i + 1}{back ? ' · sent back' : done ? ' · done' : ''}</span>
                  <span className="l">{s.label}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      </nav>

      {startingNew && d.application ? (
        <Callout kind="info" title="A new application">
          <p>Application {d.application.appId} is {d.application.status.toLowerCase()}. These steps are for a new application, which is not created until you save your options in step 1. <Link href="/employee">Cancel and go back</Link>.</p>
        </Callout>
      ) : null}

      {step === 'options' ? <OptionsStep d={d} app={app} lock={lock} next={nextOf('options')} /> : null}
      {step === 'demat' ? <DematStep d={d} app={app} lock={lock} next={nextOf('demat')} /> : null}
      {step === 'exercise' ? <ExerciseStep d={d} app={app} lock={lock} next={nextOf('exercise')} /> : null}
      {step === 'tax' ? <TaxStep d={d} app={app} lock={lock} next={nextOf('tax')} /> : null}
      {step === 'notice' ? <NoticeStep userId={user.userId} app={app} lock={lock} next={nextOf('notice')} /> : null}
      {step === 'submit' ? <SubmitStep app={app} lock={lock} /> : null}
    </div>
  );
}

function BackLink() {
  return <p className="small"><Link href="/employee">← Your dashboard</Link></p>;
}

/** Why the steps are read-only, or null. */
function lockOf(d: Dashboard, app: AppView | null): string | null {
  if (d.blocked) return d.blockedReason;
  if (!d.window.isOpen) return 'The ' + d.window.label + ' window is closed. ' + d.window.reason;
  if (app && !app.editable) return 'This application is ' + app.status.toLowerCase() + ' and can no longer be edited.';
  return null;
}

function LockNote({ lock }: { lock: string | null }) {
  return lock ? <Callout kind="warn" title="Read only"><p>{lock}</p></Callout> : null;
}

function NeedApp() {
  return (
    <Panel>
      <Callout kind="warn" title="Record your options first">
        <p>Go to step 1 and save the options you wish to exercise. Everything else follows from that. <Link href="/employee/apply?step=options">Go to step 1</Link></p>
      </Callout>
    </Panel>
  );
}

function SentBackNote({ app, section }: { app: AppView | null; section: 'options' | 'demat' | 'exercisePayment' | 'taxPayment' | 'notice' }) {
  if (!app || app.review[section] !== 'Sent Back') return null;
  const remarks = app.review.remarks.filter((r) => r.section === section || !r.section);
  return (
    <Callout kind="crit" title="Sent back by the ESOP team — please correct this section">
      {remarks.length ? <ul className="remarks">{remarks.map((r, i) => <li key={i}>{r.text}</li>)}</ul> : <p>Correct it and save, then submit again.</p>}
    </Callout>
  );
}

const taxSrc = (a: AppView): TaxSource => ({ method: a.taxMethod, breakdown: a.taxBreakdown, tax: a.taxAmount, perquisite: a.perquisiteAmount, flatRate: a.taxRatePercent });

/* ---------------- 1 ---------------- */

function OptionsStep({ d, app, lock, next }: { d: Dashboard; app: AppView | null; lock: string | null; next: { href: string; label: string } }) {
  let l = lock;
  if (!l && app && app.exercisePayment.utr && app.review.exercisePayment !== 'Sent Back') {
    l = 'The exercise amount has been paid, so the options are now fixed' +
      (app.fmvValue ? ' and the fair market value of ' + inr2(app.fmvValue) + ' applies to this whole application' : '') +
      '. If the number of options has to change, ask the ESOP team to send the exercise payment back to you — this step then opens again.';
  }
  const existing: Record<string, number> = {};
  app?.lines.forEach((x) => { existing[x.grantId] = x.options; });
  const live = d.grants.filter((g) => g.availableOptions > 0);
  const lotted = live.filter((g) => g.step > 1);
  const byStep = new Map<number, Set<string>>();
  live.forEach((g) => { if (!byStep.has(g.step)) byStep.set(g.step, new Set()); byStep.get(g.step)!.add(g.planName || g.grantId); });
  const summary = [...byStep.entries()].map(([k, v]) => [...v].join(', ') + ': ' + (k === 1 ? 'any whole number' : 'multiples of ' + k)).join(' · ');
  return (
    <Panel title="Options you wish to exercise" aside={summary || 'Multiples of ' + d.lotSize}>
      <LockNote lock={l} />
      <SentBackNote app={app} section="options" />
      <OptionsForm
        appId={app?.appId ?? ''} rev={app?.rev ?? 0} locked={!!l} exercisePrice={d.exercisePrice} existing={existing} next={next}
        grants={d.grants.map((g) => ({ grantId: g.grantId, planName: g.planName, prettyGrantDate: g.prettyGrantDate, exercisableOptions: g.exercisableOptions, exercisePrice: g.exercisePrice, step: g.step }))}
      />
      {lotted.length ? (
        <Callout title={'Why multiples of ' + lotted[0].step + '?'}>
          <p>For {lotted[0].planName || 'this plan'} the register is maintained in lots of {lotted[0].step}. An entry like 233 is not accepted — use 230 or 240. Where a grant’s available balance is not a whole lot, the odd options stay behind for a later window.{live.some((g) => g.step === 1) ? ' Grants under a one-for-one plan have no such rule.' : ''}</p>
        </Callout>
      ) : (
        <Callout title="Any whole number of options"><p>Your plan converts one option to one share, so there is no lot size — seven options is seven shares.</p></Callout>
      )}
    </Panel>
  );
}

/* ---------------- 2 ---------------- */

function DematStep({ d, app, lock, next }: { d: Dashboard; app: AppView | null; lock: string | null; next: { href: string; label: string } }) {
  if (!app) return <NeedApp />;
  const e = d.employee;
  const dm = app.demat;
  const ap = app.applicant;
  return (
    <Panel title="Applicant, demat account and PAN" aside="Shares are credited to exactly this account">
      <LockNote lock={lock} />
      <SentBackNote app={app} section="demat" />
      {app.prefilled.demat || app.prefilled.pan ? (
        <Callout kind="info" title="Some of this was already on file">
          <p>The ESOP team has your {[app.prefilled.demat ? 'demat account details' : '', app.prefilled.pan ? 'PAN' : ''].filter(Boolean).join(' and ')} on record, so they are filled in below. <b>Please check every value</b> — shares are credited to exactly this account. Correct anything that is out of date and it will be remembered for next time.</p>
        </Callout>
      ) : null}
      <DematForm
        appId={app.appId} rev={app.rev} locked={!!lock} next={next}
        d={{
          name: e.name, email: ap.email || e.email, designation: ap.designation || e.designation, address: ap.address || e.address,
          nationality: ap.nationality || e.nationality || 'Indian', mobile: ap.mobile || e.mobile,
          accountType: dm.accountType, dpName: dm.dpName, accountName: dm.accountName, dpId: dm.dpId, clientId: dm.clientId,
          pan: dm.pan, cml: dm.cml, panCard: dm.panCard, partnerSource: dm.source,
        }}
      />
    </Panel>
  );
}

/* ---------------- 3 ---------------- */

function TaxPositionNote({ app }: { app: AppView }) {
  const priced = app.fmvValue > 0;
  const ind = app.indicative;
  const fmv = priced ? app.fmvValue : ind ? ind.fmv : 0;
  const fmvDate = priced ? app.fmvDate : ind ? ind.fmvDate : '';
  const perq = priced ? app.perquisiteAmount : ind ? ind.perquisiteAmount : 0;
  const tax = priced ? app.taxAmount : ind ? ind.taxAmount : 0;
  const have = priced || !!ind;
  const tsrc: TaxSource = {
    method: priced ? app.taxMethod : ind ? ind.taxMethod : '',
    breakdown: priced ? app.taxBreakdown : ind ? ind.taxBreakdown : null,
    tax, perquisite: perq, flatRate: priced ? app.taxRatePercent : ind ? ind.taxRatePercent : 0,
  };
  return (
    <Note
      title={priced ? 'Your tax position' : 'Indicative tax position'}
      sub={priced ? 'Fixed by the FMV of ' + prettyDate(fmvDate) : have ? 'At the price of ' + prettyDate(fmvDate) + ' — not yet fixed' : 'No share price on record yet'}
    >
      {priced ? null : (
        <Callout kind="warn" title="These figures will change">
          <p>Your tax is worked out from the FMV of the trading day <b>before you pay</b> the exercise amount. Until you record that payment, the figures use the latest price on record so you can see roughly what you are taking on.</p>
        </Callout>
      )}
      <Line label="Options" amount={count(app.totalOptions)} />
      <Line label="Equity shares" amount={count(app.totalShares)} explain={sharesExplain(app.lines, app.totalShares)} />
      <Line label="Exercise amount" amount={inr(app.exerciseAmount)} kind="out" />
      <Line label="FMV per share" amount={have ? inr2(fmv) : '—'} explain={have ? fmvExplain({ date: fmvDate, fmv }, priced
        ? 'Fixed by the date you paid the exercise amount, and it will not change now.'
        : 'This is the latest price on record. Your own figure is set by the trading day before the date you actually pay, so it will change.') : undefined} />
      <Line label="Perquisite value" amount={have ? inr(perq) : '—'} explain={have ? perquisiteExplain({ fmv, shares: app.totalShares, exerciseAmount: app.exerciseAmount, perquisite: perq }) : undefined} />
      <Line label={taxLabel(tsrc)} amount={have ? inr(tax) : '—'} kind="out" explain={have ? taxExplain(tsrc) : undefined} />
      {have ? <Line label={inWords(tax)} kind="words" /> : null}
      <Line label="Tax due by" amount={prettyDate(app.taxDueDate) || '—'} kind="total" />
    </Note>
  );
}

function ExerciseStep({ d, app, lock, next }: { d: Dashboard; app: AppView | null; lock: string | null; next: { href: string; label: string } }) {
  if (!app || app.totalOptions <= 0) return <NeedApp />;
  const ex = app.exercisePayment;
  return (
    <Panel title="Exercise payment" aside={inr2(app.exercisePrice || d.exercisePrice) + ' per option × ' + count(app.totalOptions) + ' options'}>
      <LockNote lock={lock} />
      <SentBackNote app={app} section="exercisePayment" />
      <Callout kind="info" title={'Transfer ' + inr(app.exerciseAmount) + ', then record the transfer here'}>
        <p>The date you pay decides your tax: the fair market value used is the average of the opening and closing share price on the <b>trading day before</b> your payment date. If that day’s price is not on record yet, the payment cannot be saved until the ESOP team loads it.</p>
        <p className="words">{inWords(app.exerciseAmount)}</p>
        {d.bankDetails.exercise ? <BankBox text={d.bankDetails.exercise} /> : null}
        {d.paymentReference ? <p>Quote this reference: <b>{d.paymentReference}</b></p> : null}
      </Callout>
      <div className="grid2">
        <ExerciseForm
          appId={app.appId} rev={app.rev} locked={!!lock} due={app.exerciseAmount} today={d.today} next={next}
          d={{ utr: ex.utr, date: ex.date, amount: ex.amount, bank: ex.bank, proof: ex.proof }}
        />
        <TaxPositionNote app={app} />
      </div>
    </Panel>
  );
}

/* ---------------- 4 ---------------- */

function TaxStep({ d, app, lock, next }: { d: Dashboard; app: AppView | null; lock: string | null; next: { href: string; label: string } }) {
  if (!app) return <NeedApp />;
  if (app.taxMethod === 'Sheet' && app.taxAmount <= 0 && app.fmvValue > 0) {
    return (
      <Panel title="Tax on the perquisite">
        <Callout kind="info" title="No tax is due on this exercise">
          <p>Your income for the year, including this exercise, stays within the tax-free limit, so there is nothing to pay and nothing to upload for this step. Go on to the next step.</p>
        </Callout>
        <Note title="How this was worked out"><Line label={taxLabel(taxSrc(app))} amount={inr(0)} kind="total" explain={taxExplain(taxSrc(app))} /></Note>
      </Panel>
    );
  }
  if (app.taxAmount <= 0 && app.exercisePayment.utr && app.fmvValue > 0 && !app.taxRatePercent) {
    return (
      <Panel title="Tax on the perquisite">
        <Callout kind="warn" title="Your tax is being worked out by the ESOP team">
          <p>Your exercise payment is recorded. Your tax depends on your income for the year, which the ESOP team loads for each participant. Nothing is wrong with your application and you do not need to do anything — this step opens as soon as your tax is ready.</p>
        </Callout>
      </Panel>
    );
  }
  if (app.taxAmount <= 0) {
    return (
      <Panel title="Tax on the perquisite">
        <Callout kind="warn" title="Your tax is not fixed yet">
          <p>Record the exercise payment in step 3 first. The perquisite, and so the tax, depends on the fair market value of the trading day before you paid. <Link href="/employee/apply?step=exercise">Go to step 3</Link></p>
        </Callout>
      </Panel>
    );
  }

  const tx = app.tax;
  const pr = tx.partnerRequest;
  const prLive = !!pr && pr.status !== 'Declined' && pr.status !== 'Withdrawn';
  const committed = prLive || (tx.mode === 'Self' && tx.payments.length > 0);
  const settled = tx.remaining <= 0;
  const verified = app.review.taxPayment === 'Verified';
  const dueDate = prettyDate(app.taxDueDate);

  return (
    <Panel title="Tax on the perquisite" aside={inr(app.taxAmount) + ' due by ' + dueDate}>
      <LockNote lock={lock} />
      <SentBackNote app={app} section="taxPayment" />
      <Note title="How this figure is arrived at">
        <Line label={'FMV on ' + prettyDate(app.fmvDate)} amount={inr2(app.fmvValue)} explain={fmvExplain({ date: app.fmvDate, fmv: app.fmvValue }, 'Fixed by the date you paid the exercise amount.')} />
        <Line label="Shares" amount={count(app.totalShares)} />
        <Line label="Perquisite value" amount={inr(app.perquisiteAmount)} explain={perquisiteExplain({ fmv: app.fmvValue, shares: app.totalShares, exerciseAmount: app.exerciseAmount, perquisite: app.perquisiteAmount })} />
        <Line label={taxLabel(taxSrc(app))} amount={inr(app.taxAmount)} kind="total" explain={taxExplain(taxSrc(app))} />
        <Line label={inWords(app.taxAmount)} kind="words" />
      </Note>

      {pr && pr.status === 'Declined' ? (
        <Callout kind="warn" title={pr.partner + ' declined your request'}>
          {pr.remarks ? <p>{pr.remarks}</p> : null}
          <p>Nothing you entered has been lost. Choose a different partner below, or pay the tax yourself.</p>
        </Callout>
      ) : null}

      <h3 className="sub">How would you like the tax paid?</h3>
      {committed ? (
        <Callout kind={(tx.mode === 'Self' ? settled : pr && (pr.status === 'Payment Fed' || pr.status === 'Verified')) ? 'info' : 'plain'}
          title={'Your chosen route · ' + (tx.mode === 'Self' ? 'Paying it yourself' : 'Fund partner') + (pr && tx.mode !== 'Self' ? ' · ' + pr.status : '')}>
          <p>{tx.mode === 'Self'
            ? 'You are paying the tax of ' + inr(app.taxAmount) + ' yourself.'
            : (tx.fundPartnerName || 'A fund partner') + ' is funding your tax of ' + inr(app.taxAmount) + ', and the ' + count(app.totalShares) + ' shares from this exercise go to the demat account you hold with them.'}</p>
          <p>{tx.mode === 'Self'
            ? (tx.remaining > 0 ? 'Recorded so far: ' + inr(tx.paidTotal) + '. Outstanding: ' + inr(tx.remaining) + '.' : 'The full amount is recorded.')
            : pr && (pr.status === 'Payment Fed' || pr.status === 'Verified')
              ? 'The partner has recorded the payment' + (pr.utr ? ' under UTR ' + pr.utr : '') + '.'
              : pr && pr.status === 'Sent Back'
                ? 'The ESOP team has sent the partner’s payment back for correction. Nothing is needed from you.'
                : 'The request has been sent to them. They enter the demat account and the payment; you are emailed when they do.'}</p>
          <p className="hint">This choice is settled and cannot be changed here. If it has to change, write to the ESOP team — they send this section back to you, which releases it.</p>
        </Callout>
      ) : (
        <TaxModeForm
          appId={app.appId} rev={app.rev} locked={!!lock} mode={tx.mode} partnerId={tx.fundPartnerId} partners={d.fundPartners}
          taxAmount={app.taxAmount} totalShares={app.totalShares} dueDate={dueDate} next={next}
        />
      )}

      {tx.mode === 'Self' ? (
        <>
          <h3 className="sub">Your tax payments</h3>
          <div className="figures">
            <Figure label="Tax due" value={inr(tx.due)} sub={'by ' + dueDate} />
            <Figure label="Recorded" value={inr(tx.paidTotal)} sub={tx.payments.length + ' payment' + (tx.payments.length === 1 ? '' : 's')} kind="accent" />
            <Figure label="Still to pay" value={inr(tx.remaining)} sub={settled ? 'fully paid' : 'outstanding'} kind={settled ? 'accent' : 'crit'} />
          </div>
          {d.bankDetails.tax && !settled ? (
            <Callout kind="info" title={'Transfer ' + inr(tx.remaining) + ' by ' + dueDate}>
              <BankBox text={d.bankDetails.tax} />
              {d.paymentReference ? <p>Quote this reference: <b>{d.paymentReference}</b></p> : null}
            </Callout>
          ) : null}
          {tx.payments.length ? (
            <div className="tablewrap">
              <table className="data">
                <thead><tr><th scope="col">#</th><th scope="col">UTR</th><th scope="col">Date</th><th scope="col" className="n">Amount</th><th scope="col">Proof</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {tx.payments.map((p) => (
                    <tr key={p.paymentId}>
                      <td>{p.seq}</td>
                      <td className="mono">{p.utr}{p.bank ? <><br /><span className="tag">{p.bank}</span></> : null}</td>
                      <td className="nowrap">{prettyDate(p.date)}</td>
                      <td className="n">{inr(p.amount)}</td>
                      <td><FileLink file={p.proof} label="View" /></td>
                      <td>{lock || p.paidBy !== 'Self' || verified ? <span className="dim">—</span>
                        : <DeleteTaxPaymentButton appId={app.appId} rev={app.rev} paymentId={p.paymentId} label={'payment ' + p.seq + ' (' + inr(p.amount) + ')'} />}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><td colSpan={3}>Recorded so far</td><td className="n">{inr(tx.paidTotal)}</td><td colSpan={2} /></tr></tfoot>
              </table>
            </div>
          ) : <p className="empty">Nothing recorded yet.</p>}
          {!lock && !settled ? (
            <>
              <h3 className="sub">Record a payment</h3>
              <p className="hint">You can pay in instalments — record each transfer separately, with its own UTR and proof. The section completes once the total reaches {inr(tx.due)}.</p>
              <AddTaxPaymentForm appId={app.appId} rev={app.rev} remaining={tx.remaining} dueTotal={tx.due} today={d.today} next={next} />
            </>
          ) : null}
          {settled && !lock ? (
            <Callout kind="info" title="Tax fully recorded">
              <p>{inr(tx.paidTotal)} across {tx.payments.length} payment{tx.payments.length === 1 ? '' : 's'}. Next: <Link href={next.href}>sign the exercise notice</Link>.</p>
            </Callout>
          ) : null}
        </>
      ) : null}

      {tx.mode === 'FundPartner' && pr ? (
        <>
          <h3 className="sub">{pr.partner}</h3>
          <Callout kind={pr.status === 'Assigned' ? 'warn' : 'info'}
            title={pr.status === 'Assigned' ? 'Waiting for the partner to pay' : pr.status === 'Payment Fed' ? 'Partner has recorded the payment' : pr.status === 'Verified' ? 'Payment verified by the ESOP team' : pr.status}>
            <p>{pr.status === 'Assigned'
              ? pr.partner + ' has been notified of ' + inr(pr.amount) + ' due by ' + dueDate + '. You will be emailed as soon as they enter the payment details.'
              : 'UTR ' + (pr.utr || '—') + ', paid ' + (prettyDate(pr.date) || '—') + ', amount ' + inr(pr.paidAmount || pr.amount) + '.'}</p>
            {pr.remarks ? <p>{pr.remarks}</p> : null}
          </Callout>
        </>
      ) : null}
    </Panel>
  );
}

/* ---------------- 5 ---------------- */

async function NoticeStep({ userId, app, lock, next }: { userId: string; app: AppView | null; lock: string | null; next: { href: string; label: string } }) {
  if (!app || !app.lines.length) {
    return <Panel title="Exercise notice"><Callout kind="warn" title="The notice cannot be shown yet"><p>Record the options you wish to exercise before viewing the notice.</p></Callout></Panel>;
  }
  const n = await loadCurrentNotice(userId);
  const signed = !!app.notice.signedAt;
  return (
    <Panel title="Exercise notice" aside="Read it, then sign by typing your name">
      <SentBackNote app={app} section="notice" />
      {signed ? (
        <Callout kind="info" title="Signed">
          <p>Signed as <b>{app.notice.signatureName}</b> on {prettyStamp(app.notice.signedAt)}{app.notice.place ? ' at ' + app.notice.place : ''}. {app.notice.pdf ? <>A PDF copy is filed with your application: <FileLink file={app.notice.pdf} label="download the signed notice" />.</> : 'The PDF copy is being prepared; reload in a moment to download it.'}</p>
        </Callout>
      ) : null}
      {n ? <div className="noticebox" dangerouslySetInnerHTML={{ __html: n.html }} /> : null}
      {signed ? (
        <p className="row"><Link className="btn ghost" href={next.href}>{next.label}</Link></p>
      ) : lock ? <LockNote lock={lock} /> : (
        !app.progress.done.demat || !app.progress.done.exercise ? (
          <Callout kind="warn" title="Not ready to sign yet">
            <p>{!app.progress.done.demat
              ? 'Complete your applicant, demat and PAN details before signing — they appear in section A of the notice.'
              : 'Record the exercise payment before signing — the notice states the amount paid and its UTR.'}</p>
          </Callout>
        ) : <SignForm appId={app.appId} rev={app.rev} expectedName={n?.expectedName ?? app.employeeName} place={app.notice.place} next={next} />
      )}
    </Panel>
  );
}

/* ---------------- 6 ---------------- */

function SubmitStep({ app, lock }: { app: AppView | null; lock: string | null }) {
  if (!app) return <NeedApp />;
  const already = app.status === 'Submitted' || app.status === 'Under Review' || app.status === 'Approved';
  const tsrc = taxSrc(app);
  return (
    <Panel title="Submit for verification" aside={app.appId}>
      <div className="grid2">
        <div>
          <table className="data">
            <thead><tr><th scope="col">Section</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {STAGES.filter((s) => s.key !== 'submit').map((s) => {
                const back = stageSentBack(app.review, s.key);
                const done = !!app.progress.done[s.key] && !back;
                return (
                  <tr key={s.key}>
                    <td><Link href={'/employee/apply?step=' + s.key}>{s.label}</Link></td>
                    <td>{back ? <Pill kind="bad">Sent back — please correct</Pill> : done ? <Pill kind="ok">Complete</Pill> : <Pill kind="wait">Outstanding</Pill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {already ? (
            <Callout kind="info" title="Already submitted"><p>Submitted on {prettyStamp(app.submittedAt)}. The ESOP team will email you once it is verified.</p></Callout>
          ) : app.progress.complete ? (
            lock ? <LockNote lock={lock} /> : (
              <>
                <Callout kind="info" title="Everything is in place">
                  <p>Submitting locks the application for verification. If the team needs a correction, it comes back to you with remarks.</p>
                </Callout>
                <SubmitForm appId={app.appId} rev={app.rev} />
              </>
            )
          ) : (
            <Callout kind="warn" title="Still to finish"><p>{app.progress.pendingLabels.join(', ')}.</p></Callout>
          )}
        </div>
        <Note title="Application summary" sub={app.windowLabel + ' · ' + app.appId}
          foot={'Shares to demat ' + (app.demat.dpId || '—') + ' / ' + (app.demat.clientId || '—')}>
          <Line label="Options exercised" amount={count(app.totalOptions)} />
          <Line label="Equity shares" amount={count(app.totalShares)} />
          <Line label="Exercise amount paid" amount={inr(app.exerciseAmount)} kind="out" />
          <Line label={'FMV, ' + (prettyDate(app.fmvDate) || '—')} amount={app.fmvValue ? inr2(app.fmvValue) : '—'} />
          <Line label="Perquisite value" amount={inr(app.perquisiteAmount)} />
          <Line label={taxLabel(tsrc)} amount={inr(app.taxAmount)} kind="out" explain={taxExplain(tsrc)} />
          <Line label={app.tax.mode === 'FundPartner' ? 'via ' + app.tax.fundPartnerName : 'paid directly'} kind="sub" amount="" />
          <Line label="Total cash committed" amount={inr(app.exerciseAmount + app.taxAmount)} kind="total" />
          <Line label={inWords(app.exerciseAmount + app.taxAmount)} kind="words" />
        </Note>
      </div>
    </Panel>
  );
}
