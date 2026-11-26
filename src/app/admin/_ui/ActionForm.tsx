'use client';

import type { ReactNode } from 'react';
import { Result } from '@/components/Result';
import { useFormAction, type FormResult } from '@/components/useFormAction';
import type { AdminResult, IssuedCodeView } from '../shared';

type Action = (prev: FormResult, form: FormData) => Promise<FormResult>;

/**
 * A form posting to an admin server action, with the outcome announced under
 * it. Fields are disabled while the action runs; a refused save keeps what
 * was typed. `confirm` asks before submitting (for decisions that email the
 * participant or cannot be undone).
 */
export function ActionForm({ action, children, confirm, className, id }: {
  action: Action; children: ReactNode; confirm?: string; className?: string; id?: string;
}) {
  const { state, pending, onSubmit } = useFormAction(action);
  return (
    <form
      id={id}
      className={className}
      aria-busy={pending}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) { e.preventDefault(); return; }
        onSubmit(e);
      }}
    >
      <fieldset className="plain" disabled={pending}>{children}</fieldset>
      {pending ? <p className="hint" role="status">Working…</p> : null}
      <Result state={state} />
      <ResultData data={(state as AdminResult).data} />
    </form>
  );
}

/** Lists that come back with a bulk action: rows skipped, warnings, codes to hand on. */
export function ResultData({ data }: { data: unknown }) {
  if (!data || typeof data !== 'object') return null;
  const d = data as { skipped?: string[]; warnings?: string[]; issued?: IssuedCodeView[] };
  return (
    <>
      {d.issued?.length ? <Codes issued={d.issued} /> : null}
      {d.skipped?.length ? <NoteList title={'Skipped (' + d.skipped.length + ')'} items={d.skipped} /> : null}
      {d.warnings?.length ? <NoteList title={'Warnings (' + d.warnings.length + ')'} items={d.warnings} /> : null}
    </>
  );
}

export function NoteList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="callout warn notelist">
      <h4>{title}</h4>
      <ul>{items.slice(0, 500).map((x, i) => <li key={i}>{x}</li>)}</ul>
      {items.length > 500 ? <p>… and {items.length - 500} more.</p> : null}
    </div>
  );
}

/**
 * One-time codes that were not emailed. They are single-use, expire, and are
 * never stored readable — this is the only time they can be read.
 */
export function Codes({ issued }: { issued: IssuedCodeView[] }) {
  const shown = issued.filter((x) => x.code);
  const emailed = issued.filter((x) => x.emailed);
  return (
    <div className="callout info">
      {emailed.length ? <p>{emailed.length} code(s) emailed: {emailed.map((x) => x.userId).join(', ')}.</p> : null}
      {shown.length ? (
        <>
          <h4>One-time codes — shown once</h4>
          <p>Pass each on yourself. They are single-use and expire in {shown[0].expiresInMinutes} minutes; after that, issue a
            new one or the person uses “Set or reset password” on the sign-in screen. They sign in with their user ID or email,
            then this code, then choose a password.</p>
          <div className="tablewrap">
            <table className="data compact">
              <thead><tr><th scope="col">User ID</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Code</th></tr></thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.userId}><td className="mono">{x.userId}</td><td>{x.name}</td><td>{x.email}</td><td className="mono code">{x.code}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
