import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/app/actions/auth';
import { requireRole } from '@/lib/auth/session';

export default async function EmployeeLayout({ children }: { children: ReactNode }) {
  const { user } = await requireRole('Employee');
  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <Link href="/employee" className="brand">ESOP Exercise Portal</Link>
          <nav className="topnav" aria-label="Account">
            <span className="who">{user.name || user.userId}</span>
            <form action={signOut}><button className="btn link">Sign out</button></form>
          </nav>
        </div>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
