/**
 * Scheduled collection: fetch new mail from the mailbox and file it.
 *
 * This is only the trigger. Every message goes through `ingestMessage()`, the
 * same path the demonstration uses, so matching, extraction, revision handling
 * and the review queue behave identically whether a reply was collected on a
 * schedule or brought in by hand.
 *
 * GUARANTEES
 * ----------
 * - Re-running collection never files a message twice. `ingestMessage` is
 *   idempotent on the transport message id, and the saved mailbox position only
 *   moves forward once every message on a page has been filed.
 * - Two runs never overlap, even across processes: a run takes a lease in the
 *   database first and a second run that finds it held stops straight away.
 * - A message is never silently lost. One that keeps failing is set aside after
 *   three attempts, and that is written to the audit trail with its sender and
 *   subject so a person can bring it in by hand.
 * - It acts as the Mailbox Collector, never as a person (see ../system.ts).
 */

import { db, getSetting, setSetting } from '../db';
import { audit, findInboundByExternalId, findRfqRequestByExternalId, listAllCompanyIds, now, type Ctx } from '../repo';
import { CollectFailure, resolveMailbox, type MailboxSource } from '../adapters/mailbox';
import { mailboxCollectorCtx } from '../system';
import { ingestMessage } from './inbox';
import { ingestRfqRequest, isRfqRequest } from './intake';

export type CollectTrigger = 'schedule' | 'manual' | 'external';

export interface CollectionRun {
  trigger: CollectTrigger;
  /** The person who pressed "Collect now", when a person did. */
  requestedBy: string | null;
  adapter: 'simulated' | 'graph';
  outcome: 'ok' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string;
  /** Messages the mailbox handed over this run. */
  fetched: number;
  /** Newly filed. */
  filed: number;
  /** Already collected on an earlier run, so left alone. */
  duplicates: number;
  /** Filed and matched to a request automatically. */
  matched: number;
  /** Filed into the review queue for a person to attach. */
  needsReview: number;
  /** Colleagues' emailed shipping requirements (RFQ_EMAIL_INTAKE=on). */
  rfqRequests: number;
  /** Messages set aside after repeated failures. */
  quarantined: { externalId: string; from: string; subject: string; error: string }[];
  /** Things the mailbox could not bring across, e.g. linked attachments. */
  notes: string[];
  error: string | null;
}

interface MailboxState {
  /** Which mailbox the cursor belongs to. A different mailbox starts afresh. */
  key: string;
  cursor: string | null;
  /** On a first run, only mail received at or after this is collected. */
  since: string;
  lastSuccessAt: string | null;
}

const STATE_KEY = 'mailbox.state';
const LAST_RUN_KEY = 'mailbox.lastRun';
const FAILURES_KEY = 'mailbox.failures';
const LEASE_KEY = 'mailbox.lease';

const MAX_ATTEMPTS = 3;
/** Bounds one run; anything left is picked up by the next. */
const MAX_PAGES = 20;
/** A lease left by a crashed run expires on its own. */
const LEASE_MS = 10 * 60_000;

function lookbackHours(): number {
  const n = Number.parseFloat(process.env.MAILBOX_INITIAL_LOOKBACK_HOURS ?? '');
  return Number.isFinite(n) && n >= 0 ? n : 72;
}

function hoursBefore(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() - hours * 3_600_000).toISOString();
}

/* ---------------------------------- Lease ------------------------------------ */

/**
 * Takes the collection lease, or returns false if another run holds it.
 * BEGIN IMMEDIATE takes SQLite's write lock up front, so the read-then-write
 * is atomic even when two processes share the database file.
 */
