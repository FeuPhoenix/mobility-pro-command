import { NextResponse } from 'next/server';
import { needsFirstRunSetup, passwordProblem, setPassword, createSession } from '@/freight/auth/password';
import { sessionCookieOptions, SESSION_COOKIE } from '@/freight/session';
import { audit, insertUser, newId, listAllCompanyIds } from '@/freight/repo';
import type { User } from '@/freight/types';

export const dynamic = 'force-dynamic';

/**
 * Creates the first account that can sign in.
 *
 * Only available while nobody can sign in yet, which is the one moment where
 * an unauthenticated caller has to be allowed to create an account. After that
 * it refuses, so it cannot be used to add a second back door later.
 */
export async function POST(request: Request) {
  if (!needsFirstRunSetup()) {
    return NextResponse.json(
      { ok: false, error: 'This workspace already has an account. Sign in instead.' },
      { status: 409 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    email?: string;
    password?: string;
  };
  const name = (body.name ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();
  const password = body.password ?? '';

  if (!name) return NextResponse.json({ ok: false, error: 'Enter your name.' }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 });
  }
  const problem = passwordProblem(password);
  if (problem) return NextResponse.json({ ok: false, error: problem }, { status: 400 });

  // The first account manages every company that exists.
  const companyIds = listAllCompanyIds();

  const user: User = {
    id: newId('usr'),
    name,
    title: 'Logistics Operations Manager',
    email,
    role: 'logistics_manager',
    companyIds,
  };

  try {
    insertUser(user);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return NextResponse.json(
        { ok: false, error: 'An account already uses that email address.' },
        { status: 409 },
      );
    }
    throw err;
  }

  await setPassword(user.id, password);

  audit({ user }, {
    companyId: null,
    action: 'auth.first_account_created',
    subject: `user:${user.id}`,
    summary: `${user.name} created the first account for this workspace.`,
  });

  const res = NextResponse.json({ ok: true, message: `Welcome, ${user.name}.`, data: { user } });
  res.cookies.set(SESSION_COOKIE, createSession(user.id), sessionCookieOptions(request));
  return res;
}
