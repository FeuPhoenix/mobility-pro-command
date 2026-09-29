/**
 * Inbound mail boundary: reading replies from the shared mailbox.
 *
 * INTEGRATION HONESTY
 * -------------------
 * Two implementations ship, mirroring `adapters/mail.ts`:
 *
 *   - `SimulatedMailbox` (default). It never opens a network connection. It
 *     holds an in-process queue that tests and local development can drop
 *     messages into; every message it returns is marked `simulated: true`.
 *   - `GraphMailbox`. Reads the Inbox of the configured Microsoft 365 mailbox
 *     with a Graph delta query, so each run fetches only what arrived since the
 *     last one. It is only selected when MAILBOX_ADAPTER=graph *and* the app
 *     registration variables are present, and the UI only describes it as
 *     connected after `probe()` has succeeded.
 *
 * This module only reads. It never marks, moves or deletes a message, so
 * collection cannot change what people see in the mailbox itself.
 *
 * Adapters fetch; they do not decide. Every message goes to `ingestMessage()` in
 * service/inbox.ts, which is the one place replies enter the workspace.
 *
 * The Graph path is written in full but has NOT been verified against a live
 * tenant from this environment. It is covered by tests against a faked Graph.
 */

import { demoWorkspaceActive } from '../workspaceMode';
import type { IncomingMail } from '../service/inbox';
import { graphConfig, graphToken } from './mail';

export interface MailboxPage {
  messages: IncomingMail[];
  /** Where to resume. Persisted only after every message on the page is filed. */
  cursor: string;
  /** True when the mailbox has more to give right now. */
  more: boolean;
  /**
   * Things the adapter could not bring across, e.g. an attachment that is a link
   * to a file rather than the file. Recorded, never silently dropped.
   */
  notes: string[];
}

export interface MailboxStatus {
  /** Shown verbatim in the UI. Never says "connected" without a good probe. */
  label: string;
  kind: 'simulated' | 'graph';
  connected: boolean;
  detail: string;
  setupRequirements: string[];
  lastProbedAt?: string;
}

export interface MailboxSource {
  /** Identifies which mailbox a saved cursor belongs to. */
  readonly key: string;
  readonly kind: 'simulated' | 'graph';
  status(): MailboxStatus;
  probe(): Promise<MailboxStatus>;
  /**
   * One page of new mail. `cursor` is null on the very first run, in which case
   * only mail received at or after `since` is returned, so switching collection
   * on does not pour the mailbox's whole history into the review queue.
   */
  fetchPage(cursor: string | null, since: string): Promise<MailboxPage>;
}

/** Thrown when a collection run cannot continue. */
export class CollectFailure extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    /** The saved position is no longer valid and collection must start again. */
    readonly cursorExpired = false,
  ) {
    super(message);
    this.name = 'CollectFailure';
  }
}

/* ------------------------------- Simulated ---------------------------------- */

const PAGE_SIZE = 25;

function simulatedQueue(): IncomingMail[] {
  const g = globalThis as { __freightSimulatedMailbox?: IncomingMail[] };
  g.__freightSimulatedMailbox ??= [];
  return g.__freightSimulatedMailbox;
}

export class SimulatedMailbox implements MailboxSource {
  readonly key = 'simulated';
  readonly kind = 'simulated' as const;

  /** Puts a message in the simulated Inbox. Tests and local development only. */
  static deliver(mail: Omit<IncomingMail, 'simulated'>): void {
    simulatedQueue().push({ ...mail, simulated: true });
  }

  static reset(): void {
    simulatedQueue().length = 0;
  }

  status(): MailboxStatus {
    return {
      label: 'Simulated mailbox',
      kind: 'simulated',
      connected: false,
      detail:
        'Collection runs exactly as it would in production, but it reads an empty local stand-in, not a real mailbox. Replies in the demonstration are brought in from the request screen instead.',
      setupRequirements: [
        'Set MAILBOX_ADAPTER=graph and supply the Microsoft Graph app registration to collect replies from a real mailbox.',
      ],
    };
  }

  async probe(): Promise<MailboxStatus> {
    return { ...this.status(), lastProbedAt: new Date().toISOString() };
  }

  async fetchPage(cursor: string | null, since: string): Promise<MailboxPage> {
    const queue = simulatedQueue();
    const start = cursor === null ? 0 : Number.parseInt(cursor, 10) || 0;
    const slice = queue.slice(start, start + PAGE_SIZE);
    const end = start + slice.length;
    return {
      messages: cursor === null ? slice.filter((m) => m.receivedAt >= since) : slice,
      cursor: String(end),
      more: end < queue.length,
      notes: [],
    };
  }
}

