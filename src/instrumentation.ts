/**
 * Runs once when the server process starts.
 *
 * Only the freight mailbox schedule lives here, and it does nothing unless
 * MAILBOX_POLL_SECONDS is set. The import is dynamic and Node-only because the
 * freight store uses node:sqlite, which does not exist in the edge runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startCollectionSchedule } = await import('./freight/schedule');
  startCollectionSchedule();
}
