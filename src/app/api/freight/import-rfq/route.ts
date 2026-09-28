import { NextResponse } from 'next/server';
import { FreightError } from '@/freight/repo';
import { resolveCtx } from '@/freight/session';
import { readCells, UnreadableFile } from '@/freight/parsers/excel';
import { looksLikeRfqTemplate, parseRequestSheet } from '@/freight/parsers/rfqRequest';
import { validateUpload, FileError } from '@/freight/files';

export const dynamic = 'force-dynamic';

/**
 * Reads a filled-in shipping requirement template.
 *
 * This endpoint never writes. It returns what it read, and the person checks
 * it in the form and creates the RFQ through the usual `rfq.create` action, so
 * a spreadsheet is validated exactly like typed input.
 */
export async function POST(request: Request) {
  try {
    await resolveCtx(); // signed in (or in demo mode) to use it at all
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Attach the filled-in template.' }, { status: 400 });
    }
    validateUpload(file.name, file.size);
    const cells = await readCells(Buffer.from(await file.arrayBuffer()), file.name);
    if (!looksLikeRfqTemplate(cells)) {
      return NextResponse.json(
        { ok: false, error: `${file.name} is not the shipping requirement template. Download it with "Prefer a spreadsheet?" and fill that in.` },
        { status: 400 },
      );
    }
    const parsed = parseRequestSheet(cells, file.name);
    return NextResponse.json({ ok: true, requests: parsed.requests, problems: parsed.problems });
  } catch (err) {
    if (err instanceof FreightError) return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    if (err instanceof UnreadableFile || err instanceof FileError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    console.error('[freight/import-rfq]', err);
    return NextResponse.json({ ok: false, error: 'That file could not be read.' }, { status: 500 });
  }
}