/* --------------------------------- Graph ------------------------------------ */

type GraphConfig = NonNullable<ReturnType<typeof graphConfig>['config']>;

const GRAPH = 'https://graph.microsoft.com/v1.0';

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  isDraft?: boolean;
  '@removed'?: { reason?: string };
}

interface GraphAttachment {
  id: string;
  '@odata.type'?: string;
  name?: string;
  contentBytes?: string;
  size?: number;
}

interface GraphDetail {
  internetMessageHeaders?: { name: string; value: string }[];
  attachments?: GraphAttachment[];
}

export class GraphMailbox implements MailboxSource {
  readonly kind = 'graph' as const;
  private lastProbe: MailboxStatus | null = null;

  constructor(
    private readonly cfg: GraphConfig,
    /** Injected so tests can fake Graph without touching the network. */
    private readonly http: typeof fetch = fetch,
    private readonly token: (cfg: GraphConfig) => Promise<string> = graphToken,
  ) {}

  get key(): string {
    return `graph:${this.cfg.tenantId}:${this.cfg.mailbox.toLowerCase()}`;
  }

  private mailboxPath(): string {
    return `${GRAPH}/users/${encodeURIComponent(this.cfg.mailbox)}`;
  }

  status(): MailboxStatus {
    if (this.lastProbe) return this.lastProbe;
    return {
      label: 'Microsoft 365 mailbox (not yet checked)',
      kind: 'graph',
      connected: false,
      detail: `Configured to collect replies from ${this.cfg.mailbox}. The connection has not been checked, so it is not described as connected yet.`,
      setupRequirements: [],
    };
  }

  async probe(): Promise<MailboxStatus> {
    const at = new Date().toISOString();
    try {
      const res = await this.get(`${this.mailboxPath()}/mailFolders/inbox?$select=id,totalItemCount`);
      const inbox = (await res.json()) as { totalItemCount?: number };
      this.lastProbe = {
        label: 'Microsoft 365 mailbox connected',
        kind: 'graph',
        connected: true,
        detail: `Can read the Inbox of ${this.cfg.mailbox}${typeof inbox.totalItemCount === 'number' ? ` (${inbox.totalItemCount} messages)` : ''}. Replies are collected from it; nothing in it is changed.`,
        setupRequirements: [],
        lastProbedAt: at,
      };
    } catch (err) {
      this.lastProbe = {
        label: 'Microsoft 365 mailbox unavailable',
        kind: 'graph',
        connected: false,
        detail: err instanceof Error ? err.message : 'The connection check failed.',
        setupRequirements: [
          'Grant the app registration the Mail.ReadWrite application permission, with admin consent.',
          'Confirm the mailbox is inside an ApplicationAccessPolicy that permits this app.',
        ],
        lastProbedAt: at,
      };
    }
    return this.lastProbe;
  }

