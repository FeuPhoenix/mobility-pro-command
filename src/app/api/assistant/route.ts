import { NextResponse } from 'next/server';
import { ask, type AssistantContext } from '@/domain/assistant';
import { StateError, reviveState } from '@/server/demoState';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: { state?: unknown; question?: string; context?: AssistantContext };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request body.' }, { status: 400 });
  }

  try {
    const state = reviveState(body.state);
    const question = (body.question ?? '').slice(0, 500);
    const answer = ask(state, question, body.context ?? {});
    return NextResponse.json({ ok: true, answer });
  } catch (err) {
    if (err instanceof StateError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unexpected error.';
    console.error('[assistant]', err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
