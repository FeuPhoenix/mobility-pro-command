import { NextResponse } from 'next/server';
import { buildProviderTemplate, buildRfqTemplate } from '@/freight/excel/workbook';
import { getCompany } from '@/freight/repo';
import { resolveCtx } from '@/freight/session';

export const dynamic = 'force-dynamic';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Downloadable import templates, so the agreed format is never in doubt. */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const ctx = await resolveCtx();

  if (kind === 'providers') {
    const companyId = new URL(request.url).searchParams.get('companyId');
    let companyName = 'your company';
    if (companyId) {
      try {
        companyName = getCompany(ctx, companyId).name;
      } catch {
        // Fall back to the generic wording rather than leaking whether the id exists.
      }
    }
    const buffer = await buildProviderTemplate(companyName);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'content-type': XLSX,
        'content-disposition': 'attachment; filename="Freight provider list template.xlsx"',
      },
    });
  }

  if (kind === 'rfq') {
    const buffer = await buildRfqTemplate();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'content-type': XLSX,
        'content-disposition': 'attachment; filename="Shipping requirement template.xlsx"',
      },
    });
  }

  return NextResponse.json({ error: 'There is no template by that name.' }, { status: 404 });
}
