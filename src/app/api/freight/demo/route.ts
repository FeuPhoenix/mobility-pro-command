import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { seedDemo } from '@/freight/demo/seed';
import { SimulatedErp } from '@/freight/adapters/erpnext';
import { SimulatedMailbox } from '@/freight/adapters/mailbox';
import { USER_COOKIE } from '@/freight/session';
import { authMode } from '@/freight/auth/config';

export const dynamic = 'force-dynamic';

/**
 * Loads the demonstration dataset.
 *
 * This wipes the freight store and rebuilds it by running the real workflow.
 * It is destructive by design and is the only endpoint that is.
 */
export async function POST() {
  // With real sign-in there is real data. Wiping it is never one click away.
  if (authMode() !== 'demo') {
    return NextResponse.json(
      { ok: false, error: 'Loading the demonstration dataset would erase this workspace, so it is switched off while sign-in is on.' },
      { status: 403 },
    );
  }
  try {
    SimulatedErp.reset();
    SimulatedMailbox.reset();
    const { users, summary } = await seedDemo();
    const store = await cookies();
    store.set(USER_COOKIE, users[0].id, { httpOnly: true, sameSite: 'lax', path: '/' });
    return NextResponse.json({
      ok: true,
      message: 'Loaded the demonstration dataset.',
      data: { summary, user: users[0] },
    });
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
