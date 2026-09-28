import { NextResponse } from 'next/server';
import { withAutomationAuth } from '@/freight/automation-auth';
import { automationCtx, retryFailedSyncs, retryableSyncs } from '@/freight/service/automation';

export const dynamic = 'force-dynamic';

/** Records that have not reached ERPNext, and whether a retry would help. */
export const GET = withAutomationAuth(async () => {
  const items = retryableSyncs(automationCtx());
  return NextResponse.json({
    ok: true,
    data: {
      outstanding: items.length,
      retryable: items.filter((i) => i.retryable).length,
      needsAPerson: items.filter((i) => !i.retryable).length,
      items,
    },
  });
});

/**
 * Retries the records that can safely be retried.
 *
 * Each carries a stable idempotency key, so a retry updates rather than
 * duplicates. Records blocked on missing setup are skipped: retrying those on a
 * timer would fail forever and bury the real message.
 */
export const POST = withAutomationAuth(async (request) => {
  const body = (await request.json().catch(() => ({}))) as { comparisonId?: string };
  const results = await retryFailedSyncs(automationCtx(), { comparisonId: body.comparisonId });
  const recovered = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  return NextResponse.json({
    ok: failed.length === 0,
    message:
      results.length === 0
        ? 'Nothing needed retrying.'
        : `Retried ${results.length}: ${recovered} recorded, ${failed.length} still failing.`,
    data: { results },
  });
});
