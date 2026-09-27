import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { seedDemo } from '@/freight/demo/seed';
import { SimulatedErp } from '@/freight/adapters/erpnext';
import { SimulatedMailbox } from '@/freight/adapters/mailbox';
import { SESSION_COOKIE, sessionCookieOptions, tryResolveCtx } from '@/freight/session';
import { createSession, needsFirstRunSetup } from '@/freight/auth';

export const dynamic = 'force-dynamic';

/**
 * Loads the demonstration dataset.
 *
 * This wipes the freight store and rebuilds it by running the real workflow.
 * It is destructive by design and is the only endpoint that is.
 */
export async function POST(request: Request) {
  // Seeding wipes everything, so it needs a manager - except at first run, when
  // nobody can sign in yet and this is how the workspace gets bootstrapped.
  const bootstrapping = needsFirstRunSetup();
  if (!bootstrapping) {
    const ctx = await tryResolveCtx();
    if (!ctx) {
      return NextResponse.json({ ok: false, error: 'You are not signed in.' }, { status: 401 });
    }
    if (ctx.user.role !== 'logistics_manager') {
      return NextResponse.json(
        { ok: false, error: 'Only the Logistics Operations Manager can replace the workspace data.' },
        { status: 403 },
      );
    }
  }

  try {
    SimulatedErp.reset();
    SimulatedMailbox.reset();
    const { users, summary } = await seedDemo();
    // The previous session pointed at a user row that no longer exists, so
    // hand back a fresh one for the seeded manager.
    const res = NextResponse.json({
      ok: true,
      message: 'Loaded the demonstration dataset.',
      data: { summary, user: users[0] },
    });
    res.cookies.set(SESSION_COOKIE, createSession(users[0].id), sessionCookieOptions(request));
    return res;
  } catch (err) {
    console.error('[freight/demo]', err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'The demonstration dataset could not be loaded.',
      },
      { status: 500 },
    );
  }
}
