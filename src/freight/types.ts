/**
 * Freight RFQ domain model (phase one).
 *
 * Scope: maintaining freight-provider lists per company, issuing shipping
 * requirements and RFQs, collecting quotations, comparing them, recommending an
 * offer, emailing the outcome and recording it in ERPNext.
 *
 * Explicitly NOT in scope: shipment tracking, vessel positions, provider
 * discovery, negotiation and booking. The team keeps final selection.
 *
 * PROVENANCE IS PART OF THE MODEL
 * -------------------------------
 * Every value that came out of a provider's quotation is carried as `Extracted<T>`
 * so the UI can always answer "where did this number come from, and how sure are
 * we?". A missing value is `null` with a reason - it is never silently zero.
 */

/* ------------------------------- Identity ---------------------------------- */

export type Id = string;
/** ISO-8601 instant, e.g. 2026-09-26T09:15:00.000Z */
export type Instant = string;
/** ISO date, e.g. 2026-09-26 */
export type Day = string;

export type UserRole =
  /** Can do everything in this module, including approving outbound email. */
  | 'logistics_manager'
  /** Can prepare work but cannot approve an outbound email. */
  | 'logistics_coordinator'
  /** Read-only. */
  | 'viewer'
  /**
   * Not a person. The Mailbox Collector files replies from the shared mailbox
   * into the workspace on a schedule. It is never stored as a user row, so it
   * cannot be picked as the acting person, and it may not edit, approve or send.
   */
  | 'system_mailbox_collector';

export interface User {
  id: Id;
  name: string;
  title: string;
  email: string;
  role: UserRole;
  /** Company ids this user may act on. Enforced server-side on every request. */
  companyIds: Id[];
  /** A disabled person cannot sign in, and an existing session stops working. */
  disabled?: boolean;
  /**
   * The identity provider's immutable id (Entra `oid`), bound at first sign-in.
   * After that, a sign-in must carry the same id, so renaming someone else's
   * account to this email address does not grant this person's access.
   */
  externalId?: string | null;
}

/* ------------------------------- Companies --------------------------------- */

export interface Company {
  id: Id;
  /** Short code used in RFQ references, e.g. MPD. */
  code: string;
  name: string;
  country: string;
  status: 'active' | 'inactive';
  /** Address block used in the footer of outgoing RFQ email. */
  addressLines: string[];
  createdAt: Instant;
}

/* ------------------------------- Providers --------------------------------- */

/**
 * Shared provider details. One row per freight provider across the whole tenant,
 * so a provider's name and head-office contact are not re-keyed per company.
 */
export interface Provider {
  id: Id;
  name: string;
  /** Free-text, e.g. "NVOCC", "Freight forwarder", "Carrier". */
  kind: string;
  country: string;
  website: string | null;
  /** Head-office / general mailbox. Company-specific contacts live on the link. */
  generalEmail: string | null;
  notes: string | null;
  createdAt: Instant;
}

/** How a provider may be contacted for a given company. */
export type RelationshipStatus =
  /** Normal: may receive RFQs. */
  | 'active'
  /** Under a running contract - outreach is blocked to avoid cutting across it. */
  | 'contracted'
  /** Deliberately excluded - outreach is blocked. */
  | 'excluded'
  /** Known but not yet onboarded - outreach is blocked until made active. */
  | 'prospect';

/** Statuses that may receive an RFQ. Enforced server-side, not just in the UI. */
export const CONTACTABLE: readonly RelationshipStatus[] = ['active'];

export function isContactable(status: RelationshipStatus): boolean {
  return CONTACTABLE.includes(status);
}

export const RELATIONSHIP_LABEL: Record<RelationshipStatus, string> = {
  active: 'Active',
  contracted: 'Under contract',
  excluded: 'Excluded',
  prospect: 'Prospect',
};

/** Company-specific relationship with a shared provider. */
export interface CompanyProvider {
  id: Id;
  companyId: Id;
  providerId: Id;
  status: RelationshipStatus;
  /** Why a provider is contracted/excluded. Shown wherever outreach is blocked. */
  restrictionReason: string | null;
  /** Account reference this company is known by at the provider. */
  accountRef: string | null;
  /** Trade lanes this provider is used for by this company. */
  lanes: Lane[];
  notes: string | null;
  createdAt: Instant;
}

