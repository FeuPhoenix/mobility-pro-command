import { NextResponse } from 'next/server';
import { seedState } from '@/server/demoState';

export const dynamic = 'force-dynamic';

/** Hands the browser a fresh demo document. The browser then owns it. */
export async function GET() {
  return NextResponse.json({ state: seedState() });
}
