/**
 * Data access for the freight module.
 *
 * COMPANY ISOLATION
 * -----------------
 * Every read and write that touches company-owned data takes a `Ctx` carrying
 * the acting user. Helpers that can cross a company boundary call
 * `assertCompanyAccess` first, so a crafted request cannot reach another
 * company's providers, RFQs or quotes. The UI's company picker is a convenience,
 * not the control.
 */

import { randomUUID } from 'node:crypto';
import { db, json, bool, str, tx } from './db';
import type {
  AuditEvent,
  Company,
  ContainerType,
  CompanyProvider,
  Comparison,
  ComparisonLine,
  EmailAttachment,
  EmailDraft,
  ErpSync,
  Extracted,
  Id,
  InboundMessage,
  Instant,
  Lane,
  MatchCandidate,
  Provider,
  ProviderContact,
  Quote,
  RankingCriteria,
  Recipient,
  Rfq,
  RfqRecipient,
  Surcharge,
  User,
} from './types';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function now(): Instant {
  return new Date().toISOString();
}

/* --------------------------------- Errors ---------------------------------- */

export class FreightError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** Machine-readable so the UI can react without string-matching. */
    readonly code = 'invalid_request',
  ) {
    super(message);
    this.name = 'FreightError';
  }
}

export const notFound = (what: string) => new FreightError(`${what} was not found.`, 404, 'not_found');
export const forbidden = (why: string) => new FreightError(why, 403, 'forbidden');

/* -------------------------------- Context ---------------------------------- */

export interface Ctx {
  user: User;
}

export function assertCompanyAccess(ctx: Ctx, companyId: Id): void {
  if (!ctx.user.companyIds.includes(companyId)) {
    throw forbidden('You do not have access to that company.');
  }
}

export function assertCanApprove(ctx: Ctx): void {
  if (ctx.user.role !== 'logistics_manager') {
    throw forbidden(
      'Only the Logistics Operations Manager can approve an email for sending. Ask a manager to review this draft.',
    );
  }
}

export function assertCanEdit(ctx: Ctx): void {
  if (ctx.user.role === 'viewer') {
    throw forbidden('Your access is read-only.');
  }
  if (ctx.user.role === 'system_mailbox_collector') {
    throw forbidden('The Mailbox Collector only files incoming replies. A person has to make this change.');
  }
}

/* --------------------------------- Users ----------------------------------- */

export function listUsers(): User[] {
  return (db().prepare('SELECT * FROM users ORDER BY name').all() as Record<string, unknown>[]).map(
    rowToUser,
  );
}

export function getUser(id: Id): User | null {
  const row = db().prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToUser(row) : null;
}

export function insertUser(u: User): void {
  db()
    .prepare(
      'INSERT INTO users (id, name, title, email, role, company_ids, disabled, external_id) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(u.id, u.name, u.title, u.email, u.role, JSON.stringify(u.companyIds), u.disabled ? 1 : 0, u.externalId ?? null);
}

export function updateUser(u: User): void {
  db()
    .prepare(
      'UPDATE users SET name = ?, title = ?, email = ?, role = ?, company_ids = ?, disabled = ?, external_id = ? WHERE id = ?',
    )
    .run(u.name, u.title, u.email, u.role, JSON.stringify(u.companyIds), u.disabled ? 1 : 0, u.externalId ?? null, u.id);
}

export function findUserByEmail(email: string): User | null {
  const row = db().prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email.trim()) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToUser(row) : null;
}

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    name: r.name as string,
    title: r.title as string,
    email: r.email as string,
    role: r.role as User['role'],
    companyIds: json<string[]>(r.company_ids, []),
    disabled: bool(r.disabled),
    externalId: str(r.external_id),
  };
}

/* ------------------------------- Companies --------------------------------- */

export function listCompanies(ctx: Ctx): Company[] {
  return (db().prepare('SELECT * FROM companies ORDER BY name').all() as Record<string, unknown>[])
    .map(rowToCompany)
    .filter((c) => ctx.user.companyIds.includes(c.id));
}

/**
 * Every company id, ignoring the acting user. Only for the Mailbox Collector,
 * which files replies from the one shared mailbox on behalf of all companies.
 */
export function listAllCompanyIds(): Id[] {
  return (db().prepare('SELECT id FROM companies ORDER BY id').all() as { id: string }[]).map((r) => r.id);
}

