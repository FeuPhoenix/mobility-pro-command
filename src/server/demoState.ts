/**
 * Server-side demo state handling — stateless.
 *
 * WHY STATELESS
 * -------------
 * This demo is deployed to a serverless host, where the filesystem is read-only
 * and no two requests are guaranteed to reach the same instance. Persisting the
 * demo document on the server would therefore reset at unpredictable moments —
 * the worst possible failure during a client presentation.
 *
 * So the browser holds the document (about 42 KB in `localStorage`) and sends it
 * with every request. The server remains the rule authority: `applyAction` still
 * runs here, with the same validation and role checks, and the client can only
 * obtain a new state by asking the server to produce one.
 *
 * HONEST LIMIT
 * ------------
 * Because the client carries the document, it could submit a doctored one. That
 * is not a threat worth defending against here: the dataset is fictional, there
 * is no authentication, and nothing in this demo touches a real record. What the
 * client still cannot do is *bypass a rule* — every transition is computed by the
 * server from the document it was given.
 */

import { buildSeedState } from '@/domain/seed';
import { SEED_VERSION } from '@/domain/version';
import { ensureValidated } from './actions';
import type { DemoState } from '@/domain/types';

export class StateError extends Error {
  status = 400;
}

/** A fresh, fully validated demo document. */
export function seedState(): DemoState {
  const state = buildSeedState(cryptoId());
  ensureValidated(state);
  return state;
}

function cryptoId(): string {
  // Not security-relevant: it only labels the document so the UI can show one.
  return 'demo-' + Math.random().toString(36).slice(2, 10);
}

/** Every top-level collection the domain code expects to be able to read. */
const REQUIRED_KEYS = [
  'meta',
  'users',
  'skus',
  'warehouses',
  'lots',
  'customers',
  'suppliers',
  'invoices',
  'payments',
  'purchaseOrders',
  'documents',
  'discrepancies',
  'cases',
  'shipments',
  'priceLists',
  'salesOrders',
  'reservations',
  'historicalSales',
  'approvals',
  'activity',
  'opportunities',
  'policies',
] as const;

/**
 * Accepts a demo document from the client and checks it is the right shape and
 * seed version before any rule runs against it. A malformed or stale document is
 * rejected with a clear message rather than causing a 500 deep inside the domain.
 */
export function reviveState(raw: unknown): DemoState {
  if (!raw || typeof raw !== 'object') {
    throw new StateError('No demo state was supplied with the request.');
  }
  const s = raw as Partial<DemoState>;

  if (!s.meta || typeof s.meta !== 'object') {
    throw new StateError('The demo state is missing its metadata.');
  }
  if (s.meta.seedVersion !== SEED_VERSION) {
    throw new StateError(
      `This demo session was created on dataset ${s.meta.seedVersion ?? 'unknown'} but the server is now on ${SEED_VERSION}. Reset the demo to continue.`,
    );
  }
  for (const key of REQUIRED_KEYS) {
    if (key === 'meta') continue;
    if (!Array.isArray((s as Record<string, unknown>)[key])) {
      throw new StateError(`The demo state is malformed: "${key}" is missing or not a list.`);
    }
  }

  const state = s as DemoState;
  // Seeded documents are validated on creation, but a document that predates a
  // validation change (or was hand-edited) is repaired rather than rejected.
  ensureValidated(state);
  return state;
}

export { SEED_VERSION };
