import { NextResponse } from 'next/server';
import { seedState } from '@/server/demoState';

export const dynamic = 'force-dynamic';

/** Reset is simply a new seed; the browser replaces its stored document. */
export async function POST() {
  return NextResponse.json({
    ok: true,
    message: 'Demo reset to the original scenario.',
    state: seedState(),
  });
}
