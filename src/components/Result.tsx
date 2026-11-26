import Link from 'next/link';
import type { FormResult } from './useFormAction';

/** The outcome of a save, announced to screen readers. */
export function Result({ state, next }: { state: FormResult; next?: { href: string; label: string } }) {
  if (state.error) {
    return (
      <div className="alert error" role="alert" key={state.at}>
        {state.error.split('\n').map((l, i) => <div key={i}>{l}</div>)}
      </div>
    );
  }
  if (state.message) {
    return (
      <div className="alert ok" role="status" key={state.at}>
        {state.message}
        {next ? <> <Link href={next.href}>{next.label} →</Link></> : null}
      </div>
    );
  }
  return null;
}
