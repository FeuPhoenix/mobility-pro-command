import { NextResponse } from 'next/server';
import { withAutomationAuth } from '@/freight/automation-auth';
import { automationCtx, waitingApprovals } from '@/freight/service/automation';

export const dynamic = 'force-dynamic';

/**
 * What is sitting in the approval queue, longest wait first.
 *
 * Read-only by design: a workflow nudges the manager, it never approves.
 */
export const GET = withAutomationAuth(async () => {
  const items = waitingApprovals(automationCtx());
  return NextResponse.json({ ok: true, data: { count: items.length, items } });
});
