/**
 * Outbound mail boundary.
 *
 * INTEGRATION HONESTY
 * -------------------
 * Two implementations ship:
 *
 *   - `SimulatedTransport` (default). Nothing leaves the machine. Every email it
 *     "sends" is marked `simulated: true` on the record and the UI labels it as
 *     simulated wherever it appears. It is never presented as a real send.
 *   - `GraphTransport`. A real Microsoft Graph `sendMail` call. It is only
 *     selected when MAIL_ADAPTER=graph *and* the app registration variables are
 *     present, and `probe()` must succeed before the UI will describe the
 *     mailbox as connected.
 *
 * The Graph path is written in full but has NOT been verified against a live
 * tenant from this environment - no app registration was available. See
 * docs/FREIGHT_SETUP.md for exactly what is required to activate and verify it.
 */

export interface OutboundMessage {
  to: { name: string | null; email: string }[];
  cc: { name: string | null; email: string }[];
  subject: string;
  bodyText: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
  /** Threaded onto replies so inbound matching can use the conversation id. */
  references?: string | null;
}

export interface SendResult {
  messageId: string;
  simulated: boolean;
}

export interface TransportStatus {
  /** Shown verbatim in the UI. Never says "connected" without a good probe. */
  label: string;
  kind: 'simulated' | 'graph';
  connected: boolean;
  detail: string;
  /** Configuration that is still missing before a live send is possible. */
  setupRequirements: string[];
  lastProbedAt?: string;
}

export interface MailTransport {
  status(): TransportStatus;
  probe(): Promise<TransportStatus>;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** Thrown for a send failure the user can sensibly retry. */
export class SendFailure extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'SendFailure';
  }
}

/* ------------------------------- Simulated ---------------------------------- */

/**
 * A local stand-in for a mail server.
 *
 * It deliberately fails for any address in the `@bounce.invalid` domain so the
 * demo can exercise a real failure and retry path rather than only the happy
 * one. Nothing else about it is random: the same input always gives the same
 * result, which keeps the demo reproducible.
 */
export class SimulatedTransport implements MailTransport {
  status(): TransportStatus {
    return {
      label: 'Simulated mail',
      kind: 'simulated',
      connected: false,
      detail:
        'Email is prepared, approved and recorded exactly as it would be in production, but nothing is transmitted. No message reaches a provider.',
      setupRequirements: [
        'Set MAIL_ADAPTER=graph and supply the Microsoft Graph app registration to send real email.',
      ],
    };
  }

