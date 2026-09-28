import { NextResponse } from 'next/server';
import { health } from '@/freight/ops';

export const dynamic = 'force-dynamic';

/**
 * For the host's health check and uptime monitor. 200 when the freight store
 * opens and its folder is writable, 503 otherwise. It reveals no
 * configuration and no data, so it can be left reachable without signing in.
 */
export async function GET() {
  const h = health();
  return NextResponse.json(h, { status: h.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
