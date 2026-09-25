import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { seedDemo } from '@/freight/demo/seed';
import { SimulatedErp } from '@/freight/adapters/erpnext';
import { USER_COOKIE } from '@/freight/session';

export const dynamic = 'force-dynamic';

/**
 * Loads the demonstration dataset.
 *
 * This wipes the freight store and rebuilds it by running the real workflow.
 * It is destructive by design and is the only endpoint that is.
 */
export async function POST() {
  try {
    SimulatedErp.reset();
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
