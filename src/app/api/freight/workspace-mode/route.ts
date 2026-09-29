import { NextResponse } from 'next/server';
import { modeSwitchEnabled, setWorkspaceMode, workspaceMode, type WorkspaceMode } from '@/freight/workspaceMode';
import { authMode } from '@/freight/auth/config';
import { needsFirstRunSetup } from '@/freight/auth/password';
import { tryResolveCtx } from '@/freight/session';

export const dynamic = 'force-dynamic';

/** Whether the switch exists, and which workspace is open. Nothing sensitive. */
export async function GET() {
  return NextResponse.json({ switchEnabled: modeSwitchEnabled(), mode: workspaceMode() });
}

/**
 * Switches between the demonstration workspace and production.
 *
 * - Off unless FREIGHT_MODE_SWITCH=on on the server.
 * - Demo -> production: open to whoever is in the demonstration, which is
 *   anonymous by design and holds only fictional data. It can only lock things.
 * - Production -> demo: a signed-in manager only, or nobody has an account yet
 *   so there is nothing to protect. Production data is never opened, copied or
 *   deleted by either direction.
 */
export async function POST(request: Request) {
  if (!modeSwitchEnabled()) {
    return NextResponse.json(
      { ok: false, error: 'Switching is off on this server. Set FREIGHT_MODE_SWITCH=on to allow it.' },
      { status: 403 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as { mode?: string };
  if (body.mode !== 'demo' && body.mode !== 'production') {
    return NextResponse.json({ ok: false, error: 'Choose demo or production.' }, { status: 400 });
  }
  const target: WorkspaceMode = body.mode;
  const current = workspaceMode();
  if (target === current) return NextResponse.json({ ok: true, mode: current, changed: false });

  if (target === 'demo') {
    const ctx = await tryResolveCtx();
    const nothingToProtect = authMode() === 'password' && needsFirstRunSetup();
    if (!nothingToProtect && ctx?.user.role !== 'logistics_manager') {
      return NextResponse.json(
        { ok: false, error: 'Only a signed-in Logistics Operations Manager can switch back to the demonstration.' },
        { status: ctx ? 403 : 401 },
      );
    }
  }

  setWorkspaceMode(target);
  return NextResponse.json({
    ok: true,
    mode: target,
    changed: true,
    message:
      target === 'production'
        ? 'Production workspace is open. Sign in, or create the first account.'
        : 'Demonstration workspace is open. Nothing in it is real.',
  });
}