function acquireLease(holder: string): boolean {
  const handle = db();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const current = getSetting<{ holder: string; until: number } | null>(LEASE_KEY, null);
    if (current && current.until > Date.now()) {
      handle.exec('COMMIT');
      return false;
    }
    setSetting(LEASE_KEY, { holder, until: Date.now() + LEASE_MS });
    handle.exec('COMMIT');
    return true;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

function releaseLease(holder: string): void {
  const current = getSetting<{ holder: string; until: number } | null>(LEASE_KEY, null);
  if (current?.holder === holder) db().prepare('DELETE FROM settings WHERE key = ?').run(LEASE_KEY);
}

/* ---------------------------------- Run -------------------------------------- */

export async function collectInbox(
  opts: { trigger: CollectTrigger; requestedBy?: Ctx | null; source?: MailboxSource } = { trigger: 'schedule' },
): Promise<CollectionRun> {
  const source = opts.source ?? resolveMailbox();
  const startedAt = now();
  const run: CollectionRun = {
    trigger: opts.trigger,
    requestedBy: opts.requestedBy?.user.name ?? null,
    adapter: source.kind,
    outcome: 'ok',
    startedAt,
    finishedAt: startedAt,
    fetched: 0,
    filed: 0,
    duplicates: 0,
    matched: 0,
    needsReview: 0,
    rfqRequests: 0,
    quarantined: [],
    notes: [],
    error: null,
  };

  if (listAllCompanyIds().length === 0) {
    // Nothing to file against. Not an error, and not worth recording.
    return { ...run, outcome: 'skipped', error: 'The workspace has no companies yet.' };
  }

  const holder = `${process.pid}:${startedAt}`;
  if (!acquireLease(holder)) {
    return { ...run, outcome: 'skipped', error: 'A collection run is already in progress.' };
  }

  try {
    await runPages(source, run);
  } catch (err) {
    run.outcome = 'failed';
    run.error = err instanceof Error ? err.message : 'Collection failed.';
    if (!(err instanceof CollectFailure)) console.error('[freight/collect]', err);
  } finally {
    run.finishedAt = now();
    setSetting(LAST_RUN_KEY, run);
    recordRun(run);
    releaseLease(holder);
  }
  return run;
}

async function runPages(source: MailboxSource, run: CollectionRun): Promise<void> {
  const ctx = mailboxCollectorCtx();
  let state = getSetting<MailboxState | null>(STATE_KEY, null);
  if (!state || state.key !== source.key) {
    state = { key: source.key, cursor: null, since: hoursBefore(run.startedAt, lookbackHours()), lastSuccessAt: null };
  }
  const failures = getSetting<Record<string, number>>(FAILURES_KEY, {});
  let restarted = false;

  for (let n = 0; n < MAX_PAGES; n += 1) {
    let page;
    try {
      page = await source.fetchPage(state.cursor, state.since);
    } catch (err) {
      if (err instanceof CollectFailure && err.cursorExpired && !restarted) {
        // Start again a little before the last good run. Anything already filed
        // is recognised by its message id and skipped.
        restarted = true;
        state = {
          ...state,
          cursor: null,
          since: hoursBefore(state.lastSuccessAt ?? state.since, 1),
        };
        run.notes.push(err.message);
        continue;
      }
      throw err;
    }

    run.fetched += page.messages.length;
    run.notes.push(...page.notes);

    for (const mail of page.messages) {
      if (findInboundByExternalId(mail.externalId) || findRfqRequestByExternalId(mail.externalId)) {
        run.duplicates += 1;
        continue;
      }
      try {
        if (isRfqRequest(mail)) {
          // A colleague asking for a new RFQ, not a provider replying to one.
          await ingestRfqRequest(mail);
          run.rfqRequests += 1;
        } else {
          const result = await ingestMessage(ctx, mail);
          run.filed += 1;
          if (result.message.matchStatus === 'matched') run.matched += 1;
          else run.needsReview += 1;
        }
        delete failures[mail.externalId];
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'could not be filed';
        const attempts = (failures[mail.externalId] ?? 0) + 1;
        if (attempts < MAX_ATTEMPTS) {
          // Stop here without moving the cursor, so the next run tries again.
          failures[mail.externalId] = attempts;
          setSetting(FAILURES_KEY, failures);
          throw new CollectFailure(
            `A message from ${mail.fromEmail} could not be filed (attempt ${attempts} of ${MAX_ATTEMPTS}): ${reason}`,
          );
        }
        delete failures[mail.externalId];
        run.quarantined.push({ externalId: mail.externalId, from: mail.fromEmail, subject: mail.subject, error: reason });
        audit(ctx, {
          companyId: null,
          action: 'inbox.collect_set_aside',
          subject: `mailbox:${mail.externalId}`,
          summary: `A message from ${mail.fromEmail} ("${mail.subject}") failed to file ${MAX_ATTEMPTS} times and was set aside. It is still in the mailbox; bring it in by hand.`,
          detail: { error: reason },
        });
      }
    }

    // Every message on the page is filed or set aside: safe to move on.
    state = { ...state, cursor: page.cursor };
    setSetting(STATE_KEY, state);
    setSetting(FAILURES_KEY, failures);
    if (!page.more) break;
  }

  setSetting(STATE_KEY, { ...state, lastSuccessAt: run.startedAt });
}

/** Only runs that did something reach the audit trail, so a quiet schedule stays quiet. */
function recordRun(run: CollectionRun): void {
  if (run.outcome === 'ok' && run.fetched === 0 && run.quarantined.length === 0) return;
  audit(mailboxCollectorCtx(), {
    companyId: null,
    action: run.outcome === 'failed' ? 'inbox.collect_failed' : 'inbox.collected',
    subject: 'mailbox',
    summary:
      run.outcome === 'failed'
        ? `Collecting replies failed: ${run.error}`
        : `Collected ${run.filed} new repl${run.filed === 1 ? 'y' : 'ies'}: ${run.matched} matched, ${run.needsReview} waiting for a person${run.rfqRequests > 0 ? `; ${run.rfqRequests} emailed RFQ request${run.rfqRequests === 1 ? '' : 's'}` : ''}${run.duplicates > 0 ? `, ${run.duplicates} already collected` : ''}.`,
    detail: {
      trigger: run.trigger,
      requestedBy: run.requestedBy,
      adapter: run.adapter,
      fetched: run.fetched,
      quarantined: run.quarantined.length,
    },
  });
}

export function lastCollectionRun(): CollectionRun | null {
  return getSetting<CollectionRun | null>(LAST_RUN_KEY, null);
}
