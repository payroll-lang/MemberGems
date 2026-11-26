import Link from 'next/link';
import { count, inr, inr2, inWords, prettyDate, prettyStamp } from '@/domain';
import { latestFmvExplain, type CalcSpec, type Step } from '@/components/calc';
import { Callout, Figure, Line, Note, Panel, Pill, StatusPill } from '@/components/ui';
import { requireRole } from '@/lib/auth/session';
import { UserError } from '@/server/errors';
import { loadDashboard, type Dashboard } from '@/server/participant/dashboard';

export const metadata = { title: 'Your options · ESOP Exercise Portal' };

export default async function EmployeeDashboard() {
  const { user } = await requireRole('Employee');
  let d: Dashboard;
  try {
    d = await loadDashboard(user.userId);
  } catch (e) {
    if (e instanceof UserError) return <Callout kind="crit" title="Your record is not available"><p>{e.message}</p></Callout>;
    throw e;
  }
  const t = d.totals;
  const fmv = d.latestFmv;
  const app = d.application;
  const lotted = d.grants.some((g) => g.step > 1);

  const exercisableCalc: CalcSpec = {
    title: 'Exercisable now',
    formula: 'per grant: vested options, less anything already exercised or committed, rounded down to the plan’s lot where it has one',
    steps: [...d.grants.map((g): Step => [(g.planName || g.grantId) + ' · ' + count(g.availableOptions) + ' available', count(g.exercisableOptions)]),
      ['Exercisable now', count(t.exercisable), 'total']],
    result: count(t.exercisable) + ' options',
    notes: [t.stranded
      ? 'Where a plan has a lot of ' + d.lotSize + ', a balance that is not a whole multiple of it cannot be exercised — ' + count(t.stranded) + ' of your options sit under a full lot and stay vested for a later window.'
      : 'Plans with a lot are exercised in whole multiples of ' + d.lotSize + '; one-for-one plans in any whole number.'],
  };
  const sharesCalc: CalcSpec = {
    title: 'Shares you would receive',
    formula: 'shares = options × the conversion multiplier of the grant',
    steps: [...d.grants.map((g): Step => [(g.planName || g.grantId) + ' · ' + count(g.exercisableOptions) + ' × ' + g.multiplier, count(g.exercisableShares)]),
      ['Total shares', count(t.exercisableShares), 'total']],
    result: count(t.exercisableShares) + ' equity shares',
    notes: ['The multiplier belongs to the plan, not to you — ESOP Plan 2022 grants convert at 3.6 shares per option, ESOP Plan 2025 at 1.'],
  };
  const gainCalc: CalcSpec = {
    title: 'Indicative gain',
    formula: 'per grant: (shares × latest FMV) − (options × exercise price), then added up',
    steps: [...d.grants.map((g): Step => [(g.planName || g.grantId) + ' · ' + count(g.exercisableOptions) + ' options → ' + count(g.exercisableShares) + ' shares',
      fmv ? inr(Math.max(0, g.exercisableShares * fmv.fmv - g.exercisableOptions * g.exercisePrice)) : '—']),
      ['Indicative gain', fmv ? inr(d.indicativeGain) : '—', 'total']],
    result: fmv ? inr(d.indicativeGain) : '',
    resultWords: fmv ? inWords(d.indicativeGain) : '',
    notes: ['A rough guide only, and before tax. It counts only the options you could exercise right now, it uses the latest share price on record rather than the one that will apply to you, and each grant is valued separately because the conversion multiplier differs by plan. Your real figure is set by the trading day before you pay the exercise amount.'],
  };

  return (
    <div className="stack">
      <div className="spread">
        <div>
          <div className="eyebrow">
            {d.employee.employeeId}
            {d.employee.employmentStatus !== 'Active' ? ' · ' + d.employee.employmentStatus + (d.employee.prettySeparationDate ? ' ' + d.employee.prettySeparationDate : '') : ''}
          </div>
          <h1 className="title">{d.employee.name || 'Participant'}</h1>
          <p className="lede">
            {d.window.label} exercise window ·{' '}
            {d.window.isOpen
              ? <><Pill kind="ok">Open</Pill> until {prettyDate(d.window.closeDate)}</>
              : <><Pill kind="bad">Closed</Pill> {d.window.reason}</>}
          </p>
        </div>
        {fmv ? (
          <div className="price-note">
            <Note title="Latest share price on record">
              <Line label="Opening" amount={fmv.open ? inr2(fmv.open) : '—'} />
              <Line label="Closing" amount={fmv.close ? inr2(fmv.close) : '—'} />
              <Line label={'FMV, ' + fmv.prettyDate} amount={inr2(fmv.fmv)} kind="total" explain={latestFmvExplain(fmv)} />
            </Note>
          </div>
        ) : null}
      </div>

      <div className="figures">
        <Figure label="Options granted" value={count(t.granted)} sub={'across ' + d.grants.length + ' grant' + (d.grants.length === 1 ? '' : 's')} />
        <Figure label="Vested" value={count(t.vested)} sub={t.unvested ? count(t.unvested) + ' still to vest' : 'fully vested'} kind="accent" />
        <Figure label="Exercisable now" value={count(t.exercisable)} kind="accent" explain={exercisableCalc}
          sub={(lotted ? 'in multiples of ' + d.lotSize + ' where a lot applies' : 'any whole number') + (t.stranded ? ' · ' + count(t.stranded) + ' under a lot' : '')} />
        <Figure label="Shares you would receive" value={count(t.exercisableShares)} sub="on exercising the full exercisable balance" explain={sharesCalc} />
        <Figure label="Indicative gain" value={fmv ? inr(d.indicativeGain) : '—'} sub={fmv ? 'at ' + inr2(fmv.fmv) + ' on ' + fmv.prettyDate : 'no share price on record'} explain={fmv ? gainCalc : undefined} />
      </div>

      <StateCallout d={d} />

      {app ? <CurrentApplication d={d} /> : null}
      {!app && t.exercisable > 0 && d.window.isOpen && !d.blocked ? (
        <Panel title={'Exercise your options in the ' + d.window.label + ' window'}>
          <p>You have {count(t.exercisable)} options available to exercise. The application has six steps, and each one can be saved and finished later.</p>
          <div className="row"><Link className="btn" href="/employee/apply">Start an application</Link></div>
        </Panel>
      ) : null}
      {!app && t.exercisable <= 0 ? <WhyNoSteps d={d} /> : null}

      <GrantsPanel d={d} />
      <History d={d} />
    </div>
  );
}

