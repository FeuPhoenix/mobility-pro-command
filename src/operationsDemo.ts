/**
 * Whether the older, stateless operations demo is served at all.
 *
 * The operations demo is fictional and has no sign-in. On a production address
 * that holds real freight data it should usually not be reachable, and relying
 * on someone to write reverse-proxy rules for it is fragile. OPERATIONS_DEMO=off
 * removes it from inside the application: its pages and APIs answer 404, and
 * "/" goes to the freight workspace instead.
 */

export function operationsDemoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPERATIONS_DEMO !== 'off';
}

/** Every route that belongs to the operations demo. */
export const OPERATIONS_PATHS = [
  '/operations',
  '/customers',
  '/approvals',
  '/automations',
  '/api/action',
  '/api/assistant',
  '/api/reset',
  '/api/state',
];

export type DemoRouting = { kind: 'pass' } | { kind: 'redirect'; to: string } | { kind: 'not_found' };

/** What to do with a request path when the operations demo is switched off. */
export function routeWhenDemoOff(pathname: string): DemoRouting {
  if (pathname === '/') return { kind: 'redirect', to: '/freight' };
  const owned = OPERATIONS_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return owned ? { kind: 'not_found' } : { kind: 'pass' };
}
