import { NextResponse } from 'next/server';
import { needsFirstRunSetup } from '@/freight/auth';
import { tryResolveCtx } from '@/freight/session';
import { listUsers } from '@/freight/repo';
import { getSetting } from '@/freight/db';
import { DEMO_PASSWORD } from '@/freight/demo/fixtures';

export const dynamic = 'force-dynamic';

/**
 * What the sign-in page needs before anyone has signed in.
 *
 * It lists the demonstration accounts only while the workspace actually holds
 * demonstration data. On a real workspace it returns no accounts and no
 * password, so this endpoint can never enumerate real users.
 */
export async function GET() {
  const ctx = await tryResolveCtx();

  // The account list depends on whether this workspace holds demonstration
  // data, not on who is asking. On a real workspace it is always null, so this
  // endpoint can never enumerate real users either way.
  const isDemo = getSetting<boolean>('demo.mode', false);
  const demo = isDemo
    ? {
        password: DEMO_PASSWORD,
        accounts: listUsers()
          .filter((u) => u.canSignIn && !u.disabled)
          .map((u) => ({ name: u.name, title: u.title, email: u.email })),
      }
    : null;

  return NextResponse.json({
    signedIn: Boolean(ctx),
    needsSetup: ctx ? false : needsFirstRunSetup(),
    demo,
  });
}
