import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { collectInbox } from '@/freight/service/collect';

export const dynamic = 'force-dynamic';

/**
 * Runs mailbox collection for an external scheduler (cron, a task runner).
 *
 * This is not a browser endpoint: people use "Collect now" in the workspace,
 * which goes through the action boundary. A scheduler has no session, so it
 * presents `Authorization: Bearer <MAILBOX_COLLECT_TOKEN>`. With no token
 * configured the endpoint is switched off, rather than open to anyone.
 *
 * It can only trigger collection. Collection runs as the Mailbox Collector,
 * which files replies and can do nothing else.
 */
export async function POST(request: Request) {
  const expected = process.env.MAILBOX_COLLECT_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'External collection is not enabled. Set MAILBOX_COLLECT_TOKEN to enable it.' },
      { status: 404 },
    );
  }

  const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: 'Not authorised.' }, { status: 401 });
  }

  const run = await collectInbox({ trigger: 'external' });
  return NextResponse.json(
    { ok: run.outcome !== 'failed', data: run },
    { status: run.outcome === 'failed' ? 502 : 200 },
  );
}
