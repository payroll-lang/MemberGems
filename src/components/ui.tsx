/**
 * Small presentational pieces shared by every portal screen. No hooks, so
 * they render in Server and Client Components alike.
 */
import type { ReactNode } from 'react';
import type { CalcSpec } from './calc';

export function Callout({ kind = 'plain', title, children }: { kind?: 'plain' | 'info' | 'warn' | 'crit'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={'callout ' + kind} role={kind === 'crit' ? 'alert' : undefined}>
      {title ? <h4>{title}</h4> : null}
      {children}
    </div>
  );
}

const STATUS_PILL: Record<string, string> = {
  Draft: 'neutral', Submitted: 'wait', 'Under Review': 'wait', 'Sent Back': 'bad', Approved: 'ok', Rejected: 'bad',
  Pending: 'wait', Verified: 'ok', Assigned: 'wait', 'Payment Fed': 'ok', Declined: 'bad', Withdrawn: 'neutral',
};

export function Pill({ kind, children }: { kind: 'ok' | 'wait' | 'bad' | 'neutral'; children: ReactNode }) {
  return <span className={'pill ' + kind}>{children}</span>;
}

export function StatusPill({ status }: { status: string }) {
  return <Pill kind={(STATUS_PILL[status] ?? 'neutral') as 'ok'}>{status}</Pill>;
}

export function Figure({ label, value, sub, kind, explain }: { label: string; value: ReactNode; sub?: ReactNode; kind?: 'accent' | 'warn' | 'crit'; explain?: CalcSpec }) {
  return (
    <div className={'fig' + (kind ? ' ' + kind : '')}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub ? <div className="s">{sub}</div> : null}
      {explain ? <Explain spec={explain} label={label} /> : null}
    </div>
  );
}

/** The ⓘ disclosure: the arithmetic behind a figure, with the actual values used. Works without JavaScript. */
export function Explain({ spec, label }: { spec: CalcSpec; label?: string }) {
  return (
    <details className="explain">
      <summary aria-label={'How ' + (label ?? spec.title) + ' is worked out'}>
        <span className="ibtn" aria-hidden="true">i</span>
        <span className="explain-cue">How this was worked out</span>
      </summary>
      <ExplainBody spec={spec} />
    </details>
  );
}

function Steps({ steps }: { steps: NonNullable<CalcSpec['steps']> }) {
  return (
    <div className="lines">
      {steps.map(([lbl, val, cls], i) => (
        <div key={i} className={'line' + (cls ? ' ' + cls : '')}>
          <span className="lbl">{lbl}</span><span className="lead" /><span className="amt">{val}</span>
        </div>
      ))}
    </div>
  );
}

export function ExplainBody({ spec }: { spec: CalcSpec }) {
  return (
    <div className="explain-body">
      <h4>{spec.title}</h4>
      {spec.formula ? <div className="formula">{spec.formula}</div> : null}
      {(spec.sections ?? []).map((s, i) => (
        <div key={i} className="explain-sec">
          <h5>{s.heading}</h5>
          {s.text ? <p className="hint">{s.text}</p> : null}
          <Steps steps={s.steps} />
        </div>
      ))}
      {spec.steps?.length ? (<><h5>With your figures</h5><Steps steps={spec.steps} /></>) : null}
      {spec.result ? (
        <p className="explain-result"><b>{spec.result}</b>{spec.resultWords ? <><br /><span className="words">{spec.resultWords}</span></> : null}</p>
      ) : null}
      {(spec.notes ?? []).map((n, i) => <p key={i} className="hint">{n}</p>)}
    </div>
  );
}

/** One row of a ruled summary ("Exercise amount ....... ₹1,000"), optionally explained. */
export function Line({ label, amount, kind, explain }: { label: ReactNode; amount?: ReactNode; kind?: 'total' | 'out' | 'sub' | 'words'; explain?: CalcSpec }) {
  return (
    <>
      <div className={'line' + (kind ? ' ' + kind : '')}>
        <span className="lbl">{label}</span>
        {kind === 'words' ? null : <><span className="lead" /><span className="amt">{amount}</span></>}
      </div>
      {explain ? <Explain spec={explain} label={typeof label === 'string' ? label : undefined} /> : null}
    </>
  );
}

export function Note({ title, sub, children, foot }: { title: ReactNode; sub?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="note">
      <div className="engrave" />
      <h3>{title}</h3>
      {sub ? <div className="subh">{sub}</div> : null}
      <div className="lines">{children}</div>
      {foot ? <div className="notefoot">{foot}</div> : null}
    </div>
  );
}

export function Panel({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      {title ? <div className="panel-hd"><h2 className="sec">{title}</h2>{aside ? <span className="dim">{aside}</span> : null}</div> : null}
      <div className="panel-bd">{children}</div>
    </section>
  );
}

export function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (<div key={i} className="kv-row"><dt>{k}</dt><dd>{v}</dd></div>))}
    </dl>
  );
}

export function FileLink({ file, label }: { file: { fileId: string; name: string; sizeKb: number } | null; label?: string }) {
  if (!file) return <Pill kind="wait">Not uploaded</Pill>;
  return (
    <span>
      <Pill kind="ok">On file</Pill>{' '}
      <a href={'/api/files/' + encodeURIComponent(file.fileId) + '?inline=1'} target="_blank" rel="noopener noreferrer">
        {label ?? file.name}
      </a>{' '}
      <span className="dim">({file.sizeKb} KB)</span>
    </span>
  );
}

export function BankBox({ text }: { text: string }) {
  return <div className="bankbox">{text}</div>;
}
