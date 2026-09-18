'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/operations/documents', label: 'Document cases' },
  { href: '/operations/inventory', label: 'Inventory opportunities' },
  { href: '/operations/orders', label: 'Orders' },
];

export function OpsNav() {
  const pathname = usePathname();
  return (
    <nav className="subnav" aria-label="Operations sections">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} data-active={pathname.startsWith(t.href)}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
