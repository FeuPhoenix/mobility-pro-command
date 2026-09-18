import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import './globals.css';
import { DemoProvider } from '@/components/DemoProvider';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'Mobility Pro Command',
  description:
    'An intelligent operational layer for demand-to-cash, inventory and pricing decisions — demonstrated alongside ERPNext.',
  // This is a client-specific pitch demo, not a public product page. Keep it out
  // of search results; the link is meant to be shared directly.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <DemoProvider>
            <AppShell>{children}</AppShell>
          </DemoProvider>
        </Suspense>
      </body>
    </html>
  );
}
