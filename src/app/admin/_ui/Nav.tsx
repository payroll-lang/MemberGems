'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS: [string, string][] = [
  ['/admin', 'Queue'],
  ['/admin/participants', 'Participants'],
  ['/admin/grants', 'Grant report'],
  ['/admin/tax', 'Tax sheet'],
  ['/admin/prices', 'Share price'],
  ['/admin/windows', 'Windows'],
  ['/admin/logins', 'Logins'],
  ['/admin/partners', 'Fund partners'],
  ['/admin/settings', 'Settings'],
  ['/admin/export', 'Export'],
  ['/admin/audit', 'Audit log'],
];

export function AdminNav() {
  const path = usePathname();
  return (
    <nav className="adminnav" aria-label="ESOP team">
      {ITEMS.map(([href, label]) => {
        const current = href === '/admin' ? path === '/admin' || path.startsWith('/admin/applications') : path.startsWith(href);
        return <Link key={href} href={href} prefetch={false} aria-current={current ? 'page' : undefined}>{label}</Link>;
      })}
    </nav>
  );
}