  async probe(): Promise<TransportStatus> {
    return { ...this.status(), lastProbedAt: new Date().toISOString() };
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const bad = [...msg.to, ...msg.cc].find((r) => r.email.toLowerCase().endsWith('@bounce.invalid'));
    if (bad) {
      throw new SendFailure(
        `The mail server rejected ${bad.email}: mailbox unavailable (simulated 550). Correct the address and send again.`,
      );
    }
    if (msg.to.length === 0) {
      throw new SendFailure('There is no recipient on this email.', false);
    }
    return {
      messageId: `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      simulated: true,
    };
  }
}

/* --------------------------------- Graph ------------------------------------ */

interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
}

export function graphConfig(): { config: GraphConfig | null; missing: string[] } {
  const keys = {
    tenantId: process.env.GRAPH_TENANT_ID,
    clientId: process.env.GRAPH_CLIENT_ID,
    clientSecret: process.env.GRAPH_CLIENT_SECRET,
    mailbox: process.env.GRAPH_MAILBOX,
  };
  const missing = Object.entries(keys)
    .filter(([, v]) => !v)
    .map(([k]) => `GRAPH_${k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`.replace('GRAPH__', 'GRAPH_'));
  if (missing.length > 0) return { config: null, missing };
  return { config: keys as GraphConfig, missing: [] };
}

/** Client-credentials token. Cached until shortly before it expires. */
let tokenCache: { token: string; expiresAt: number } | null = null;

export async function graphToken(cfg: GraphConfig): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    // The response body can contain the client secret in an error echo, so only
    // the status and the AAD error code are surfaced.
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new SendFailure(
      `Microsoft Entra rejected the app credentials (${res.status}${detail.error ? ` ${detail.error}` : ''}).`,
      false,
    );
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

export class GraphTransport implements MailTransport {
  private lastProbe: TransportStatus | null = null;

  constructor(private readonly cfg: GraphConfig) {}

  status(): TransportStatus {
    if (this.lastProbe) return this.lastProbe;
    return {
      label: 'Microsoft 365 mailbox (not yet checked)',
      kind: 'graph',
      connected: false,
      detail: `Configured for ${this.cfg.mailbox}. The connection has not been checked in this session, so it is not described as connected yet.`,
      setupRequirements: [],
    };
  }

  async probe(): Promise<TransportStatus> {
    try {
      const token = await graphToken(this.cfg);
      // Reads the mailbox's Sent Items folder rather than the user profile:
      // GET /users/{id} needs User.Read.All, which the setup guide does not ask
      // for, so it would fail on a correctly configured app. Mail.ReadWrite
      // covers this call. It proves the token and the mailbox scope; Mail.Send
      // itself is only proven by the first real send.
      const res = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.cfg.mailbox)}/mailFolders/sentitems?$select=id`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        this.lastProbe = {
          label: 'Microsoft 365 mailbox unavailable',
          kind: 'graph',
          connected: false,
          detail: `Graph returned ${res.status} for ${this.cfg.mailbox}. ${detail.error?.message ?? ''}`.trim(),
          setupRequirements: [
            'Grant the app registration Mail.Send and Mail.ReadWrite application permissions, with admin consent.',
            'Confirm the mailbox address exists and is inside an ApplicationAccessPolicy that permits this app.',
          ],
          lastProbedAt: new Date().toISOString(),
        };
        return this.lastProbe;
      }
      this.lastProbe = {
        label: 'Microsoft 365 mailbox connected',
        kind: 'graph',
        connected: true,
        detail: `Connected to ${this.cfg.mailbox}. Approved email will be delivered for real. Permission to send is confirmed by the first send; test with an internal address first.`,
        setupRequirements: [],
        lastProbedAt: new Date().toISOString(),
      };
      return this.lastProbe;
    } catch (err) {
      this.lastProbe = {
        label: 'Microsoft 365 mailbox unavailable',
        kind: 'graph',
        connected: false,
        detail: err instanceof Error ? err.message : 'The connection check failed.',
        setupRequirements: ['Check network access to login.microsoftonline.com and graph.microsoft.com.'],
        lastProbedAt: new Date().toISOString(),
      };
      return this.lastProbe;
    }
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const token = await graphToken(this.cfg);
    const payload = {
      message: {
        subject: msg.subject,
        body: { contentType: 'Text', content: msg.bodyText },
        toRecipients: msg.to.map((r) => ({ emailAddress: { address: r.email, name: r.name ?? undefined } })),
        ccRecipients: msg.cc.map((r) => ({ emailAddress: { address: r.email, name: r.name ?? undefined } })),
        attachments: msg.attachments.map((a) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: a.filename,
          contentType: a.contentType,
          contentBytes: a.content.toString('base64'),
        })),
      },
      saveToSentItems: true,
    };
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.cfg.mailbox)}/sendMail`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
      // 429 and 5xx are worth retrying; a 4xx is a content or permission problem.
      const retryable = res.status === 429 || res.status >= 500;
      throw new SendFailure(
        `Microsoft Graph refused the send (${res.status}${detail.error?.code ? ` ${detail.error.code}` : ''}). ${detail.error?.message ?? ''}`.trim(),
        retryable,
      );
    }
    // sendMail returns 202 with no body and no message id. The id is only
    // discoverable afterwards from Sent Items, so it is not fabricated here.
    return { messageId: `graph-accepted-${Date.now().toString(36)}`, simulated: false };
  }
}

/* -------------------------------- Resolution -------------------------------- */

export function resolveMailTransport(): MailTransport {
  if ((process.env.MAIL_ADAPTER ?? 'simulated') !== 'graph') return new SimulatedTransport();
  const { config } = graphConfig();
  if (!config) return new SimulatedTransport();
  return new GraphTransport(config);
}

/** Status for display, including why a live transport is not in use. */
export function mailStatusForDisplay(): TransportStatus {
  const requested = process.env.MAIL_ADAPTER ?? 'simulated';
  if (requested !== 'graph') return new SimulatedTransport().status();
  const { config, missing } = graphConfig();
  if (!config) {
    const base = new SimulatedTransport().status();
    return {
      ...base,
      label: 'Simulated mail (Graph requested but not configured)',
      detail:
        'MAIL_ADAPTER is set to graph, but the app registration is incomplete, so nothing is transmitted. The workflow continues to run against the simulated transport.',
      setupRequirements: missing.map((k) => `Set ${k}.`),
    };
  }
  return new GraphTransport(config).status();
}
