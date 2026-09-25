import { NextResponse } from 'next/server';
import { readFile, FileError, ALLOWED_TYPES, extensionOf } from '@/freight/files';
import { listComparisons, listEmails, listInbound } from '@/freight/repo';
import { resolveCtx } from '@/freight/session';

export const dynamic = 'force-dynamic';

/**
 * Serves a stored attachment.
 *
 * A key alone is not enough: the file must be referenced by something the
 * acting user can already see. Otherwise a guessed key would leak another
 * company's quotation.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  try {
    const ctx = await resolveCtx();

    const reachable =
      listComparisons(ctx).some((c) => c.workbookKey === key) ||
      listEmails(ctx).some((e) => e.attachments.some((a) => a.storageKey === key)) ||
      listInbound(ctx).some((m) => m.attachments.some((a) => a.storageKey === key));

    if (!reachable) {
      return NextResponse.json({ error: 'That attachment was not found.' }, { status: 404 });
    }

    const content = readFile(key);
    const type = ALLOWED_TYPES[extensionOf(key)] ?? 'application/octet-stream';
    const filename = key.replace(/^[0-9a-f]{8}-/, '');
    return new NextResponse(new Uint8Array(content), {
      headers: {
        'content-type': type,
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(content.byteLength),
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    if (err instanceof FileError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: 'That attachment could not be served.' }, { status: 500 });
  }
}
