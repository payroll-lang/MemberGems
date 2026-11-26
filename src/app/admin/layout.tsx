import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/app/actions/auth';
import { requireRole } from '@/lib/auth/session';
import { AdminNav } from './_ui/Nav';

export const metadata = { title: 'ESOP team · ESOP Exercise Portal' };

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requireRole('Admin');
  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <Link href="/admin" className="brand" prefetch={false}>ESOP Exercise Portal · ESOP team</Link>
          <nav className="topnav" aria-label="Account">
            <span className="who">{user.name || user.userId}</span>
            <form action={signOut}><button className="btn link">Sign out</button></form>
          </nav>
        </div>
        <div className="topbar-in"><AdminNav /></div>
      </header>
      <main className="page wide">{children}</main>
    </>
  );
}
