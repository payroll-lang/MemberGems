import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/app/actions/auth';
import { requireRole } from '@/lib/auth/session';

export default async function PartnerLayout({ children }: { children: ReactNode }) {
  const { user } = await requireRole('FundPartner');
  return (
    <>
      <header className="topbar">
        <div className="topbar-in">
          <Link href="/partner" className="brand">ESOP Exercise Portal</Link>
          <nav className="topnav" aria-label="Account">
            <span className="who">{user.name || user.userId}{user.fundPartnerName ? ' · ' + user.fundPartnerName : ''}</span>
            <form action={signOut}><button className="btn link">Sign out</button></form>
          </nav>
        </div>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
