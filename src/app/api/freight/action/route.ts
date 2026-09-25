import { NextResponse } from 'next/server';
import { ActionSchema, applyFreightAction } from '@/freight/actions';
import { FreightError } from '@/freight/repo';
import { resolveCtx } from '@/freight/session';
import { UnreadableFile } from '@/freight/parsers/excel';
import { FileError } from '@/freight/files';

export const dynamic = 'force-dynamic';

/**
 * The only endpoint that changes anything.
 *
 * It parses and validates the request, resolves who is acting, and hands off.
 * Every rule lives behind `applyFreightAction`, so there is no second path that
 * could skip an approval or a company check.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'The request could not be read.' }, { status: 400 });
  }

  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      {
        ok: false,
        error: first
          ? `${first.path.join('.') || 'request'}: ${first.message}`
          : 'That request was not in a shape this server understands.',
      },
      { status: 400 },
    );
  }

  try {
    const ctx = await resolveCtx();
    const result = await applyFreightAction(ctx, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FreightError) {
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    }
    if (err instanceof UnreadableFile || err instanceof FileError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    console.error('[freight/action]', parsed.data.type, err);
    return NextResponse.json(
      { ok: false, error: 'Something went wrong on the server. The action was not completed.' },
      { status: 500 },
    );
  }
}
