import { NextResponse } from 'next/server';
import { ActionError, applyAction, type Action } from '@/server/actions';
import { StateError, reviveState } from '@/server/demoState';

export const dynamic = 'force-dynamic';

/**
 * The single mutation boundary.
 *
 * The browser sends the demo document it holds plus the action it wants. Every
 * validation and role check still runs here; the client cannot skip a rule by
 * calling this endpoint directly.
 */
export async function POST(request: Request) {
  let body: { state?: unknown; action?: Action };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request body.' }, { status: 400 });
  }

  const action = body?.action;
  if (!action || typeof action.type !== 'string') {
    return NextResponse.json({ ok: false, error: 'An action type is required.' }, { status: 400 });
  }

  try {
    const state = reviveState(body.state);
    const result = applyAction(state, action);
    return NextResponse.json({ ...result, state });
  } catch (err) {
    if (err instanceof ActionError || err instanceof StateError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unexpected error.';
    console.error('[action]', action.type, err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
