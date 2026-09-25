import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { listCompanies, listUsers, listInbound, listRfqs } from '@/freight/repo';
import { buildOverview, integrationStatus } from '@/freight/view';
import { listCompanyProviders } from '@/freight/repo';
import { tryResolveCtx, USER_COOKIE } from '@/freight/session';
import { getSetting } from '@/freight/db';
import { RELATIONSHIP_LABEL } from '@/freight/types';

export const dynamic = 'force-dynamic';

/** Everything the workspace needs to render, in one request. */
export async function GET(request: Request) {
  const ctx = await tryResolveCtx();
  if (!ctx) {
    return NextResponse.json({ seeded: false, users: [], companies: [] });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get('companyId');
  const companies = listCompanies(ctx);
  // A company id the user cannot reach is ignored rather than honoured.
  const companyId =
    requested && companies.some((c) => c.id === requested) ? requested : undefined;

  const overview = buildOverview(ctx, companyId);
  const providers = companyId
    ? listCompanyProviders(ctx, companyId).map((p) => ({
        linkId: p.link.id,
        providerId: p.provider.id,
        name: p.provider.name,
        kind: p.provider.kind,
        country: p.provider.country,
        generalEmail: p.provider.generalEmail,
        status: p.link.status,
        statusLabel: RELATIONSHIP_LABEL[p.link.status],
        restrictionReason: p.link.restrictionReason,
        accountRef: p.link.accountRef,
        lanes: p.link.lanes,
        notes: p.link.notes,
        contacts: p.contacts,
      }))
    : [];

  return NextResponse.json({
    seeded: listRfqs(ctx).length > 0 || companies.length > 0,
    user: ctx.user,
    users: listUsers(),
    companies,
    companyId: companyId ?? null,
    overview,
    providers,
    inbox: listInbound(ctx),
    integrations: integrationStatus(),
    settings: {
      criteria: getSetting('ranking.criteria', null),
      fxRates: getSetting('fx.rates', []),
      remindersAfterDays: getSetting('reminders.afterDays', 3),
      remindersMaxRounds: getSetting('reminders.maxRounds', 2),
    },
  });
}

/** Switches the acting person. A demonstration control, not authentication. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { userId?: string };
  const user = listUsers().find((u) => u.id === body.userId);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'That person is not in this workspace.' }, { status: 400 });
  }
  const store = await cookies();
  store.set(USER_COOKIE, user.id, { httpOnly: true, sameSite: 'lax', path: '/' });
  return NextResponse.json({ ok: true, message: `Now acting as ${user.name}.`, data: user });
}