function StateCallout({ d }: { d: Dashboard }) {
  const app = d.application;
  if (d.blocked) {
    return (
      <Callout kind="crit" title="You cannot exercise at the moment">
        <p>{d.blockedReason}</p>
        <p>Your grants and balances below are unaffected. Contact the ESOP team if you believe this is a mistake.</p>
      </Callout>
    );
  }
  if (!d.window.isOpen) {
    return (
      <Callout kind="warn" title="The window is closed">
        <p>{d.window.reason} You can look at your grants and past applications, but nothing can be entered or changed until the next window opens.</p>
      </Callout>
    );
  }
  if (app && app.status === 'Sent Back') {
    const back = (['options', 'demat', 'exercisePayment', 'taxPayment', 'notice'] as const).filter((k) => app.review[k] === 'Sent Back');
    const names: Record<string, string> = { options: 'Options to exercise', demat: 'Applicant, demat & PAN', exercisePayment: 'Exercise payment', taxPayment: 'Tax payment', notice: 'Exercise notice' };
    return (
      <Callout kind="warn" title="The ESOP team has asked for a correction">
        <p>{back.length ? <>Please correct: <b>{back.map((k) => names[k]).join(', ')}</b> — marked in the steps. </> : 'Fix the section noted below. '}Then submit again. Nothing else you entered has been lost.</p>
        {app.review.remarks.length ? (
          <ul className="remarks">{app.review.remarks.map((r, i) => <li key={i}>{r.section ? <b>{names[r.section]}: </b> : null}{r.text}</li>)}</ul>
        ) : null}
      </Callout>
    );
  }
  if (app && app.status === 'Approved') {
    return (
      <Callout kind="info" title="Approved">
        <p>Your {app.windowLabel} exercise of {count(app.totalOptions)} options ({count(app.totalShares)} shares) has been verified and approved. They will be credited to demat account {app.demat.dpId} / {app.demat.clientId}.</p>
        {d.canStartAnother ? (
          <>
            <p>You still have {count(d.totals.exercisable)} options available. Since this application is approved, you can start another in the {d.window.label} window. Nothing is created until you save your options in step 1.</p>
            <div className="row"><Link className="btn" href="/employee/apply?new=1">Start another application</Link></div>
          </>
        ) : null}
      </Callout>
    );
  }
  if (app && app.status === 'Rejected') {
    return (
      <Callout kind="warn" title={'Application ' + app.appId + ' was closed without processing'}>
        <p>The options it held are back in your available balance.{d.canStartAnother ? ' You can start a new application in the ' + d.window.label + ' window.' : ''}</p>
        {d.canStartAnother ? <div className="row"><Link className="btn" href="/employee/apply?new=1">Start a new application</Link></div> : null}
      </Callout>
    );
  }
  if (app && (app.status === 'Submitted' || app.status === 'Under Review')) {
    return (
      <Callout kind="info" title="With the ESOP team">
        <p>Application {app.appId} was submitted on {prettyStamp(app.submittedAt)} and is being verified. You will be emailed once it is approved, or if something needs correcting.</p>
      </Callout>
    );
  }
  if (d.totals.exercisable <= 0 && !app) {
    return (
      <Callout kind="warn" title="No options available to exercise">
        <p>Nothing on your record is vested and unexercised right now. If you believe that is wrong, write to the ESOP team.</p>
      </Callout>
    );
  }
  return null;
}

