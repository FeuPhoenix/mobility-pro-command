import { NextResponse, type NextRequest } from 'next/server';
import { operationsDemoEnabled, routeWhenDemoOff } from './operationsDemo';

/**
 * Runs before the operations demo's routes, and only those (see `matcher`).
 * With OPERATIONS_DEMO=off they answer 404 and "/" goes to the freight
 * workspace. Otherwise it does nothing.
 */
export function proxy(request: NextRequest) {
  if (operationsDemoEnabled()) return NextResponse.next();
  const decision = routeWhenDemoOff(request.nextUrl.pathname);
  if (decision.kind === 'redirect') return NextResponse.redirect(new URL(decision.to, request.url));
  if (decision.kind === 'not_found') {
    return request.nextUrl.pathname.startsWith('/api/')
      ? NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 })
      : new NextResponse('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/operations/:path*',
    '/customers/:path*',
    '/approvals/:path*',
    '/automations/:path*',
    '/api/action',
    '/api/assistant',
    '/api/reset',
    '/api/state',
  ],
};
