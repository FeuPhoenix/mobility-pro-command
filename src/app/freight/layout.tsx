import type { Metadata } from 'next';
import './freight.css';
import { FreightProvider } from '@/freight/ui/FreightProvider';
import { FreightShell } from '@/freight/ui/shell';

export const metadata: Metadata = {
  title: 'Freight RFQ · Mobility Pro Command',
  description:
    'Maintain freight provider lists, issue requests for quotation, collect and check offers, compare them and record the outcome.',
};

export default function FreightLayout({ children }: { children: React.ReactNode }) {
  return (
    <FreightProvider>
      <FreightShell>{children}</FreightShell>
    </FreightProvider>
  );
}