  async fetchPage(cursor: string | null, since: string): Promise<MailboxPage> {
    const url =
      cursor ??
      `${this.mailboxPath()}/mailFolders/inbox/messages/delta` +
        `?$select=id,internetMessageId,conversationId,subject,from,receivedDateTime,body,hasAttachments,isDraft` +
        `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;

    const res = await this.get(url, {
      Prefer: `odata.maxpagesize=${PAGE_SIZE}, outlook.body-content-type="text"`,
    });
    const page = (await res.json()) as {
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };

    const next = page['@odata.nextLink'] ?? page['@odata.deltaLink'];
    if (!next) {
      throw new CollectFailure('Microsoft Graph returned a page with no link to continue from.', true);
    }

    const messages: IncomingMail[] = [];
    const notes: string[] = [];
    const own = this.cfg.mailbox.toLowerCase();
    for (const m of page.value ?? []) {
      if (m['@removed'] || m.isDraft) continue;
      const fromEmail = m.from?.emailAddress?.address?.toLowerCase();
      if (!fromEmail) {
        notes.push(`Skipped a message with no sender address (Graph id ${m.id}).`);
        continue;
      }
      // Our own mail (a copy, an auto-reply loop) is never a provider's reply.
      if (fromEmail === own) continue;
      messages.push(await this.toIncoming(m, fromEmail, notes));
    }

    return { messages, cursor: next, more: Boolean(page['@odata.nextLink']), notes };
  }

  private async toIncoming(m: GraphMessage, fromEmail: string, notes: string[]): Promise<IncomingMail> {
    const detail = (await (
      await this.get(`${this.mailboxPath()}/messages/${encodeURIComponent(m.id)}?$select=internetMessageHeaders&$expand=attachments`)
    ).json()) as GraphDetail;

    const header = (name: string) =>
      detail.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value?.trim() ?? null;

    const attachments: IncomingMail['attachments'] = [];
    const skipped: string[] = [];
    for (const a of detail.attachments ?? []) {
      const name = a.name ?? 'attachment';
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') {
        // A link to a cloud file or an embedded email: there are no bytes to file.
        skipped.push(`${name} (not a file attachment)`);
        continue;
      }
      if (a.contentBytes) {
        attachments.push({ filename: name, content: Buffer.from(a.contentBytes, 'base64') });
      } else {
        // Large attachments come without their bytes inline.
        const raw = await this.get(
          `${this.mailboxPath()}/messages/${encodeURIComponent(m.id)}/attachments/${encodeURIComponent(a.id)}/$value`,
        );
        attachments.push({ filename: name, content: Buffer.from(await raw.arrayBuffer()) });
      }
    }
    if (skipped.length > 0) {
      notes.push(`From ${fromEmail}: could not collect ${skipped.join(', ')}.`);
    }

    const body = m.body?.content ?? '';
    return {
      // The RFC 5322 Message-ID survives the message being moved between folders;
      // the Graph id does not. It is what makes a re-run a no-op.
      externalId: m.internetMessageId ?? `graph:${m.id}`,
      threadId: m.conversationId ?? null,
      inReplyTo: header('in-reply-to'),
      fromEmail,
      fromName: m.from?.emailAddress?.name ?? null,
      subject: m.subject ?? '',
      receivedAt: m.receivedDateTime ?? new Date().toISOString(),
      bodyText:
        skipped.length > 0 ? `${body}\n\n[Attachments not collected: ${skipped.join('; ')}]` : body,
      attachments,
      simulated: false,
    };
  }

  /** A GET that turns every Graph failure into a CollectFailure with a plain reason. */
  private async get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    let token: string;
    try {
      token = await this.token(this.cfg);
    } catch (err) {
      throw new CollectFailure(err instanceof Error ? err.message : 'Could not obtain a Graph token.', false);
    }
    let res: Response;
    try {
      res = await this.http(url, { headers: { authorization: `Bearer ${token}`, ...headers } });
    } catch (err) {
      throw new CollectFailure(
        `Could not reach Microsoft Graph: ${err instanceof Error ? err.message : 'network error'}.`,
        true,
      );
    }
    if (res.ok) return res;

    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? '';
    if (res.status === 410 || /syncStateNotFound|resyncRequired|syncStateInvalid/i.test(code)) {
      throw new CollectFailure(
        'The saved mailbox position has expired, so collection will start again from the last successful run.',
        true,
        true,
      );
    }
    const retryable = res.status === 429 || res.status >= 500;
    const wait = res.headers.get('retry-after');
    throw new CollectFailure(
      `Microsoft Graph returned ${res.status}${code ? ` ${code}` : ''}${body.error?.message ? `: ${body.error.message}` : ''}${retryable && wait ? ` Retry after ${wait}s.` : ''}`,
      retryable,
    );
  }
}

/* -------------------------------- Resolution -------------------------------- */

export function resolveMailbox(): MailboxSource {
  if (demoWorkspaceActive() || (process.env.MAILBOX_ADAPTER ?? 'simulated') !== 'graph') return new SimulatedMailbox();
  const { config } = graphConfig();
  if (!config) return new SimulatedMailbox();
  return new GraphMailbox(config);
}

/** Status for display, including why a live mailbox is not in use. */
export function mailboxStatusForDisplay(): MailboxStatus {
  const requested = demoWorkspaceActive() ? 'simulated' : (process.env.MAILBOX_ADAPTER ?? 'simulated');
  if (requested !== 'graph') return new SimulatedMailbox().status();
  const { config, missing } = graphConfig();
  if (!config) {
    return {
      ...new SimulatedMailbox().status(),
      label: 'Simulated mailbox (Graph requested but not configured)',
      detail:
        'MAILBOX_ADAPTER is set to graph, but the app registration is incomplete, so no real mailbox is read.',
      setupRequirements: missing.map((k) => `Set ${k}.`),
    };
  }
  return new GraphMailbox(config).status();
}
