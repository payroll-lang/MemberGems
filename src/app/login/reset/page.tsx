import { ResetForms } from '../forms';

export default function ResetPage() {
  return (
    <main className="auth-wrap">
      <section className="card">
        <h1>Set or reset password</h1>
        <p className="muted small">We email a one-time code to the address the ESOP team holds for you.</p>
        <ResetForms />
      </section>
    </main>
  );
}