export interface Lane {
  /** UN/LOCODE where available, e.g. CNSHA. */
  originPort: string;
  destinationPort: string;
}

export interface ProviderContact {
  id: Id;
  companyProviderId: Id;
  name: string;
  email: string;
  role: string | null;
  /** Primary contacts go on To:, the rest on Cc:. */
  isPrimary: boolean;
}

/* --------------------------- Shipping requirement -------------------------- */

export type ContainerType =
  | '20GP'
  | '40GP'
  | '40HC'
  | '45HC'
  | '20RF'
  | '40RF'
  | 'LCL'
  | 'BREAKBULK';

export const CONTAINER_TYPES: ContainerType[] = [
  '20GP',
  '40GP',
  '40HC',
  '45HC',
  '20RF',
  '40RF',
  'LCL',
  'BREAKBULK',
];

export interface ContainerLine {
  type: ContainerType;
  quantity: number;
  /** Per-container gross weight in kg, when the shipper has declared it. */
  grossWeightKg: number | null;
  commodity: string;
}

export type Incoterm = 'EXW' | 'FOB' | 'FCA' | 'CFR' | 'CIF' | 'DAP' | 'DDP';

export const INCOTERMS: Incoterm[] = ['EXW', 'FOB', 'FCA', 'CFR', 'CIF', 'DAP', 'DDP'];

export type RfqStatus =
  | 'draft'
  /** Recipients chosen, email drafted, waiting for the manager to approve. */
  | 'awaiting_approval'
  | 'sent'
  | 'collecting'
  /** Manager closed collection; comparison can be built. */
  | 'closed'
  | 'comparison_ready'
  | 'completed'
  | 'cancelled';

export const RFQ_STATUS_LABEL: Record<RfqStatus, string> = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  sent: 'Sent',
  collecting: 'Collecting responses',
  closed: 'Collection closed',
  comparison_ready: 'Comparison ready',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export interface Rfq {
  id: Id;
  /** Human reference carried through every email, file and ERPNext record. */
  reference: string;
  companyId: Id;
  title: string;
  originPort: string;
  destinationPort: string;
  incoterm: Incoterm;
  containers: ContainerLine[];
  /** Special stowage, hazardous, temperature, documentation notes. */
  cargoNotes: string | null;
  targetShipFrom: Day;
  targetShipTo: Day;
  /** Providers are asked to respond by this instant. Drives reminders + closure. */
  responseDeadline: Instant;
  instructions: string | null;
  /** Currency the manager asked providers to quote in. Offers may still differ. */
  requestedCurrency: string;
  status: RfqStatus;
  createdBy: Id;
  createdAt: Instant;
  closedAt: Instant | null;
  closedBy: Id | null;
}

export type RecipientStatus =
  | 'selected'
  | 'sent'
  | 'send_failed'
  | 'responded'
  | 'declined'
  | 'no_response';

export interface RfqRecipient {
  id: Id;
  rfqId: Id;
  companyProviderId: Id;
  status: RecipientStatus;
  sentAt: Instant | null;
  firstResponseAt: Instant | null;
  remindersSent: number;
  lastReminderAt: Instant | null;
}

/* ---------------------------------- Email ---------------------------------- */

export type EmailKind = 'rfq' | 'reminder' | 'comparison';

export type EmailStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'approved'
  | 'sent'
  | 'failed'
  /** Content changed after approval: the approval no longer applies. */
  | 'approval_stale';

export const EMAIL_STATUS_LABEL: Record<EmailStatus, string> = {
  draft: 'Draft',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved, not yet sent',
  sent: 'Sent',
  failed: 'Send failed',
  approval_stale: 'Changed since approval',
};

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /** Key under the data directory. Never an absolute path in the API. */
  storageKey: string;
  bytes: number;
}

export interface Recipient {
  name: string | null;
  email: string;
}