export function getCompany(ctx: Ctx, id: Id): Company {
  assertCompanyAccess(ctx, id);
  const row = db().prepare('SELECT * FROM companies WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('That company');
  return rowToCompany(row);
}

export function insertCompany(c: Company): void {
  db()
    .prepare(
      'INSERT INTO companies (id, code, name, country, status, address_lines, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(c.id, c.code, c.name, c.country, c.status, JSON.stringify(c.addressLines), c.createdAt);
}

function rowToCompany(r: Record<string, unknown>): Company {
  return {
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    country: r.country as string,
    status: r.status as Company['status'],
    addressLines: json<string[]>(r.address_lines, []),
    createdAt: r.created_at as string,
  };
}

/* ------------------------------- Providers --------------------------------- */

export function listProviders(): Provider[] {
  return (db().prepare('SELECT * FROM providers ORDER BY name').all() as Record<string, unknown>[]).map(
    rowToProvider,
  );
}

export function getProvider(id: Id): Provider | null {
  const row = db().prepare('SELECT * FROM providers WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToProvider(row) : null;
}

/** Normalised lookup used by the importer to detect an existing provider. */
export function findProviderByName(name: string): Provider | null {
  const row = db()
    .prepare('SELECT * FROM providers WHERE lower(trim(name)) = lower(trim(?))')
    .get(name) as Record<string, unknown> | undefined;
  return row ? rowToProvider(row) : null;
}

export function insertProvider(p: Provider): void {
  db()
    .prepare(
      'INSERT INTO providers (id, name, kind, country, website, general_email, notes, created_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run(p.id, p.name, p.kind, p.country, p.website, p.generalEmail, p.notes, p.createdAt);
}

export function updateProvider(p: Provider): void {
  db()
    .prepare(
      'UPDATE providers SET name=?, kind=?, country=?, website=?, general_email=?, notes=? WHERE id=?',
    )
    .run(p.name, p.kind, p.country, p.website, p.generalEmail, p.notes, p.id);
}

function rowToProvider(r: Record<string, unknown>): Provider {
  return {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as string,
    country: r.country as string,
    website: str(r.website),
    generalEmail: str(r.general_email),
    notes: str(r.notes),
    createdAt: r.created_at as string,
  };
}

/* --------------------------- Company providers ------------------------------ */

/** A provider joined with this company's relationship and contacts. */
export interface ProviderView {
  link: CompanyProvider;
  provider: Provider;
  contacts: ProviderContact[];
}

export function listCompanyProviders(ctx: Ctx, companyId: Id): ProviderView[] {
  assertCompanyAccess(ctx, companyId);
  const links = (
    db()
      .prepare('SELECT * FROM company_providers WHERE company_id = ?')
      .all(companyId) as Record<string, unknown>[]
  ).map(rowToLink);
  const out: ProviderView[] = [];
  for (const link of links) {
    const provider = getProvider(link.providerId);
    if (!provider) continue;
    out.push({ link, provider, contacts: listContacts(link.id) });
  }
  return out.sort((a, b) => a.provider.name.localeCompare(b.provider.name));
}

export function getCompanyProvider(ctx: Ctx, id: Id): ProviderView {
  const row = db().prepare('SELECT * FROM company_providers WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('That provider relationship');
  const link = rowToLink(row);
  assertCompanyAccess(ctx, link.companyId);
  const provider = getProvider(link.providerId);
  if (!provider) throw notFound('That provider');
  return { link, provider, contacts: listContacts(link.id) };
}

export function findCompanyProvider(companyId: Id, providerId: Id): CompanyProvider | null {
  const row = db()
    .prepare('SELECT * FROM company_providers WHERE company_id = ? AND provider_id = ?')
    .get(companyId, providerId) as Record<string, unknown> | undefined;
  return row ? rowToLink(row) : null;
}

export function insertCompanyProvider(l: CompanyProvider): void {
  db()
    .prepare(
      'INSERT INTO company_providers (id, company_id, provider_id, status, restriction_reason, account_ref, lanes, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      l.id,
      l.companyId,
      l.providerId,
      l.status,
      l.restrictionReason,
      l.accountRef,
      JSON.stringify(l.lanes),
      l.notes,
      l.createdAt,
    );
}

export function updateCompanyProvider(l: CompanyProvider): void {
  db()
    .prepare(
      'UPDATE company_providers SET status=?, restriction_reason=?, account_ref=?, lanes=?, notes=? WHERE id=?',
    )
    .run(l.status, l.restrictionReason, l.accountRef, JSON.stringify(l.lanes), l.notes, l.id);
}

function rowToLink(r: Record<string, unknown>): CompanyProvider {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    providerId: r.provider_id as string,
    status: r.status as CompanyProvider['status'],
    restrictionReason: str(r.restriction_reason),
    accountRef: str(r.account_ref),
    lanes: json<Lane[]>(r.lanes, []),
    notes: str(r.notes),
    createdAt: r.created_at as string,
  };
}

export function listContacts(companyProviderId: Id): ProviderContact[] {
  return (
    db()
      .prepare('SELECT * FROM provider_contacts WHERE company_provider_id = ? ORDER BY is_primary DESC, name')
      .all(companyProviderId) as Record<string, unknown>[]
  ).map((r) => ({
    id: r.id as string,
    companyProviderId: r.company_provider_id as string,
    name: r.name as string,
    email: r.email as string,
    role: str(r.role),
    isPrimary: bool(r.is_primary),
  }));
}

export function insertContact(c: ProviderContact): void {
  db()
    .prepare(
      'INSERT INTO provider_contacts (id, company_provider_id, name, email, role, is_primary) VALUES (?,?,?,?,?,?) ON CONFLICT(company_provider_id, email) DO UPDATE SET name=excluded.name, role=excluded.role, is_primary=excluded.is_primary',
    )
    .run(c.id, c.companyProviderId, c.name, c.email.toLowerCase().trim(), c.role, c.isPrimary ? 1 : 0);
}

export function deleteContact(id: Id): void {
  db().prepare('DELETE FROM provider_contacts WHERE id = ?').run(id);
}

/** Reverse lookup used when associating an inbound reply with a provider. */
export function findLinksByContactEmail(email: string): { link: CompanyProvider; contact: ProviderContact }[] {
  const rows = db()
    .prepare(
      'SELECT pc.*, cp.id AS link_id FROM provider_contacts pc JOIN company_providers cp ON cp.id = pc.company_provider_id WHERE lower(pc.email) = lower(?)',
    )
    .all(email.trim()) as Record<string, unknown>[];
  const out: { link: CompanyProvider; contact: ProviderContact }[] = [];
  for (const r of rows) {
    const linkRow = db()
      .prepare('SELECT * FROM company_providers WHERE id = ?')
      .get(r.link_id as string) as Record<string, unknown> | undefined;
    if (!linkRow) continue;
    out.push({
      link: rowToLink(linkRow),
      contact: {
        id: r.id as string,
        companyProviderId: r.company_provider_id as string,
        name: r.name as string,
        email: r.email as string,
        role: str(r.role),
        isPrimary: bool(r.is_primary),
      },
    });
  }
  return out;
}

/* ---------------------------------- RFQs ------------------------------------ */

export function listRfqs(ctx: Ctx, companyId?: Id): Rfq[] {
  const allowed = ctx.user.companyIds;
  if (companyId) assertCompanyAccess(ctx, companyId);
  const rows = (
    companyId
      ? db().prepare('SELECT * FROM rfqs WHERE company_id = ? ORDER BY created_at DESC').all(companyId)
      : db().prepare('SELECT * FROM rfqs ORDER BY created_at DESC').all()
  ) as Record<string, unknown>[];
  return rows.map(rowToRfq).filter((r) => allowed.includes(r.companyId));
}

export function getRfq(ctx: Ctx, id: Id): Rfq {
  const row = db().prepare('SELECT * FROM rfqs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('That RFQ');
  const rfq = rowToRfq(row);
  assertCompanyAccess(ctx, rfq.companyId);
  return rfq;
}

export function getRfqUnscoped(id: Id): Rfq | null {
  const row = db().prepare('SELECT * FROM rfqs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRfq(row) : null;
}

export function insertRfq(r: Rfq): void {
  db()
    .prepare(
      'INSERT INTO rfqs (id, reference, company_id, title, origin_port, destination_port, incoterm, containers, cargo_notes, target_ship_from, target_ship_to, response_deadline, instructions, requested_currency, status, created_by, created_at, closed_at, closed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      r.id,
      r.reference,
      r.companyId,
      r.title,
      r.originPort,
      r.destinationPort,
      r.incoterm,
      JSON.stringify(r.containers),
      r.cargoNotes,
      r.targetShipFrom,
      r.targetShipTo,
      r.responseDeadline,
      r.instructions,
      r.requestedCurrency,
      r.status,
      r.createdBy,
      r.createdAt,
      r.closedAt,
      r.closedBy,
    );
}

export function updateRfq(r: Rfq): void {
  db()
    .prepare(
      'UPDATE rfqs SET title=?, origin_port=?, destination_port=?, incoterm=?, containers=?, cargo_notes=?, target_ship_from=?, target_ship_to=?, response_deadline=?, instructions=?, requested_currency=?, status=?, closed_at=?, closed_by=? WHERE id=?',
    )
    .run(
      r.title,
      r.originPort,
      r.destinationPort,
      r.incoterm,
      JSON.stringify(r.containers),
      r.cargoNotes,
      r.targetShipFrom,
      r.targetShipTo,
      r.responseDeadline,
      r.instructions,
      r.requestedCurrency,
      r.status,
      r.closedAt,
      r.closedBy,
      r.id,
    );
}

function rowToRfq(r: Record<string, unknown>): Rfq {
  return {
    id: r.id as string,
    reference: r.reference as string,
    companyId: r.company_id as string,
    title: r.title as string,
    originPort: r.origin_port as string,
    destinationPort: r.destination_port as string,
    incoterm: r.incoterm as Rfq['incoterm'],
    containers: json(r.containers, []),
    cargoNotes: str(r.cargo_notes),
    targetShipFrom: r.target_ship_from as string,
    targetShipTo: r.target_ship_to as string,
    responseDeadline: r.response_deadline as string,
    instructions: str(r.instructions),
    requestedCurrency: r.requested_currency as string,
    status: r.status as Rfq['status'],
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    closedAt: str(r.closed_at),
    closedBy: str(r.closed_by),
  };
}

/** Sequential, human-friendly reference: RFQ-MPD-2026-0007. */
export function nextRfqReference(companyCode: string, year: number): string {
  const prefix = `RFQ-${companyCode}-${year}-`;
  const row = db()
    .prepare('SELECT reference FROM rfqs WHERE reference LIKE ? ORDER BY reference DESC LIMIT 1')
    .get(`${prefix}%`) as { reference: string } | undefined;
  const last = row ? Number.parseInt(row.reference.slice(prefix.length), 10) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  return prefix + String(next).padStart(4, '0');
}

/* ------------------------------- Recipients --------------------------------- */

export function listRecipients(rfqId: Id): RfqRecipient[] {
  return (
    db().prepare('SELECT * FROM rfq_recipients WHERE rfq_id = ?').all(rfqId) as Record<string, unknown>[]
  ).map(rowToRecipient);
}

export function findRecipient(rfqId: Id, companyProviderId: Id): RfqRecipient | null {
  const row = db()
    .prepare('SELECT * FROM rfq_recipients WHERE rfq_id = ? AND company_provider_id = ?')
    .get(rfqId, companyProviderId) as Record<string, unknown> | undefined;
  return row ? rowToRecipient(row) : null;
}

export function insertRecipient(r: RfqRecipient): void {
  db()
    .prepare(
      'INSERT INTO rfq_recipients (id, rfq_id, company_provider_id, status, sent_at, first_response_at, reminders_sent, last_reminder_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(rfq_id, company_provider_id) DO NOTHING',
    )
    .run(r.id, r.rfqId, r.companyProviderId, r.status, r.sentAt, r.firstResponseAt, r.remindersSent, r.lastReminderAt);
}

export function updateRecipient(r: RfqRecipient): void {
  db()
    .prepare(
      'UPDATE rfq_recipients SET status=?, sent_at=?, first_response_at=?, reminders_sent=?, last_reminder_at=? WHERE id=?',
    )
    .run(r.status, r.sentAt, r.firstResponseAt, r.remindersSent, r.lastReminderAt, r.id);
}

export function deleteRecipients(rfqId: Id): void {
  db().prepare('DELETE FROM rfq_recipients WHERE rfq_id = ?').run(rfqId);
}

function rowToRecipient(r: Record<string, unknown>): RfqRecipient {
  return {
    id: r.id as string,
    rfqId: r.rfq_id as string,
    companyProviderId: r.company_provider_id as string,
    status: r.status as RfqRecipient['status'],
    sentAt: str(r.sent_at),
    firstResponseAt: str(r.first_response_at),
    remindersSent: Number(r.reminders_sent ?? 0),
    lastReminderAt: str(r.last_reminder_at),
  };
}

/* --------------------------------- Emails ----------------------------------- */

export function listEmails(ctx: Ctx, filter: { rfqId?: Id; status?: string } = {}): EmailDraft[] {
  const rows = (
    filter.rfqId
      ? db().prepare('SELECT * FROM emails WHERE rfq_id = ? ORDER BY created_at').all(filter.rfqId)
      : db().prepare('SELECT * FROM emails ORDER BY created_at DESC').all()
  ) as Record<string, unknown>[];
  return rows
    .map(rowToEmail)
    .filter((e) => ctx.user.companyIds.includes(e.companyId))
    .filter((e) => (filter.status ? e.status === filter.status : true));
}

export function getEmail(ctx: Ctx, id: Id): EmailDraft {
  const row = db().prepare('SELECT * FROM emails WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('That email');
  const email = rowToEmail(row);
  assertCompanyAccess(ctx, email.companyId);
  return email;
}

export function findEmailByIdempotencyKey(key: string): EmailDraft | null {
  const row = db().prepare('SELECT * FROM emails WHERE idempotency_key = ?').get(key) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEmail(row) : null;
}

export function insertEmail(e: EmailDraft): void {
  db()
    .prepare(
      'INSERT INTO emails (id, company_id, rfq_id, kind, company_provider_id, to_json, cc_json, subject, body_text, attachments, content_hash, status, approved_by, approved_at, approved_hash, sent_at, transport_message_id, simulated, failure_reason, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      e.id,
      e.companyId,
      e.rfqId,
      e.kind,
      e.companyProviderId,
      JSON.stringify(e.to),
      JSON.stringify(e.cc),
      e.subject,
      e.bodyText,
      JSON.stringify(e.attachments),
      e.contentHash,
      e.status,
      e.approvedBy,
      e.approvedAt,
      e.approvedHash,
      e.sentAt,
      e.transportMessageId,
      e.simulated ? 1 : 0,
      e.failureReason,
      e.idempotencyKey,
      e.createdAt,
      e.updatedAt,
    );
}

export function updateEmail(e: EmailDraft): void {
  db()
    .prepare(
      'UPDATE emails SET to_json=?, cc_json=?, subject=?, body_text=?, attachments=?, content_hash=?, status=?, approved_by=?, approved_at=?, approved_hash=?, sent_at=?, transport_message_id=?, simulated=?, failure_reason=?, updated_at=? WHERE id=?',
    )
    .run(
      JSON.stringify(e.to),
      JSON.stringify(e.cc),
      e.subject,
      e.bodyText,
      JSON.stringify(e.attachments),
      e.contentHash,
      e.status,
      e.approvedBy,
      e.approvedAt,
      e.approvedHash,
      e.sentAt,
      e.transportMessageId,
      e.simulated ? 1 : 0,
      e.failureReason,
      e.updatedAt,
      e.id,
    );
}

export function deleteEmail(id: Id): void {
  db().prepare('DELETE FROM emails WHERE id = ?').run(id);
}

function rowToEmail(r: Record<string, unknown>): EmailDraft {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    rfqId: r.rfq_id as string,
    kind: r.kind as EmailDraft['kind'],
    companyProviderId: str(r.company_provider_id),
    to: json<Recipient[]>(r.to_json, []),
    cc: json<Recipient[]>(r.cc_json, []),
    subject: r.subject as string,
    bodyText: r.body_text as string,
    attachments: json<EmailAttachment[]>(r.attachments, []),
    contentHash: r.content_hash as string,
    status: r.status as EmailDraft['status'],
    approvedBy: str(r.approved_by),
    approvedAt: str(r.approved_at),
    approvedHash: str(r.approved_hash),
    sentAt: str(r.sent_at),
    transportMessageId: str(r.transport_message_id),
    simulated: bool(r.simulated),
    failureReason: str(r.failure_reason),
    idempotencyKey: r.idempotency_key as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/* ----------------------------- Inbound messages ------------------------------ */

export function listInbound(ctx: Ctx, filter: { rfqId?: Id; matchStatus?: string } = {}): InboundMessage[] {
  const rows = db().prepare('SELECT * FROM inbound_messages ORDER BY received_at DESC').all() as Record<
    string,
    unknown
  >[];
  return rows
    .map(rowToInbound)
    .filter((m) => (filter.rfqId ? m.rfqId === filter.rfqId : true))
    .filter((m) => (filter.matchStatus ? m.matchStatus === filter.matchStatus : true))
    .filter((m) => {
      // Unmatched mail has no company yet, so it is visible to any user who can
      // act on at least one company - that is the whole point of the review queue.
      if (!m.rfqId) return true;
      const rfq = getRfqUnscoped(m.rfqId);
      return rfq ? ctx.user.companyIds.includes(rfq.companyId) : false;
    });
}

export function getInbound(id: Id): InboundMessage | null {
  const row = db().prepare('SELECT * FROM inbound_messages WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToInbound(row) : null;
}

export function findInboundByExternalId(externalId: string): InboundMessage | null {
  const row = db().prepare('SELECT * FROM inbound_messages WHERE external_id = ?').get(externalId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToInbound(row) : null;
}

export function insertInbound(m: InboundMessage): void {
  db()
    .prepare(
      'INSERT INTO inbound_messages (id, external_id, thread_id, in_reply_to, from_email, from_name, subject, received_at, body_text, attachments, match_status, match_basis, rfq_id, company_provider_id, candidates, reviewed_by, reviewed_at, simulated, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      m.id,
      m.externalId,
      m.threadId,
      m.inReplyTo,
      m.fromEmail,
      m.fromName,
      m.subject,
      m.receivedAt,
      m.bodyText,
      JSON.stringify(m.attachments),
      m.matchStatus,
      m.matchBasis,
      m.rfqId,
      m.companyProviderId,
      JSON.stringify(m.candidates),
      m.reviewedBy,
      m.reviewedAt,
      m.simulated ? 1 : 0,
      m.createdAt,
    );
}

export function updateInbound(m: InboundMessage): void {
  db()
    .prepare(
      'UPDATE inbound_messages SET match_status=?, match_basis=?, rfq_id=?, company_provider_id=?, candidates=?, reviewed_by=?, reviewed_at=? WHERE id=?',
    )
    .run(
      m.matchStatus,
      m.matchBasis,
      m.rfqId,
      m.companyProviderId,
      JSON.stringify(m.candidates),
      m.reviewedBy,
      m.reviewedAt,
      m.id,
    );
}

function rowToInbound(r: Record<string, unknown>): InboundMessage {
  return {
    id: r.id as string,
    externalId: r.external_id as string,
    threadId: str(r.thread_id),
    inReplyTo: str(r.in_reply_to),
    fromEmail: r.from_email as string,
    fromName: str(r.from_name),
    subject: r.subject as string,
    receivedAt: r.received_at as string,
    bodyText: r.body_text as string,
    attachments: json<EmailAttachment[]>(r.attachments, []),
    matchStatus: r.match_status as InboundMessage['matchStatus'],
    matchBasis: r.match_basis as string,
    rfqId: str(r.rfq_id),
    companyProviderId: str(r.company_provider_id),
    candidates: json<MatchCandidate[]>(r.candidates, []),
    reviewedBy: str(r.reviewed_by),
    reviewedAt: str(r.reviewed_at),
    simulated: bool(r.simulated),
    createdAt: r.created_at as string,
  };
}

/* --------------------------------- Quotes ------------------------------------ */

/** The `Extracted`/`Surcharge` fields are stored as one JSON blob. */
type QuoteFields = Pick<
  Quote,
  | 'shippingLine'
  | 'originPort'
  | 'destinationPort'
  | 'currency'
  | 'containerBasis'
  | 'baseFreight'
  | 'surcharges'
  | 'totalQuoted'
  | 'transitDays'
  | 'freeDaysDestination'
  | 'validUntil'
  | 'sailingDate'
  | 'paymentTerms'
  | 'inclusions'
  | 'exclusions'
  | 'conditions'
>;

export function emptyExtracted<T>(note: string | null = null): Extracted<T> {
  return {
    value: null,
    confidence: 'missing',
    sourceRef: null,
    sourceText: null,
    correctedBy: null,
    correctedAt: null,
    note,
  };
}

export function listQuotes(ctx: Ctx, rfqId: Id): Quote[] {
  const rfq = getRfq(ctx, rfqId);
  return (
    db()
      .prepare('SELECT * FROM quotes WHERE rfq_id = ? ORDER BY created_at')
      .all(rfq.id) as Record<string, unknown>[]
  ).map(rowToQuote);
}

export function getQuote(ctx: Ctx, id: Id): Quote {
  const row = db().prepare('SELECT * FROM quotes WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('That quotation');
  const q = rowToQuote(row);
  assertCompanyAccess(ctx, q.companyId);
  return q;
}

/** Highest existing version for a provider on an RFQ, 0 when none. */
export function latestQuoteVersion(rfqId: Id, companyProviderId: Id): number {
  const row = db()
    .prepare('SELECT MAX(version) AS v FROM quotes WHERE rfq_id = ? AND company_provider_id = ?')
    .get(rfqId, companyProviderId) as { v: number | null } | undefined;
  return row?.v ?? 0;
}

export function insertQuote(q: Quote): void {
  db()
    .prepare(
      'INSERT INTO quotes (id, company_id, rfq_id, company_provider_id, version, supersedes_quote_id, status, source_kind, source_message_id, source_attachment, unreadable_reason, fields, extractor_id, extracted_at, reviewed_by, reviewed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      q.id,
      q.companyId,
      q.rfqId,
      q.companyProviderId,
      q.version,
      q.supersedesQuoteId,
      q.status,
      q.sourceKind,
      q.sourceMessageId,
      q.sourceAttachment,
      q.unreadableReason,
      JSON.stringify(quoteFields(q)),
      q.extractorId,
      q.extractedAt,
      q.reviewedBy,
      q.reviewedAt,
      q.createdAt,
    );
}

export function updateQuote(q: Quote): void {
  db()
    .prepare('UPDATE quotes SET status=?, fields=?, reviewed_by=?, reviewed_at=?, unreadable_reason=? WHERE id=?')
    .run(q.status, JSON.stringify(quoteFields(q)), q.reviewedBy, q.reviewedAt, q.unreadableReason, q.id);
}

function quoteFields(q: Quote): QuoteFields {
  return {
    shippingLine: q.shippingLine,
    originPort: q.originPort,
    destinationPort: q.destinationPort,
    currency: q.currency,
    containerBasis: q.containerBasis,
    baseFreight: q.baseFreight,
    surcharges: q.surcharges,
    totalQuoted: q.totalQuoted,
    transitDays: q.transitDays,
    freeDaysDestination: q.freeDaysDestination,
    validUntil: q.validUntil,
    sailingDate: q.sailingDate,
    paymentTerms: q.paymentTerms,
    inclusions: q.inclusions,
    exclusions: q.exclusions,
    conditions: q.conditions,
  };
}

function rowToQuote(r: Record<string, unknown>): Quote {
  const f = json<Partial<QuoteFields>>(r.fields, {});
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    rfqId: r.rfq_id as string,
    companyProviderId: r.company_provider_id as string,
    version: Number(r.version),
    supersedesQuoteId: str(r.supersedes_quote_id),
    status: r.status as Quote['status'],
    sourceKind: r.source_kind as Quote['sourceKind'],
    sourceMessageId: str(r.source_message_id),
    sourceAttachment: str(r.source_attachment),
    unreadableReason: str(r.unreadable_reason),
    shippingLine: f.shippingLine ?? emptyExtracted<string>(),
    originPort: f.originPort ?? emptyExtracted<string>(),
    destinationPort: f.destinationPort ?? emptyExtracted<string>(),
    currency: f.currency ?? emptyExtracted<string>(),
    containerBasis: f.containerBasis ?? emptyExtracted<ContainerType>(),
    baseFreight: f.baseFreight ?? emptyExtracted<number>(),
    surcharges: f.surcharges ?? [],
    totalQuoted: f.totalQuoted ?? emptyExtracted<number>(),
    transitDays: f.transitDays ?? emptyExtracted<number>(),
    freeDaysDestination: f.freeDaysDestination ?? emptyExtracted<number>(),
    validUntil: f.validUntil ?? emptyExtracted<string>(),
    sailingDate: f.sailingDate ?? emptyExtracted<string>(),
    paymentTerms: f.paymentTerms ?? emptyExtracted<string>(),
    inclusions: f.inclusions ?? emptyExtracted<string[]>(),
    exclusions: f.exclusions ?? emptyExtracted<string[]>(),
    conditions: f.conditions ?? emptyExtracted<string[]>(),
    extractorId: r.extractor_id as string,
    extractedAt: r.extracted_at as string,
    reviewedBy: str(r.reviewed_by),
    reviewedAt: str(r.reviewed_at),
    createdAt: r.created_at as string,
  };
}

/* ------------------------------- Comparisons --------------------------------- */

interface ComparisonPayload {
  criteria: RankingCriteria;
  fxRates: Comparison['fxRates'];
  lines: ComparisonLine[];
  cheapestQuoteId: Id | null;
  recommendedQuoteId: Id | null;
  recommendationReasons: string[];
  recommendationTradeoffs: string[];
  blockedNotes: string[];
}

export function listComparisons(ctx: Ctx, rfqId?: Id): Comparison[] {
  const rows = (
    rfqId
      ? db().prepare('SELECT * FROM comparisons WHERE rfq_id = ? ORDER BY created_at DESC').all(rfqId)
      : db().prepare('SELECT * FROM comparisons ORDER BY created_at DESC').all()
  ) as Record<string, unknown>[];
  return rows.map(rowToComparison).filter((c) => ctx.user.companyIds.includes(c.companyId));
}

export function getComparison(ctx: Ctx, id: Id): Comparison {
  const row = db().prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('That comparison');
  const c = rowToComparison(row);
  assertCompanyAccess(ctx, c.companyId);
  return c;
}

/** The most recent comparison for an RFQ, which is the one the UI shows. */
export function latestComparison(ctx: Ctx, rfqId: Id): Comparison | null {
  return listComparisons(ctx, rfqId)[0] ?? null;
}

export function insertComparison(c: Comparison): void {
  const payload: ComparisonPayload = {
    criteria: c.criteria,
    fxRates: c.fxRates,
    lines: c.lines,
    cheapestQuoteId: c.cheapestQuoteId,
    recommendedQuoteId: c.recommendedQuoteId,
    recommendationReasons: c.recommendationReasons,
    recommendationTradeoffs: c.recommendationTradeoffs,
    blockedNotes: c.blockedNotes,
  };
  db()
    .prepare(
      'INSERT INTO comparisons (id, company_id, rfq_id, payload, workbook_key, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(c.id, c.companyId, c.rfqId, JSON.stringify(payload), c.workbookKey, c.createdBy, c.createdAt);
}

export function setComparisonWorkbook(id: Id, key: string): void {
  db().prepare('UPDATE comparisons SET workbook_key = ? WHERE id = ?').run(key, id);
}

function rowToComparison(r: Record<string, unknown>): Comparison {
  const p = json<Partial<ComparisonPayload>>(r.payload, {});
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    rfqId: r.rfq_id as string,
    criteria: p.criteria as RankingCriteria,
    fxRates: p.fxRates ?? [],
    lines: p.lines ?? [],
    cheapestQuoteId: p.cheapestQuoteId ?? null,
    recommendedQuoteId: p.recommendedQuoteId ?? null,
    recommendationReasons: p.recommendationReasons ?? [],
    recommendationTradeoffs: p.recommendationTradeoffs ?? [],
    blockedNotes: p.blockedNotes ?? [],
    workbookKey: str(r.workbook_key),
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

/* -------------------------------- ERP syncs ---------------------------------- */

export function listSyncs(ctx: Ctx): ErpSync[] {
  return (db().prepare('SELECT * FROM erp_syncs ORDER BY created_at DESC').all() as Record<string, unknown>[])
    .map(rowToSync)
    .filter((s) => ctx.user.companyIds.includes(s.companyId));
}

export function getSyncByComparison(comparisonId: Id): ErpSync | null {
  const row = db().prepare('SELECT * FROM erp_syncs WHERE comparison_id = ?').get(comparisonId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSync(row) : null;
}

export function getSync(ctx: Ctx, id: Id): ErpSync {
  const row = db().prepare('SELECT * FROM erp_syncs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw notFound('That ERPNext record');
  const s = rowToSync(row);
  assertCompanyAccess(ctx, s.companyId);
  return s;
}

export function insertSync(s: ErpSync): void {
  db()
    .prepare(
      'INSERT INTO erp_syncs (id, company_id, comparison_id, adapter, status, attempts, idempotency_key, doctype, remote_name, remote_url, last_error, setup_requirements, last_attempt_at, completed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      s.id,
      s.companyId,
      s.comparisonId,
      s.adapter,
      s.status,
      s.attempts,
      s.idempotencyKey,
      s.doctype,
      s.remoteName,
      s.remoteUrl,
      s.lastError,
      JSON.stringify(s.setupRequirements),
      s.lastAttemptAt,
      s.completedAt,
      s.createdAt,
    );
}

export function updateSync(s: ErpSync): void {
  db()
    .prepare(
      'UPDATE erp_syncs SET adapter=?, status=?, attempts=?, doctype=?, remote_name=?, remote_url=?, last_error=?, setup_requirements=?, last_attempt_at=?, completed_at=? WHERE id=?',
    )
    .run(
      s.adapter,
      s.status,
      s.attempts,
      s.doctype,
      s.remoteName,
      s.remoteUrl,
      s.lastError,
      JSON.stringify(s.setupRequirements),
      s.lastAttemptAt,
      s.completedAt,
      s.id,
    );
}

function rowToSync(r: Record<string, unknown>): ErpSync {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    comparisonId: r.comparison_id as string,
    adapter: r.adapter as ErpSync['adapter'],
    status: r.status as ErpSync['status'],
    attempts: Number(r.attempts ?? 0),
    idempotencyKey: r.idempotency_key as string,
    doctype: str(r.doctype),
    remoteName: str(r.remote_name),
    remoteUrl: str(r.remote_url),
    lastError: str(r.last_error),
    setupRequirements: json<string[]>(r.setup_requirements, []),
    lastAttemptAt: str(r.last_attempt_at),
    completedAt: str(r.completed_at),
    createdAt: r.created_at as string,
  };
}

/* ---------------------------------- Audit ------------------------------------ */

export function audit(
  ctx: Ctx | null,
  e: {
    companyId: Id | null;
    action: string;
    subject: string;
    summary: string;
    detail?: Record<string, unknown>;
  },
): void {
  db()
    .prepare(
      'INSERT INTO audit_events (id, company_id, actor_id, actor_name, action, subject, summary, detail, at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      newId('ev'),
      e.companyId,
      ctx?.user.id ?? null,
      ctx?.user.name ?? 'System',
      e.action,
      e.subject,
      e.summary,
      e.detail ? JSON.stringify(e.detail) : null,
      now(),
    );
}

export function listAudit(ctx: Ctx, filter: { subject?: string; limit?: number } = {}): AuditEvent[] {
  const limit = Math.min(filter.limit ?? 100, 500);
  const rows = (
    filter.subject
      ? db()
          .prepare('SELECT * FROM audit_events WHERE subject = ? ORDER BY at DESC LIMIT ?')
          .all(filter.subject, limit)
      : db().prepare('SELECT * FROM audit_events ORDER BY at DESC LIMIT ?').all(limit)
  ) as Record<string, unknown>[];
  return rows
    .map(
      (r): AuditEvent => ({
        id: r.id as string,
        companyId: str(r.company_id),
        actorId: str(r.actor_id),
        actorName: r.actor_name as string,
        action: r.action as string,
        subject: r.subject as string,
        summary: r.summary as string,
        detail: json<Record<string, unknown> | null>(r.detail, null),
        at: r.at as string,
      }),
    )
    .filter((e) => (e.companyId ? ctx.user.companyIds.includes(e.companyId) : true));
}

export { tx };