function CurrentApplication({ d }: { d: Dashboard }) {
  const app = d.application!;
  const p = app.progress;
  const editable = app.editable && d.window.isOpen && !d.blocked;
  return (
    <Panel title={'Application ' + app.appId} aside={<StatusPill status={app.status} />}>
      <div className="grid2">
        <div>
          <p className="lede">{count(app.totalOptions)} options → {count(app.totalShares)} shares · exercise amount {inr(app.exerciseAmount)}{app.fmvValue ? ' · tax ' + inr(app.taxAmount) : ''}</p>
          {app.editable ? (
            p.complete
              ? <p>Every section is complete. {app.status === 'Sent Back' || app.status === 'Draft' ? 'Submit it in step 6.' : ''}</p>
              : <p>Still to finish: {p.pendingLabels.join(', ')}.</p>
          ) : null}
        </div>
        <div className="row end">
          {editable
            ? <Link className="btn" href={'/employee/apply?step=' + p.stage}>Continue the application</Link>
            : <Link className="btn ghost" href={'/employee/applications/' + encodeURIComponent(app.appId)}>View the application</Link>}
        </div>
      </div>
    </Panel>
  );
}

function WhyNoSteps({ d }: { d: Dashboard }) {
  const t = d.totals;
  let reason: string, detail: string;
  if (!d.grants.length) {
    reason = 'No option grants are on your record';
    detail = 'If you believe you hold options under the plan, contact the ESOP team — it may be that your grant has not been loaded yet, or is recorded under a different employee code.';
  } else if (t.vested <= 0) {
    reason = 'None of your options have vested yet';
    detail = 'You hold ' + count(t.granted) + ' options, all still to vest. The vesting dates are in the tranche breakdown against each grant below. You will be able to exercise in the first window after a tranche vests.';
  } else if (t.available <= 0) {
    reason = 'Your vested options are already accounted for';
    detail = 'They have been exercised, or are committed to an application already in progress. Your past applications are listed below.';
  } else {
    reason = 'Your available balance is below one lot';
    detail = 'Options are exercised in multiples of ' + d.lotSize + (d.lotScope === 'total' ? ' across your grants' : ' on each grant') + ', and you have ' +
      count(t.available) + ' available. The balance stays vested — it does not expire at the end of this window — and becomes exercisable once a further tranche vests and brings it to a whole lot.';
  }
  return (
    <Panel title={reason}>
      <p className="lede">{detail}</p>
      {d.window.isOpen ? <p className="hint">The {d.window.label} window is open until {prettyDate(d.window.closeDate)}, so nothing here is time-critical for you.</p> : null}
      {d.supportEmail ? <p className="hint">Questions: <a href={'mailto:' + d.supportEmail}>{d.supportEmail}</a></p> : null}
    </Panel>
  );
}