/**
 * One prepared outbound email.
 *
 * APPROVAL BINDING
 * ----------------
 * `contentHash` is computed over exactly what a reviewer sees: recipients,
 * subject, body and attachment identities. `approvedHash` records the hash that
 * was approved. Sending is refused unless the two match, so any edit after
 * approval forces a fresh approval.
 *
 * ONE EMAIL PER PROVIDER
 * ----------------------
 * RFQ and reminder emails are always addressed to a single provider so one
 * provider can never see another's identity, quote or contact details.
 */
export interface EmailDraft {
  id: Id;
  companyId: Id;
  rfqId: Id;
  kind: EmailKind;
  /** null for the comparison email, which goes to the manager, not a provider. */
  companyProviderId: Id | null;
  to: Recipient[];
  cc: Recipient[];
  subject: string;
  bodyText: string;
  attachments: EmailAttachment[];
  contentHash: string;
  status: EmailStatus;
  approvedBy: Id | null;
  approvedAt: Instant | null;
  approvedHash: string | null;
  sentAt: Instant | null;
  /** Transport-side id, when one was returned. */
  transportMessageId: string | null;
  /** True when the transport was the simulated adapter. Surfaced in the UI. */
  simulated: boolean;
  failureReason: string | null;
  /** Guards against a double click or a retry sending the same email twice. */
  idempotencyKey: string;
  createdAt: Instant;
  updatedAt: Instant;
}

/* ------------------------------ Inbound mail -------------------------------- */

export type MatchStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface MatchCandidate {
  rfqId: Id;
  rfqReference: string;
  companyProviderId: Id;
  providerName: string;
  reason: string;
  score: number;
}

export interface InboundMessage {
  id: Id;
  /** Transport message id (RFC 5322 Message-ID or Graph id). */
  externalId: string;
  /** Conversation/thread id where the transport provides one. */
  threadId: string | null;
  /** In-Reply-To header, the most reliable association signal. */
  inReplyTo: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  receivedAt: Instant;
  bodyText: string;
  attachments: EmailAttachment[];
  matchStatus: MatchStatus;
  /** How the match was made - shown to the reviewer in plain language. */
  matchBasis: string;
  rfqId: Id | null;
  companyProviderId: Id | null;
  /** Candidates offered to a human when the match was ambiguous. */
  candidates: MatchCandidate[];
  reviewedBy: Id | null;
  reviewedAt: Instant | null;
  simulated: boolean;
  createdAt: Instant;
}

/* --------------------------------- Quotes ----------------------------------- */

export type Confidence =
  /** Read from a structured cell or an exact labelled field. */
  | 'high'
  /** Parsed from prose, or a unit/basis had to be inferred. */
  | 'medium'
  /** Present but ambiguous. Always surfaced for review. */
  | 'low'
  /** Not present in the source at all. */
  | 'missing';

/**
 * A single extracted value with its provenance.
 *
 * `value === null` always means "we did not find this", never "zero". Treating a
 * missing surcharge as zero would quietly make an offer look cheaper than it is,
 * so the comparison refuses to do it.
 */
export interface Extracted<T> {
  value: T | null;
  confidence: Confidence;
  /** Where it came from, e.g. "email body, line 12" or "Quote.xlsx!B7". */
  sourceRef: string | null;
  /** The raw text the value was read from, shown side-by-side during review. */
  sourceText: string | null;
  /** Set when a human corrected the machine's reading. */
  correctedBy: Id | null;
  correctedAt: Instant | null;
  /** Free-text note from the extractor, e.g. why confidence is low. */
  note: string | null;
}

export type ChargeBasis =
  | 'per_container'
  | 'per_shipment'
  | 'per_bl'
  | 'per_cbm'
  | 'per_tonne'
  | 'unknown';

export const CHARGE_BASIS_LABEL: Record<ChargeBasis, string> = {
  per_container: 'per container',
  per_shipment: 'per shipment',
  per_bl: 'per bill of lading',
  per_cbm: 'per CBM',
  per_tonne: 'per tonne',
  unknown: 'basis not stated',
};

export interface Surcharge {
  /** e.g. BAF, THC-ORIGIN, ISPS, DOC. */
  code: string;
  label: string;
  amount: number | null;
  currency: string | null;
  /** What the charge is levied on. */
  basis: ChargeBasis;
  sourceRef: string | null;
  confidence: Confidence;
}

