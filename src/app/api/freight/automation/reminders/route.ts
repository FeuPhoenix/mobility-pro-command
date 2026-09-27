import { NextResponse } from 'next/server';
import { withAutomationAuth } from '@/freight/automation-auth';
import { automationCtx, dueReminders, prepareDueReminders } from '@/freight/service/automation';

export const dynamic = 'force-dynamic';

/** Which providers are due a chase, and why. Read-only. */
export const GET = withAutomationAuth(async () => {
  const due = dueReminders(automationCtx());
  return NextResponse.json({
    ok: true,
    data: { providersDue: due.reduce((n, d) => n + d.providers.length, 0), requests: due },
  });
});

/**
 * Prepares a draft reminder for each provider that is due.
 *
 * It does not send them. Every draft lands in the approval queue with its
 * recipients and body visible, and a person still has to approve it.
 * Re-running is safe: a duplicate is reported as a skip, not an error.
 */
export const POST = withAutomationAuth(async (request) => {
  const body = (await request.json().catch(() => ({}))) as { rfqId?: string };
  const results = prepareDueReminders(automationCtx(), { rfqId: body.rfqId });
  const prepared = results.reduce((n, r) => n + r.prepared.length, 0);
  return NextResponse.json({
    ok: true,
    message:
      prepared === 0
        ? 'No provider was due a reminder.'
        : `Prepared ${prepared} reminder${prepared === 1 ? '' : 's'}. ${prepared === 1 ? 'It is' : 'They are'} waiting for approval and nothing has been sent.`,
    data: { prepared, results },
  });
});