type Tr = { id?: string; vd?: string; v?: number; u?: number; e?: number };

function GrantsPanel({ d }: { d: Dashboard }) {
  if (!d.grants.length) return <Panel><p className="empty">No grants are on your record. Contact the ESOP team.</p></Panel>;
  const anyMultiplier = d.grants.some((g) => Math.abs(g.multiplier - 1) > 1e-9);
  const anyStranded = d.grants.some((g) => g.availableOptions > g.exercisableOptions);
  const held = d.grants.filter((g) => g.pledgedElsewhere > 0);
  const firstMulti = d.grants.find((g) => g.multiplier !== 1);
  return (
    <Panel title="Your grants" aside={'Rolled up from the vesting register' + (d.grants[0]?.reportAsOn ? ', as on ' + prettyDate(d.grants[0].reportAsOn) : '')}>
      <div className="tablewrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Grant</th><th scope="col">Granted</th><th scope="col" className="n">Total</th><th scope="col" className="n">Vested</th>
              <th scope="col" className="n">Unvested</th><th scope="col" className="n">Exercisable</th>
              {anyMultiplier ? <th scope="col" className="n">Conversion</th> : null}
              <th scope="col" className="n">Shares</th>
            </tr>
          </thead>
          <tbody>
            {d.grants.map((g) => {
              const stranded = g.availableOptions - g.exercisableOptions;
              return (
                <tr key={g.grantId}>
                  <td><span className="mono">{g.grantId}</span><br /><span className="tag">{g.planName}</span></td>
                  <td className="nowrap">{g.prettyGrantDate}</td>
                  <td className="n">{count(g.totalGranted)}</td>
                  <td className="n">{count(g.vestedOptions)}</td>
                  <td className="n">{g.unvestedOptions ? count(g.unvestedOptions) : '—'}{g.prettyNextVestDate ? <><br /><span className="tag">next {g.prettyNextVestDate}</span></> : null}</td>
                  <td className="n"><b>{count(g.exercisableOptions)}</b>
                    {g.pledgedElsewhere ? <><br /><span className="tag">{count(g.pledgedElsewhere)} committed</span></> : null}
                    {stranded > 0 ? <><br /><span className="tag">{count(stranded)} under a lot</span></> : null}</td>
                  {anyMultiplier ? <td className="n">× {g.multiplier}</td> : null}
                  <td className="n"><b>{count(g.exercisableShares)}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="sub">Vesting tranches</h3>
      {d.grants.map((g) => {
        const tranches = (g.tranches as Tr[]) ?? [];
        return (
          <details key={g.grantId} className="tranches">
            <summary>
              <span className="mono">{g.grantId}</span> · {g.planName} · {tranches.length ? g.vestedTrancheCount + ' of ' + g.trancheCount + ' tranches vested' : 'no tranche detail'}
            </summary>
            <p className="hint">Granted {g.prettyGrantDate} · {g.typeOfVesting || 'time-based'}{Math.abs(g.multiplier - 1) > 1e-9 ? ' · 1 option = ' + g.multiplier + ' shares' : ''}. Vested {count(g.vestedOptions)} options → {count(g.vestedShares)} shares; unvested {count(g.unvestedOptions)}{g.prettyNextVestDate ? ', next tranche ' + g.prettyNextVestDate : ''}; exercisable now <b>{count(g.exercisableOptions)} → {count(g.exercisableShares)} shares</b>.</p>
            {tranches.length ? (
              <div className="tablewrap">
                <table className="data compact">
                  <thead><tr><th scope="col">Tranche</th><th scope="col">Vest date</th><th scope="col" className="n">Vested</th><th scope="col" className="n">Unvested</th><th scope="col" className="n">Exercised</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {tranches.map((tr, i) => (
                      <tr key={i} className={(tr.v ?? 0) > 0 || (tr.e ?? 0) > 0 ? '' : 'dim'}>
                        <td className="mono">{tr.id || '—'}</td>
                        <td className="nowrap">{prettyDate(tr.vd) || '—'}</td>
                        <td className="n">{tr.v ? count(tr.v) : '—'}</td>
                        <td className="n">{tr.u ? count(tr.u) : '—'}</td>
                        <td className="n">{tr.e ? count(tr.e) : '—'}</td>
                        <td>{(tr.v ?? 0) > 0 ? <Pill kind="ok">Vested</Pill> : (tr.u ?? 0) > 0 ? <Pill kind="wait">Unvested</Pill> : <Pill kind="neutral">Settled</Pill>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </details>
        );
      })}
      <p className="hint">Tranche figures come from the vesting register. You choose how many options to exercise at grant level — the portal draws from the vested balance as a whole.</p>

      {firstMulti ? (
        <Callout kind="info" title="Options are not the same as shares">
          <p>Under {firstMulti.planName}, one option converts to {firstMulti.multiplier} equity shares. You pay {inr2(d.exercisePrice)} per <b>option</b>, and the fair market value applies to each <b>share</b> you receive — which is what makes the perquisite what it is.</p>
        </Callout>
      ) : null}
      {anyStranded ? (
        <Callout kind="warn" title="Some options are below one lot">
          <p>Options are exercised in multiples of {d.lotSize}{d.lotScope === 'total' ? ' across your grants' : ' on each grant'}. Anything left over stays vested and can be exercised in a later window once the balance reaches a whole lot.</p>
        </Callout>
      ) : null}
      {held.length ? (
        <Callout kind="info" title={count(held.reduce((a, g) => a + g.pledgedElsewhere, 0)) + ' of your vested options are committed to another application'}>
          <p>They are held against {held.map((g) => count(g.pledgedElsewhere) + ' on ' + g.grantId).join(', ')}, so they are not counted as exercisable here. If that application is rejected the options come straight back; once the vesting report catches up with an approved one, they drop out of your vested balance instead.</p>
        </Callout>
      ) : null}
    </Panel>
  );
}

function History({ d }: { d: Dashboard }) {
  if (!d.history.length) return null;
  return (
    <Panel title="Your applications" aside="Open any row for the full summary">
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th scope="col">Reference</th><th scope="col">Window</th><th scope="col" className="n">Options</th><th scope="col" className="n">Exercise</th><th scope="col" className="n">Tax</th><th scope="col">Status</th><th scope="col">Last activity</th></tr></thead>
          <tbody>
            {d.history.map((a) => (
              <tr key={a.appId}>
                <td className="mono"><Link href={'/employee/applications/' + encodeURIComponent(a.appId)}>{a.appId}</Link></td>
                <td>{a.windowId}</td>
                <td className="n">{count(a.totalOptions)}</td>
                <td className="n">{inr(a.exerciseAmount)}</td>
                <td className="n">{inr(a.taxAmount)}</td>
                <td><StatusPill status={a.status} /></td>
                <td className="dim">{prettyStamp(a.submittedAt || a.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

