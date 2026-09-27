import { NextResponse } from 'next/server';
import { withAutomationAuth } from '@/freight/automation-auth';
import { automationCtx, automationSummary } from '@/freight/service/automation';

export const dynamic = 'force-dynamic';

/** One read for a briefing workflow, so it does not make six calls. Read-only. */
export const GET = withAutomationAuth(async () =>
  NextResponse.json({ ok: true, data: automationSummary(automationCtx()) }),
);
