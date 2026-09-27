/**
 * The in-process timer that runs mailbox collection.
 *
 * Off unless MAILBOX_POLL_SECONDS is set. Started once per server process from
 * src/instrumentation.ts. Suitable for a single long-running Node host; where
 * several instances run, prefer one external scheduler calling
 * POST /api/freight/collect instead. The database lease in service/collect.ts
 * means an overlap is harmless either way, just wasted work.
 *
 * Delta query on a timer was chosen over a Graph webhook subscription for now:
 * a webhook needs a public HTTPS endpoint and a subscription renewed every few
 * days, and where this is hosted is not decided yet. A webhook can later call
 * the same `collectInbox()` to cut the delay without changing anything else.
 */

import { collectInbox } from './service/collect';

const MIN_SECONDS = 30;

export function pollSeconds(): number | null {
  const n = Number.parseInt(process.env.MAILBOX_POLL_SECONDS ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(n, MIN_SECONDS);
}

export function startCollectionSchedule(): void {
  const seconds = pollSeconds();
  if (!seconds) return;
  const g = globalThis as { __freightCollectTimer?: ReturnType<typeof setInterval> };
  if (g.__freightCollectTimer) return;

  const tick = () => {
    collectInbox({ trigger: 'schedule' }).catch((err) => console.error('[freight/schedule]', err));
  };
  g.__freightCollectTimer = setInterval(tick, seconds * 1000);
  // Never keep the process alive just for the timer.
  g.__freightCollectTimer.unref?.();
  console.log(`[freight/schedule] Collecting replies every ${seconds}s.`);
}
