import { NextResponse } from 'next/server';
import { analyseProviderImport } from '@/freight/service/providers';
import { FreightError } from '@/freight/repo';
import { resolveCtx } from '@/freight/session';
import { UnreadableFile } from '@/freight/parsers/excel';
import { validateUpload, FileError } from '@/freight/files';

export const dynamic = 'force-dynamic';

/**
 * Parses and validates an uploaded provider list.
 *
 * This endpoint never writes. It returns a report the user reviews, and the
 * separate `provider.commitImport` action writes the rows that passed.
 */
export async function POST(request: Request) {
  try {
    const ctx = await resolveCtx();
    const form = await request.formData();
    const companyId = String(form.get('companyId') ?? '');
    const file = form.get('file');

    if (!companyId) {
      return NextResponse.json({ ok: false, error: 'Choose a company to import into.' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: 'Attach a spreadsheet to import.' }, { status: 400 });
    }

    validateUpload(file.name, file.size);
    const buffer = Buffer.from(await file.arrayBuffer());
    const report = await analyseProviderImport(ctx, companyId, buffer, file.name);

    return NextResponse.json({ ok: true, filename: file.name, report });
  } catch (err) {
    if (err instanceof FreightError || err instanceof UnreadableFile || err instanceof FileError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    console.error('[freight/import]', err);
    return NextResponse.json({ ok: false, error: 'That file could not be read.' }, { status: 500 });
  }
}
