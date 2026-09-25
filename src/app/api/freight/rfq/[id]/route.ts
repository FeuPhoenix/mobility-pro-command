import { NextResponse } from 'next/server';
import { getRfq, FreightError } from '@/freight/repo';
import { buildRfqDetail } from '@/freight/view';
import { recipientOptions } from '@/freight/service/rfq';
import { resolveCtx } from '@/freight/session';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await resolveCtx();
    const rfq = getRfq(ctx, id);
    return NextResponse.json({
      detail: buildRfqDetail(ctx, rfq),
      recipientOptions: recipientOptions(ctx, rfq.id),
    });
  } catch (err) {
    if (err instanceof FreightError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[freight/rfq]', err);
    return NextResponse.json({ error: 'That RFQ could not be loaded.' }, { status: 500 });
  }
}
