/**
 * Liveness and readiness for whatever runs this in production.
 *
 * A container that answers HTTP while its database is unwritable is worse than
 * one that is plainly down, so this opens the database and writes nothing
 * secret back. It is deliberately unauthenticated — a load balancer cannot sign
 * in — so it answers only what a stranger may safely know: whether the process
 * is serving and whether its storage works. Not the path, not the error detail,
 * not a count of anything.
 */

import { NextResponse } from 'next/server';
import { db } from '@/freight/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // A real query: the file can exist, be readable, and still be corrupt.
    db().prepare('SELECT count(*) AS n FROM sqlite_master').get();
  } catch (err) {
    console.error('[health] the freight database could not be opened:', err);
    return NextResponse.json(
      // The reason goes to the server log, where an operator can read it; the
      // response says only that storage is unavailable.
      { ok: false, storage: 'unavailable' },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true, storage: 'writable' });
}