export type QuoteStatus =
  /** Machine extraction done, nobody has looked yet. */
  | 'needs_review'
  /** A human has confirmed/corrected the fields. Eligible for comparison. */
  | 'confirmed'
  /** Superseded by a newer version from the same provider. */
  | 'superseded'
  /** Source could not be read at all - never silently dropped. */
  | 'unreadable'
  /** Provider declined to quote. */
  | 'declined';

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  needs_review: 'Needs checking',
  confirmed: 'Checked',
  superseded: 'Superseded',
  unreadable: 'Could not be read',
  declined: 'Declined to quote',
};

export type SourceKind = 'email_body' | 'excel' | 'pdf_text' | 'manual';

export interface Quote {
  id: Id;
  companyId: Id;
  rfqId: Id;
  companyProviderId: Id;
  /** 1 for the first quotation, incrementing for each revision. */
  version: number;
  /** The quote this one revises. Earlier versions are kept, never overwritten. */
  supersedesQuoteId: Id | null;
  status: QuoteStatus;
  sourceKind: SourceKind;
  sourceMessageId: Id | null;
  /** Attachment the values were read from, when not the email body. */
  sourceAttachment: string | null;
  /** Set when the source could not be parsed, explaining exactly why. */
  unreadableReason: string | null;

  shippingLine: Extracted<string>;
  originPort: Extracted<string>;
  destinationPort: Extracted<string>;
  currency: Extracted<string>;
  /** Basis the freight rate is quoted on, e.g. per 40HC. */
  containerBasis: Extracted<ContainerType>;
  baseFreight: Extracted<number>;
  surcharges: Surcharge[];
  /** The provider's own stated total, when they gave one. */
  totalQuoted: Extracted<number>;
  transitDays: Extracted<number>;
  freeDaysDestination: Extracted<number>;
  validUntil: Extracted<string>;
  sailingDate: Extracted<string>;
  paymentTerms: Extracted<string>;
  inclusions: Extracted<string[]>;
  exclusions: Extracted<string[]>;
  conditions: Extracted<string[]>;

  /** Extractor that produced this, e.g. "deterministic/excel@1". Observability. */
  extractorId: string;
  extractedAt: Instant;
  reviewedBy: Id | null;
  reviewedAt: Instant | null;
  createdAt: Instant;
}

/** Keys of `Quote` that hold an `Extracted` scalar a reviewer can correct. */
export type ExtractedScalarKey =
  | 'shippingLine'
  | 'originPort'
  | 'destinationPort'
  | 'currency'
  | 'containerBasis'
  | 'baseFreight'
  | 'totalQuoted'
  | 'transitDays'
  | 'freeDaysDestination'
  | 'validUntil'
  | 'sailingDate'
  | 'paymentTerms';

export const EXTRACTED_SCALAR_KEYS: ExtractedScalarKey[] = [
  'shippingLine',
  'originPort',
  'destinationPort',
  'currency',
  'containerBasis',
  'baseFreight',
  'totalQuoted',
  'transitDays',
  'freeDaysDestination',
  'validUntil',
  'sailingDate',
  'paymentTerms',
];

export const EXTRACTED_FIELD_LABEL: Record<ExtractedScalarKey, string> = {
  shippingLine: 'Shipping line',
  originPort: 'Origin port',
  destinationPort: 'Destination port',
  currency: 'Currency',
  containerBasis: 'Rate basis',
  baseFreight: 'Base freight',
  totalQuoted: 'Total quoted by provider',
  transitDays: 'Transit time (days)',
  freeDaysDestination: 'Free days at destination',
  validUntil: 'Valid until',
  sailingDate: 'Sailing date',
  paymentTerms: 'Payment terms',
};

/* ------------------------------- Comparison --------------------------------- */

/** Weights must be visible and adjustable; nothing here is a hidden score. */
export interface RankingCriteria {
  weightCost: number;
  weightTransit: number;
  weightFreeDays: number;
  /** Offers whose validity expires within this many days are flagged. */
  minValidityDays: number;
  /** Currency every comparable offer must be in, or converted to. */
  baseCurrency: string;
}

