import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/freight/auth/config';

export const dynamic = 'force-dynamic';

/** Signs out of this application. It does not sign the person out of Microsoft. */
export async function POST() {
  const res = NextResponse.json({ ok: true, message: 'Signed out.' });
  res.cookies.delete({ name: SESSION_COOKIE, path: '/' });
  return res;
}
