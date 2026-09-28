/**
 * Downloads an approved email as a `.eml` file, for a person to send from
 * their own mailbox.
 *
 * The workflow runs without Microsoft Graph this way: download, send it
 * yourself in Outlook, then record it as sent. The approval gate is enforced in
 * the service, not here - handing someone the file is handing them the send.
 */

import { NextResponse } from 'next/server';
import { resolveCtx } from '@/freight/session';
import { emailAsEml } from '@/freight/service/mail';
import { FreightError } from '@/freight/repo';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await resolveCtx();
    const { id } = await params;
    const file = emailAsEml(ctx, id);

    return new NextResponse(file.content, {
      headers: {
        'content-type': 'message/rfc822; charset=utf-8',
        // RFC 5987 for the name, since a subject is often not plain ASCII.
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof FreightError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    throw err;
  }
}
