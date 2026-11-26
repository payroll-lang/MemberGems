'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { requestCode, setPassword, signIn, type FormState } from '../actions/auth';

function Alert({ state }: { state: FormState }) {
  if (state.error) return <p className="alert error" role="alert">{state.error}</p>;
  if (state.message) return <p className="alert ok" role="status">{state.message}</p>;
  return null;
}

export function SignInForm() {
  const [state, action, pending] = useActionState(signIn, {});
  return (
    <form action={action}>
      <label htmlFor="identifier">Employee code or email</label>
      <input id="identifier" name="identifier" type="text" autoComplete="username" required autoFocus />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      <button className="btn" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      <Alert state={state} />
      <p className="small muted" style={{ marginTop: 16 }}>
        First time here, or forgot your password? <Link href="/login/reset">Set or reset your password</Link>
      </p>
    </form>
  );
}

export function ResetForms() {
  const [codeState, codeAction, codePending] = useActionState(requestCode, {});
  const [setState, setAction, setPending] = useActionState(setPassword, {});
  return (
    <>
      <form action={codeAction}>
        <h2 style={{ fontSize: 18, margin: '18px 0 0' }}>1. Get a one-time code</h2>
        <label htmlFor="rc-identifier">Employee code or email</label>
        <input id="rc-identifier" name="identifier" type="text" autoComplete="username" required />
        <button className="btn ghost" disabled={codePending}>{codePending ? 'Sending…' : 'Email me a code'}</button>
        <Alert state={codeState} />
      </form>
      <form action={setAction}>
        <h2 style={{ fontSize: 18, margin: '26px 0 0' }}>2. Set your password</h2>
        <label htmlFor="sp-identifier">Employee code or email</label>
        <input id="sp-identifier" name="identifier" type="text" autoComplete="username" required />
        <label htmlFor="code">6-digit code</label>
        <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required />
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
        <label htmlFor="confirm">Repeat new password</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={8} />
        <p className="small muted">At least 8 characters, with a letter and a digit.</p>
        <button className="btn" disabled={setPending}>{setPending ? 'Saving…' : 'Set password and sign in'}</button>
        <Alert state={setState} />
      </form>
      <p className="small muted" style={{ marginTop: 16 }}><Link href="/login">Back to sign in</Link></p>
    </>
  );
}