export const DEFAULT_CRITERIA: RankingCriteria = {
  weightCost: 0.6,
  weightTransit: 0.25,
  weightFreeDays: 0.15,
  minValidityDays: 7,
  baseCurrency: 'USD',
};

/** A recorded FX conversion. Never applied without all four of these. */
export interface FxRate {
  from: string;
  to: string;
  rate: number;
  source: string;
  asOf: Day;
}

export type ComparabilityIssue =
  | { kind: 'missing_base_freight' }
  | { kind: 'missing_surcharge'; label: string }
  | { kind: 'currency_mismatch'; currency: string; base: string }
  | { kind: 'no_fx_rate'; currency: string; base: string }
  | { kind: 'container_basis_mismatch'; basis: string; expected: string }
  | { kind: 'unknown_charge_basis'; label: string }
  | { kind: 'expired_validity'; validUntil: string }
  | { kind: 'missing_transit' }
  | { kind: 'unreadable_source'; reason: string }
  | { kind: 'not_reviewed' };

export interface ComparisonLine {
  quoteId: Id;
  companyProviderId: Id;
  providerName: string;
  version: number;
  /** True only when every figure needed to rank it is present and compatible. */
  comparable: boolean;
  issues: ComparabilityIssue[];
  /** Sum of base freight + surcharges, in the quote's own currency. */
  totalInQuoteCurrency: number | null;
  quoteCurrency: string | null;
  /** Converted total, only when an FX rate was recorded. */
  totalInBaseCurrency: number | null;
  fxApplied: FxRate | null;
  /** Provider's stated total differs from the sum of the parts. */
  totalDiscrepancy: { stated: number; computed: number } | null;
  transitDays: number | null;
  freeDays: number | null;
  validUntil: string | null;
  /** 0-1 per axis, then weighted. Only populated for comparable lines. */
  scoreCost: number | null;
  scoreTransit: number | null;
  scoreFreeDays: number | null;
  scoreTotal: number | null;
  rank: number | null;
}

export interface Comparison {
  id: Id;
  companyId: Id;
  rfqId: Id;
  criteria: RankingCriteria;
  fxRates: FxRate[];
  lines: ComparisonLine[];
  /** Lowest comparable total. May differ from the recommendation. */
  cheapestQuoteId: Id | null;
  /** Highest weighted score. The manager still decides. */
  recommendedQuoteId: Id | null;
  /** Plain-language reasons the recommendation won, and what it costs. */
  recommendationReasons: string[];
  recommendationTradeoffs: string[];
  /** What a human would need to supply to make the excluded offers comparable. */
  blockedNotes: string[];
  workbookKey: string | null;
  createdBy: Id;
  createdAt: Instant;
}

/* --------------------------------- ERPNext ---------------------------------- */

export type SyncStatus = 'pending' | 'success' | 'failed' | 'blocked';

export const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  pending: 'Not yet recorded',
  success: 'Recorded',
  failed: 'Recording failed',
  blocked: 'Setup required',
};

export interface ErpSync {
  id: Id;
  companyId: Id;
  comparisonId: Id;
  /** 'simulated' output is never presented as a live ERPNext write. */
  adapter: 'simulated' | 'live';
  status: SyncStatus;
  attempts: number;
  /** Stable key so a retry updates rather than duplicates the remote record. */
  idempotencyKey: string;
  /** DocType actually written to, once known. Never guessed. */
  doctype: string | null;
  remoteName: string | null;
  remoteUrl: string | null;
  lastError: string | null;
  /** Setup that must be completed before a live write is possible. */
  setupRequirements: string[];
  lastAttemptAt: Instant | null;
  completedAt: Instant | null;
  createdAt: Instant;
}

/* ---------------------------------- Audit ----------------------------------- */

export interface AuditEvent {
  id: Id;
  companyId: Id | null;
  actorId: Id | null;
  actorName: string;
  /** Stable machine name, e.g. 'email.approved'. */
  action: string;
  /** What it happened to, e.g. 'rfq:RFQ-MPD-2026-0007'. */
  subject: string;
  /** One operational sentence, written for a human reading the timeline. */
  summary: string;
  detail: Record<string, unknown> | null;
  at: Instant;
}
