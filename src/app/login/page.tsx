import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { SignInForm } from './forms';

export default async function LoginPage() {
  if (await getSession()) redirect('/');
  return (
    <main className="auth-wrap">
      <section className="card">
        <h1>ESOP Exercise Portal</h1>
        <p className="muted small">Physicswallah Limited · PW Employee Stock Option Plan</p>
        <SignInForm />
      </section>
    </main>
  );
}
