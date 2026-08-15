// =============================================================================
// Pluvus Workflow Prototype — Drizzle Schema
//
// Derived from `drizzle-kit pull` (introspection) against the live Neon DB on
// 2026-07-14 (raw output kept at server/drizzle/introspected-schema.reference.ts)
// and hand-verified field-by-field against prisma/schema.prisma. The database
// schema is owned by the HISTORICAL Prisma migrations in prisma/migrations —
// every table name, column name, enum type, and index below is byte-identical
// to what those migrations created.
//
//   ⚠ NEVER run `drizzle-kit push` or `drizzle-kit generate` against this
//   schema. Prisma's constraint names (Table_pkey / Table_col_key /
//   Table_col_fkey / Table_col_idx) differ from Drizzle's naming convention,
//   so push would try to drop and recreate constraints on the live database.
//   `drizzle-kit pull` (read-only) is the only kit command that may run.
//
// Two pieces of Prisma CLIENT-SIDE magic are reproduced here in Drizzle terms
// (the DB columns have no defaults for either):
//   - `@default(cuid())` id columns  → `$defaultFn(() => createId())` (cuid2)
//   - `@updatedAt` columns           → `$defaultFn` on insert + `$onUpdate`
//
// Layout mirrors the parent Pluvus `shared/schema.ts` style (single file,
// pgEnum + pgTable + drizzle-zod insert-schema companions + inferred types) so
// the later merge into the parent is copy-paste.
// =============================================================================

import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ---------------------------------------------------------------------------
// JSON value types (replacing Prisma.JsonValue / Prisma.InputJsonValue)
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

/** Write-side alias kept for parity with Prisma.InputJsonValue. */
export type InputJsonValue = JsonValue;

/** Object-shaped JSON (parity with Prisma.JsonObject). */
export type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Column helpers — Prisma client-side magic, reproduced
// ---------------------------------------------------------------------------

/** Prisma `@id @default(cuid())`: TEXT pk, id generated CLIENT-side. */
const cuidId = (name: string) =>
  text(name)
    .primaryKey()
    .$defaultFn(() => createId());

/** Prisma `DateTime` → TIMESTAMP(3) (naive, stored as UTC). */
const ts = (name: string) => timestamp(name, { precision: 3, mode: "date" });

/** Prisma `@default(now())`. */
const tsNow = (name: string) => ts(name).notNull().defaultNow();

/**
 * Prisma `@updatedAt`: NOT NULL with NO db default — the client stamps it on
 * both insert and update. `$onUpdate` covers `db.update(...)`; without the
 * insert-side `$defaultFn`, inserts would violate NOT NULL.
 */
const tsUpdatedAt = (name: string) =>
  ts(name)
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Enums (10) — names and member order exactly as they exist in the database
// ---------------------------------------------------------------------------

export const instanceStateEnum = pgEnum("InstanceState", [
  "ENROLLED",
  "OUTREACH_SENT",
  "AWAITING_REPLY",
  "FOLLOWED_UP",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "REWARD_PENDING",
  "REWARD_CONFIRMED",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "CONTENT_BRIEF_SENT",
  // Post-payout waiting state: after the creator submits the payout form, the
  // merged Content Brief node parks here and asks the creator to reply in the
  // thread with the link(s) to their published content. Non-terminal so the
  // inbound worker accepts and routes the reply (see stateMachine.ts).
  "CONTENT_LINKS_PENDING",
  "REJECTED",
  "OPTED_OUT",
  "NO_RESPONSE",
  "MANUAL_REVIEW",
  // PLU-70. Appended (not inserted in logical order) because ALTER TYPE ... ADD
  // VALUE appends to the DB type — this array must mirror the DB's member order.
  "NEEDS_DEAL_FINALIZATION",
  "HANDOFF_COMPLETE",
  // Brand-approval gate: a local_payment deal that a creator ACCEPTED is held
  // here until the BRAND approves (via magic link) before the content brief +
  // payout link go out. Appended to mirror the DB's ALTER TYPE ADD VALUE order.
  "AWAITING_BRAND_APPROVAL",
  // PLU-122. Appended by ALTER TYPE; queued initial outreach has a durable
  // Message reservation but has not yet been accepted for provider dispatch.
  "OUTREACH_QUEUED",
]);

// DB member order differs from schema.prisma's declaration order for the
// members added by later migrations (Postgres appends/positions via ALTER
// TYPE): END precedes the newer node types here. Order is DDL-only — values
// travel as strings at runtime — but we keep the DB's truth.
export const nodeTypeEnum = pgEnum("NodeType", [
  "IMPORT_CREATOR_LIST",
  "INITIAL_OUTREACH",
  "FOLLOW_UP",
  "REPLY_DETECTION",
  "NEGOTIATION",
  "END",
  "REWARD_SETUP",
  "PAYMENT_INFO",
  "CONTENT_BRIEF",
]);

export const messageDirectionEnum = pgEnum("MessageDirection", [
  "OUTBOUND",
  "INBOUND",
]);

export const replyIntentEnum = pgEnum("ReplyIntent", [
  "POSITIVE",
  "NEGATIVE",
  "QUESTION",
  "OPT_OUT",
  "UNKNOWN",
  "DEFERRED",
]);

export const eventTypeEnum = pgEnum("EventType", [
  "FOLLOW_UP_SCHEDULED",
  "FOLLOW_UP_CANCELLED",
  "FOLLOW_UP_DUE",
  "INBOUND_REPLY_RECEIVED",
  "STATE_TRANSITION",
  "NODE_ENTERED",
  "NODE_COMPLETED",
  "OUTREACH_DRAFTED",
  "REPLY_CLASSIFIED",
  "NEGOTIATION_TURN",
  "MANUAL_REVIEW_FLAGGED",
  "BRAND_NOTIFIED",
  "REWARD_SETUP_SENT",
  "REWARD_CONFIRMED",
  "REWARD_REPLY_UNCONFIRMED",
  "PAYMENT_INFO_SENT",
  "PAYMENT_RECEIVED",
  "CONTENT_BRIEF_SENT",
  // Appended when a creator replies to the content-brief email with one or more
  // content URLs. Payload carries the extracted URLs; drives the escalation to
  // MANUAL_REVIEW for operator review (no payout/ledger side effects).
  "CONTENT_LINKS_SUBMITTED",
  "PAYMENT_REPLY_UNRESOLVED",
  "PARTNERSHIP_ACTIVATED",
  "CONVERSION_RECORDED",
  "CONVERSION_REFUNDED",
  // Phase 3 (Payout ledger) — every ledger transition writes an instance event
  // (I-7) so the observability inspector timeline is the single audit trail.
  "PAYOUT_CREATED",
  "PAYOUT_SENT",
  "PAYOUT_CONFIRMED",
  "PAYOUT_DISPUTED",
  "PAYOUT_SETTLED",
  // PLU-70 operator handoff. Appended to mirror the DB's ALTER TYPE ordering.
  "DEAL_HANDOFF_REQUESTED",
  "DEAL_HANDOFF_REPLY",
  "DEAL_HANDOFF_COMPLETED",
  // Brand-approval gate. Appended to mirror the DB's ALTER TYPE ADD VALUE order.
  "BRAND_APPROVAL_REQUESTED",
  "BRAND_APPROVED",
  "BRAND_REJECTED",
]);

// PLU-70: what happens after a negotiation is accepted. local_payment is the
// existing behavior and the default for every pre-existing campaign/execution.
export const postAcceptanceModeEnum = pgEnum("PostAcceptanceMode", [
  "local_payment",
  "operator_handoff",
]);

export const dealHandoffStatusEnum = pgEnum("DealHandoffStatus", [
  "AWAITING_FINALIZATION",
  "COMPLETED",
]);

// PLU-135 (1a): status of a rendered CampaignBrief document.
export const campaignBriefRenderStatusEnum = pgEnum("CampaignBriefRenderStatus", [
  "GENERATING",
  "READY",
  "FAILED",
]);

// PLU-135 (1a): how a BrandIdentity's values were populated.
export const brandIdentityExtractionSourceEnum = pgEnum("BrandIdentityExtractionSource", [
  "EXTRACTED",
  "MANUAL",
  "DEFAULT",
]);

// PLU-135 (1a): the append-only CampaignAuditEvent event catalogue.
export const campaignAuditEventTypeEnum = pgEnum("CampaignAuditEventType", [
  "CREATED",
  "EDITED",
  "LAUNCHED",
  "SNAPSHOT_CREATED",
  "DUPLICATED",
  "BRIEF_RENDERED",
  "POLICY_CHANGED",
  "ARCHIVED",
]);

// PLU-135 (1a): a campaign's launch lifecycle. DRAFT is freely editable;
// ACTIVE means it has launched — campaignTermsSnapshots and
// negotiationPolicySnapshots exist, campaignDetails and negotiationPolicies
// are locked read-only, and no second snapshot is ever created for this
// campaign. A material change after launch means duplicating into a NEW
// campaign, never editing this one (Calvin review, 2026-08-08).
//
// CLOSING / ARCHIVED are declared now, RESERVED for PLU-133 (dependent on
// PLU-110) — no transition INTO either value is written anywhere in this
// codebase yet. Declaring them costs nothing (an unused enum value) and
// avoids a second migration touching this column later; what they actually
// mean — whether ARCHIVED here subsumes campaigns.archivedAt below, whether
// CLOSING is even a stored state vs. a computed one — is explicitly NOT
// decided by this schema and must not be inferred from it. campaigns.archivedAt
// (a DIFFERENT, already-implemented concept: manual delete-of-a-launched-
// campaign) is untouched by this widening and keeps working exactly as before.
export const campaignStatusEnum = pgEnum("CampaignStatus", [
  "DRAFT",
  "ACTIVE",
  "CLOSING",
  "ARCHIVED",
]);

// PLU-136: the four canonical compensation structures. Does NOT gate whether
// NegotiationPolicy is required at launch: every campaign type negotiates
// (deliverables, timeline, usage rights, exclusivity, and — unless
// NegotiationPolicy marks it non-negotiable — the fee/commission itself). A
// fixed-fee (PAID) campaign is still a negotiated one. Lives on
// campaignDetails (moved from campaigns in the compensation-contract
// revision) so it's captured by CampaignTermsSnapshot automatically and
// locked read-only post-launch like every other public promise. GIFT_ONLY:
// renamed from GIFT — product gifting for the other three structures is
// campaignDetails.includesGifting instead, an orthogonal flag, not a fifth
// enum value, since gifting composes with any of them.
export const campaignTypeEnum = pgEnum("CampaignType", [
  "PAID",
  "AFFILIATE",
  "HYBRID",
  "GIFT_ONLY",
]);

// PLU-136: whether a supplied/shipped product is itself part of the
// compensation offer, and if so what happens to it. Distinct from
// campaignDetails.shipsPhysicalProduct, which only ever means "the payout
// form must collect a shipping address." Only meaningful when
// campaignDetails.includesGifting is true or campaignType is GIFT_ONLY.
export const giftDispositionEnum = pgEnum("GiftDisposition", [
  "KEEP",
  "LOAN",
  "RETURN",
]);

// PLU-136: for a PAID or HYBRID campaign, whether the brand requests the
// creator's own rate card or proposes a starting fee up front. Governs
// whether campaignDetails.publicStartingFeeCents is required at launch.
export const priceStrategyEnum = pgEnum("PriceStrategy", [
  "REQUEST_RATE_CARD",
  "PROPOSE_STARTING_FEE",
]);

// PLU-136: every campaign created before this migration has
// campaignType = PAID only because that's the column default, never because
// anyone verified it. NEEDS_REVIEW is the default for the pre-existing
// backfill; launchCampaign() refuses to launch a NEEDS_REVIEW campaign until
// an operator flips it to CONFIRMED. The review UI/queue itself is PLU-144's
// job — this is only the flag and the launch gate that enforces it.
export const compensationReviewStatusEnum = pgEnum("CompensationReviewStatus", [
  "NEEDS_REVIEW",
  "CONFIRMED",
]);

// Brand-approval gate: lifecycle of the brand's Approve/Reject decision on a
// creator the AI closed. AWAITING_APPROVAL until the brand clicks a magic link;
// PROCESSING is a short-lived intermediate claim held ONLY while the workflow
// action (content-brief send / halt to manual review) runs, so the decision is
// finalized (APPROVED / REJECTED) exactly once, and STRICTLY AFTER that action
// succeeds. A PROCESSING row whose action failed reverts to AWAITING_APPROVAL so
// the brand can retry the same link instead of being told "already actioned"
// while the execution is still parked (PLU-118, Calvin review §2).
export const brandApprovalStatusEnum = pgEnum("BrandApprovalStatus", [
  "AWAITING_APPROVAL",
  "PROCESSING",
  "APPROVED",
  "REJECTED",
]);

// PLU-111: Conversation Obligations. A DIFFERENT concept from the payout-ledger
// Obligation/ObligationStatus (money owed) — do not reuse those names. Member
// order mirrors the DB (created whole by CREATE TYPE in the migration).
export const obligationTypeEnum = pgEnum("ObligationType", [
  "CREATOR_QUESTION",
  "PLUVUS_COMMITMENT",
]);
export const convObligationStatusEnum = pgEnum("ConversationObligationStatus", [
  "OPEN",
  "ANSWERED",
  "DEFERRED",
  "ESCALATED",
  "COMPLETED",
  "CANCELED",
  "NO_LONGER_RELEVANT",
]);

// PLU-113 — campaign-scoped creator memory. MemoryFactKey members MUST stay
// byte-identical to MEMORY_KEY_METADATA in engine/memoryKeys.ts (the single source
// of truth — Calvin review #7); the migration lists the same members.
export const memoryFactKeyEnum = pgEnum("MemoryFactKey", [
  "REQUESTED_RATE",
  "MINIMUM_RATE",
  "AVAILABILITY",
  "LOGISTICS_CONSTRAINT",
  "OBJECTION",
  "DELIVERABLE_PREFERENCE",
  "COMPENSATION_PREFERENCE",
  "MANAGER_INVOLVED",
  "MANAGER_CONTACT",
]);
// A live fact is ACTIVE, or CONFLICTED when a material change arrived and an
// operator has not yet reconciled it (both values are visible; the newer is the
// live head — Calvin review, "conflicting facts are not silently overwritten").
export const memoryFactStatusEnum = pgEnum("MemoryFactStatus", [
  "ACTIVE",
  "CONFLICTED",
  "SUPERSEDED",
  "REMOVED",
]);
// A memory revision's author: extracted from a creator inbound, or entered/edited
// by an operator (Calvin review #5 — operator provenance is unambiguous).
export const memoryRevisionSourceEnum = pgEnum("MemoryRevisionSource", [
  "creator",
  "operator",
]);

export const workflowStatusEnum = pgEnum("WorkflowStatus", [
  "DRAFT",
  "PUBLISHED",
  "ARCHIVED",
]);

export const outboxStatusEnum = pgEnum("OutboxStatus", [
  "PENDING",
  "SENT",
  "FAILED",
]);

export const brandNotificationStatusEnum = pgEnum("BrandNotificationStatus", [
  "SENT",
  "FAILED",
  "SKIPPED",
]);

// BUG-Q1: a dead-lettered job is PENDING until the re-drive sweep re-enqueues it
// (→ REDRIVEN) or an operator marks it DISCARDED.
export const deadLetterStatusEnum = pgEnum("DeadLetterStatus", [
  "PENDING",
  "REDRIVEN",
  "DISCARDED",
]);

export const paymentInfoStatusEnum = pgEnum("PaymentInfoStatus", [
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
]);

export const payoutMethodEnum = pgEnum("PayoutMethod", [
  "PAYPAL",
  "WISE",
  "BANK_TRANSFER",
]);

export const partnershipStatusEnum = pgEnum("PartnershipStatus", ["ACTIVE", "PAUSED"]);

// Phase 3 (Payout ledger) enums. Status machines ported from the parent
// (Pluvus/shared/schema.ts:534): an obligation is minted PENDING and paid once;
// a payout walks PENDING → SENT → (CONFIRMED | DISPUTED) → SETTLED.
export const obligationStatusEnum = pgEnum("ObligationStatus", [
  "PENDING",
  "PAID",
  "CANCELLED",
]);
export const payoutStatusEnum = pgEnum("PayoutStatus", [
  "PENDING",
  "SENT",
  "CONFIRMED",
  "DISPUTED",
  "SETTLED",
]);
export const payoutTypeEnum = pgEnum("PayoutType", ["COMMISSION", "FIXED_FEE"]);

// PLU-109: creator CSV import.
export const importBatchStatusEnum = pgEnum("ImportBatchStatus", [
  "DRAFT",
  "COMMITTED",
  "ARCHIVED",
]);

// PENDING is the draft state: parsed and valid, but nothing written to Creator
// yet. Commit rewrites each PENDING row to CREATED or UPDATED.
export const importRowOutcomeEnum = pgEnum("ImportRowOutcome", [
  "PENDING",
  "CREATED",
  "UPDATED",
  "SKIPPED",
]);

// String-literal union types with the same names @prisma/client exported.
export type InstanceState = (typeof instanceStateEnum.enumValues)[number];
export type NodeType = (typeof nodeTypeEnum.enumValues)[number];
export type MessageDirection = (typeof messageDirectionEnum.enumValues)[number];
export type ReplyIntent = (typeof replyIntentEnum.enumValues)[number];
export type EventType = (typeof eventTypeEnum.enumValues)[number];
export type WorkflowStatus = (typeof workflowStatusEnum.enumValues)[number];
export type OutboxStatus = (typeof outboxStatusEnum.enumValues)[number];
export type BrandNotificationStatus =
  (typeof brandNotificationStatusEnum.enumValues)[number];
export type DeadLetterStatus = (typeof deadLetterStatusEnum.enumValues)[number];
export type PaymentInfoStatus =
  (typeof paymentInfoStatusEnum.enumValues)[number];
export type PayoutMethod = (typeof payoutMethodEnum.enumValues)[number];
export type PartnershipStatus = (typeof partnershipStatusEnum.enumValues)[number];
export type ObligationStatus = (typeof obligationStatusEnum.enumValues)[number];
export type PayoutStatus = (typeof payoutStatusEnum.enumValues)[number];
export type PayoutType = (typeof payoutTypeEnum.enumValues)[number];
export type BrandApprovalStatus =
  (typeof brandApprovalStatusEnum.enumValues)[number];
// PLU-111 — conversation obligations (distinct from the payout ObligationStatus).
export type ObligationType = (typeof obligationTypeEnum.enumValues)[number];
export type ConversationObligationStatus =
  (typeof convObligationStatusEnum.enumValues)[number];

// PLU-113 — creator memory. MemoryFactKey is re-exported from the shared metadata
// module (engine/memoryKeys.ts) as the single source of truth; the pgEnum members
// mirror it. The status + revision-source types derive from their pgEnums.
export type MemoryFactStatus = (typeof memoryFactStatusEnum.enumValues)[number];
export type MemoryRevisionSource =
  (typeof memoryRevisionSourceEnum.enumValues)[number];

// PLU-135 (1a)
export type CampaignBriefRenderStatus =
  (typeof campaignBriefRenderStatusEnum.enumValues)[number];
export type BrandIdentityExtractionSource =
  (typeof brandIdentityExtractionSourceEnum.enumValues)[number];
export type CampaignAuditEventType =
  (typeof campaignAuditEventTypeEnum.enumValues)[number];
export type CampaignStatus = (typeof campaignStatusEnum.enumValues)[number];
export type CampaignType = (typeof campaignTypeEnum.enumValues)[number];
export type GiftDisposition = (typeof giftDispositionEnum.enumValues)[number];
export type PriceStrategy = (typeof priceStrategyEnum.enumValues)[number];
export type CompensationReviewStatus =
  (typeof compensationReviewStatusEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Definition models
// ---------------------------------------------------------------------------

// PLU-121: a connected email account — one Nylas grant = one mailbox. Stores only
// the opaque grant id + address (never raw credentials). See schema.prisma for the
// full rationale. Declared BEFORE the tables that reference it (campaigns,
// executionInstances, messages) so every foreign-key thunk resolves a value that
// is already initialized.
export const connectedEmailAccounts = pgTable(
  "ConnectedEmailAccount",
  {
    id: cuidId("id"),
    nylasGrantId: text("nylasGrantId").notNull(),
    emailAddress: text("emailAddress").notNull(),
    displayName: text("displayName"),
    provider: text("provider").notNull().default("nylas"),
    // active | disabled | revoked.
    status: text("status").notNull().default("active"),
    isDefault: boolean("isDefault").notNull().default(false),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("ConnectedEmailAccount_nylasGrantId_key").on(table.nylasGrantId),
    index("ConnectedEmailAccount_status_idx").on(table.status),
    // At most one default account (partial unique over the default rows).
    uniqueIndex("ConnectedEmailAccount_isDefault_key")
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
  ],
);

// PLU-135 (1a): trimmed to execution-level settings only. Every creator-facing
// term (objective, deliverables, usage rights, payment terms, etc.) moved to
// campaignDetails — see that table for why. This table owns tenancy, sending,
// pacing, and lifecycle (status, archivedAt) — never a second copy of deal terms.
export const campaigns = pgTable(
  "Campaign",
  {
    id: cuidId("id"),
    name: text("name").notNull(),
    brand: text("brand").notNull(),
    // Internal operator notes. NOT creator-facing (never stamped into node
    // config or shown to a creator) — that's why it stays here rather than
    // moving to campaignDetails with the other PLU-135 fields.
    notes: text("notes"),
    // PLU-135 (1a): Draft → Active is the ONE-WAY launch transition that
    // creates campaignTermsSnapshots + negotiationPolicySnapshots and locks
    // campaignDetails + negotiationPolicies. See launchCampaign() (db/campaigns.ts).
    status: campaignStatusEnum("status").notNull().default("DRAFT"),
    notifyEmail: text("notifyEmail"),
    targetUrl: text("targetUrl"),
    hiddenParamKey: text("hiddenParamKey").notNull().default("_from"),
    // PLU-70: the campaign-level DEFAULT only. Enrollment stamps the effective
    // mode onto each ExecutionInstance, so editing this cannot reach a running one.
    postAcceptanceMode: postAcceptanceModeEnum("postAcceptanceMode")
      .notNull()
      .default("local_payment"),
    // PLU-121: the brand's DEFAULT sending mailbox. Enrollment stamps the effective
    // account onto each ExecutionInstance, so editing this reaches only FUTURE
    // enrollments. Nullable — pre-multi-mailbox campaigns fall back to the default
    // ConnectedEmailAccount at enrollment.
    emailAccountId: text("emailAccountId").references(() => connectedEmailAccounts.id, {
      onDelete: "set null",
    }),
    // PLU-122. Nullable by design: NULL preserves legacy campaigns. The create
    // route writes explicit defaults for new campaigns.
    dailyInitialOutreachLimit: integer("dailyInitialOutreachLimit"),
    outreachPacingMinMinutes: integer("outreachPacingMinMinutes"),
    outreachPacingMaxMinutes: integer("outreachPacingMaxMinutes"),
    negotiationReplyPacingMinMinutes: integer("negotiationReplyPacingMinMinutes"),
    negotiationReplyPacingMaxMinutes: integer("negotiationReplyPacingMaxMinutes"),
    // PLU-135 (1a): null = active (visible). Set when an already-launched
    // (ACTIVE) campaign is deleted — deleteCampaign() archives instead of
    // destroying so the snapshot/audit/brief history stays intact. A DRAFT
    // campaign still hard-deletes as before. listCampaigns() filters these
    // out; direct lookup by id is unaffected.
    archivedAt: ts("archivedAt"),
    // PLU-136 (1b): set by duplicateCampaign() on the NEW row, pointing at
    // the campaign it was copied from — traceability/UI context only, never
    // read by authorization/resolution logic. onDelete "set null": a
    // duplicate must never be blocked or cascade-deleted just because its
    // (DRAFT-only-deletable) source was later hard-deleted.
    duplicatedFromCampaignId: text("duplicatedFromCampaignId").references(
      (): AnyPgColumn => campaigns.id,
      { onDelete: "set null" },
    ),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    index("Campaign_emailAccountId_idx").on(table.emailAccountId),
    index("Campaign_duplicatedFromCampaignId_idx").on(table.duplicatedFromCampaignId),
  ],
);

// PLU-135 (1a): the editable, creator-facing draft — every term that moved out
// of `campaigns` above. Freely rewritable while campaigns.status is DRAFT.
// launchCampaign() freezes a copy into campaignTermsSnapshots and the
// application layer (db/campaignDetails.ts) rejects further writes once
// ACTIVE — a material change means duplicating into a new campaign, never
// editing this one post-launch. One per campaign.
export const campaignDetails = pgTable("CampaignDetails", {
  id: cuidId("id"),
  campaignId: text("campaignId")
    .notNull()
    .unique()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  // PLU-136: moved here from campaigns — see campaignTypeEnum's doc comment
  // for why (must be inside the frozen snapshot; a mutable campaigns column
  // alone is not sufficient).
  campaignType: campaignTypeEnum("campaignType").notNull().default("PAID"),
  // PLU-136: product/non-cash gifting composing with PAID/AFFILIATE/HYBRID.
  // Always implicitly true for GIFT_ONLY (validated at launch, not
  // separately required to be set).
  includesGifting: boolean("includesGifting").notNull().default(false),
  // PLU-136: only meaningful when includesGifting is true or campaignType is
  // GIFT_ONLY. See giftDispositionEnum's doc comment.
  giftDisposition: giftDispositionEnum("giftDisposition"),
  // PLU-136: see compensationReviewStatusEnum's doc comment. Defaults
  // NEEDS_REVIEW; a campaign created through an explicit-selection flow
  // should set CONFIRMED directly rather than relying on this default.
  compensationReviewStatus: compensationReviewStatusEnum("compensationReviewStatus")
    .notNull()
    .default("NEEDS_REVIEW"),
  objective: text("objective"),
  // Maps to the old campaigns.rewardDescription ("a free pair of our running
  // shoes") — PLU-135 names this field productOrOffer; same free-text
  // product/sample description, carried forward by the migration's backfill.
  productOrOffer: text("productOrOffer"),
  keyMessages: text("keyMessages"),
  deliverables: text("deliverables"),
  timeline: text("timeline"),
  contentRequirements: text("contentRequirements"),
  usageRights: text("usageRights"),
  exclusivity: text("exclusivity"),
  // Not in PLU-135's literal field list, but carried forward anyway: this was
  // one of the same HARD-K1 creator-facing fields as usageRights/exclusivity,
  // still actively read by executors — dropping it would be a regression.
  attributionWindow: text("attributionWindow"),
  // PLU-136: renamed from fixedCompensationCents — the PUBLIC starting/
  // proposed fee shown to the creator before negotiation, when priceStrategy
  // is PROPOSE_STARTING_FEE (required then) or null when REQUEST_RATE_CARD.
  // Only applicable to PAID/HYBRID. negotiationPolicies' floor/ceiling/
  // preferredFeeCents are the PRIVATE flexibility around this public number.
  publicStartingFeeCents: integer("publicStartingFeeCents"),
  // PLU-136: only applicable to PAID/HYBRID — governs whether
  // publicStartingFeeCents is required. Null for AFFILIATE/GIFT_ONLY.
  priceStrategy: priceStrategyEnum("priceStrategy"),
  // PLU-136: the PUBLIC commission rate shown to the creator, applicable to
  // AFFILIATE/HYBRID. negotiationPolicies' commissionFloorRate/
  // commissionCeilingRate/preferredCommissionRate are the PRIVATE
  // flexibility around this number.
  publicCommissionRate: doublePrecision("publicCommissionRate"),
  // How long the commission window runs (e.g. 30-day attribution).
  commissionDurationDays: integer("commissionDurationDays"),
  // Free-text commission terms not worth a structured field yet.
  commissionConditions: text("commissionConditions"),
  publicPaymentTerms: text("publicPaymentTerms"),
  shipsPhysicalProduct: boolean("shipsPhysicalProduct").notNull().default(false),
  brandDescription: text("brandDescription"),
  // PLU-139 (2a): worksheet Stage-1 questions that had no CampaignDetails column
  // until now — all creator-facing public brief fields, all nullable (an
  // incomplete Draft is valid). Grouped by worksheet page. Free-text unless a
  // closed set is noted; the closed sets are stored as plain strings (validated
  // at the route) rather than PG enums so PLU-159 can retune options without a
  // migration.
  // Page 2 — Campaign & product.
  productName: text("productName"), // S2.3
  productType: text("productType"), // S2.4
  creatorAccessNeeded: boolean("creatorAccessNeeded"), // S2.5 (enable access / none)
  uniqueSellingPoints: text("uniqueSellingPoints"), // S2.7
  whyTrust: text("whyTrust"), // S2.8
  howToUse: text("howToUse"), // S2.9
  brandAssets: text("brandAssets"), // S2.10 (links)
  brandMaterialsRef: text("brandMaterialsRef"), // S1.4 uploaded supporting materials
  // Page 3 — per-platform deliverable quantities (S3.2–S3.9). Structured list:
  // [{ platform, format, quantity }]. jsonb, following the CreatorRequirement
  // string[] list precedent.
  deliverableQuantities: jsonb("deliverableQuantities").$type<JsonValue>(),
  // Page 7 — S7.P1 per-deliverable pricing: { "<platform>:<format>": cents }.
  deliverablePricing: jsonb("deliverablePricing").$type<JsonValue>(),
  // Page 3 — S3.11 per-platform follower ranges: { "<platform>": { min, max } }.
  followerRanges: jsonb("followerRanges").$type<JsonValue>(),
  // Page 5 — brief delivery (S5.1: "own_doc" | "pluvus_builder") + the granular
  // brief fields (free text pre-PLU-159's rich-text brief builder).
  briefDeliveryMethod: text("briefDeliveryMethod"),
  briefHighlight: text("briefHighlight"), // S5.2
  creativeConcept: text("creativeConcept"), // S5.4
  referenceVideos: text("referenceVideos"), // S5.5 (one link per line)
  scriptSubmission: text("scriptSubmission"), // S5.6 ("require" | "skip")
  // Page 6 — rights durations not previously modelled (free text; worksheet
  // shows dropdown+custom, kept as text pre-PLU-159).
  adAuthorization: text("adAuthorization"), // S6.3 (split out from usageRights)
  linkInBioDuration: text("linkInBioDuration"), // S6.2
  postRetention: text("postRetention"), // S6.4
  instagramCollab: boolean("instagramCollab"), // S6.7
  // Page 7 — shared onboarding + affiliate/gift specifics.
  requireApproval: boolean("requireApproval"), // S7.3
  commissionMode: text("commissionMode"), // S7.A1 "percent" | "flat"
  variableCommission: text("variableCommission"), // S7.A3 (free text pre-PLU-159)
  giftDeliveryMethod: text("giftDeliveryMethod"), // S7.G1 "promo_code" | "manual_contact"
  promoCode: text("promoCode"), // S7.G2
  giftContactEmail: text("giftContactEmail"), // S7.G4
  requiresShippingInfo: boolean("requiresShippingInfo"), // S7.G7
  // Page 7 — public affiliate tracking (T-series). targetUrl/hiddenParamKey on
  // the Campaign row remain the create-time source; these are the public,
  // brief-level tracking fields the worksheet surfaces.
  affiliateTrackingUrl: text("affiliateTrackingUrl"), // S7.T0
  trackingLinkMode: text("trackingLinkMode"), // S7.T1 "pluvus" | "own"
  trackingDestinationUrl: text("trackingDestinationUrl"), // S7.T2
  trackingParameter: text("trackingParameter"), // S7.T3
  // PLU-139 field-level provenance: { "<fieldKey>": "manual" | "pdf_extracted" }.
  // How each creator-facing value got here (typed = manual, applied from a brief
  // candidate = pdf_extracted). Absent key = no provenance recorded.
  fieldProvenance: jsonb("fieldProvenance").$type<JsonValue>(),
  // PLU-135 schema review §2.1 (Calvin, 2026-08-08): which extraction the
  // fields above were actually confirmed from — the missing link in the
  // extraction -> confirmation -> snapshot chain. Without this,
  // launchCampaign() had to guess by picking "the newest extraction," which
  // is wrong if a brief was re-uploaded after confirmation but before launch.
  // Nullable: a campaign typed by hand with no PDF ever uploaded is normal.
  confirmedFromExtractionId: text("confirmedFromExtractionId").references(
    () => campaignBriefExtractions.id,
    { onDelete: "restrict" },
  ),
  confirmedAt: ts("confirmedAt"),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

// PLU-135 (1a): THE immutable public-terms snapshot — what the campaign
// actually offered at launch (e.g. "$300"), NOT what any individual creator
// negotiated (e.g. "$450" — that lives in partnerships/partnership terms,
// PLU-119, tied to the creator's own execution). Deliberately NOT named
// "Revision": there is exactly one per campaign, ever — enforced by the
// unique campaignId below. Written once, by launchCampaign(), at the
// Draft→Active transition — never at enrollment, because conversations could
// already be in flight against live data by then. A brand wanting to change
// material terms after launch must duplicate the campaign, not touch this
// row. Never updated after creation. onDelete "restrict" everywhere it's
// referenced: this row must outlive the campaign that made it (Calvin
// review, 2026-08-08).
export const campaignTermsSnapshots = pgTable(
  "CampaignTermsSnapshot",
  {
    id: cuidId("id"),
    campaignId: text("campaignId")
      .notNull()
      .unique()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    // Full copy of campaignDetails' fields at the moment of launch. JSON blob
    // (matching how WorkflowVersion.nodeGraph already does immutable
    // snapshots) rather than individual columns.
    detailsSnapshot: jsonb("detailsSnapshot").$type<JsonValue>().notNull(),
    // Which campaignBriefExtraction was current at launch — the fallback
    // brief text this snapshot is consistent with. NOT part of the confirmed
    // terms above; just a pointer to which AI reading was in effect, so the
    // fallback tier never silently drifts. Nullable: a campaign can launch
    // with no brief uploaded at all. Once set, never changed.
    briefExtractionId: text("briefExtractionId").references(
      () => campaignBriefExtractions.id,
      { onDelete: "restrict" },
    ),
    launchedAt: tsNow("launchedAt"),
    // Informational operator/system marker — not an authorization check.
    createdBy: text("createdBy"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    index("CampaignTermsSnapshot_briefExtractionId_idx").on(table.briefExtractionId),
    // Enables the composite FK from campaignBriefs(campaignTermsSnapshotId,
    // campaignId) — the mechanism that makes "a brief can't reference another
    // campaign's snapshot" a real database constraint instead of an
    // app-level check.
    uniqueIndex("CampaignTermsSnapshot_id_campaignId_key").on(
      table.id,
      table.campaignId,
    ),
  ],
);

// PLU-135 (1a): a single reading of the uploaded brief PDF. Immutable — never
// updated or overwritten. No version *number*; ordering is purely by
// createdAt, so "the current reading" (used before a campaign has launched)
// is just the newest row for a campaignId. This is the AI's CANDIDATE
// reading — not itself the source of truth. A human confirming or editing
// what it found is what actually writes to campaignDetails; only
// campaignDetails (and, after launch, its frozen copy) is authoritative.
// Does not replace the in-process parse cache in briefKnowledge.ts
// (PLU-82/PLU-107) — that remains the fast path for pre-launch preview; this
// is the durable record behind it.
export const campaignBriefExtractions = pgTable(
  "CampaignBriefExtraction",
  {
    id: cuidId("id"),
    campaignId: text("campaignId")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    flatText: text("flatText").notNull(),
    // Typed section map — same shape briefKnowledge.ts already produces.
    sections: jsonb("sections").$type<JsonValue>().notNull(),
    // Uncategorised remainder — nothing extracted is discarded.
    other: jsonb("other").$type<JsonValue>(),
    sourceFileReference: text("sourceFileReference").notNull(),
    parserVersion: text("parserVersion").notNull(),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    index("CampaignBriefExtraction_campaignId_idx").on(table.campaignId),
    // Backs the "most recent reading for this campaign" read before launch.
    index("CampaignBriefExtraction_campaignId_createdAt_idx").on(
      table.campaignId,
      table.createdAt,
    ),
  ],
);

// PLU-135 (1a): the private negotiation-bounds table. Standalone — private
// policy lives only here, never merged into campaignDetails or
// campaignTermsSnapshots, which a creator-facing agent may read from.
// preferredFeeCents / negotiationGuidance / negotiableTerms /
// nonNegotiableTerms are new — nothing in the codebase tracks them today,
// only floor/ceiling and the other fields below (scattered across ~15 files
// pre-migration). Freely editable while campaigns.status is DRAFT;
// launchCampaign() freezes a copy into negotiationPolicySnapshots and further
// writes are rejected once ACTIVE — an in-flight negotiation must never see
// its bounds change mid-conversation (Calvin review, 2026-08-08).
export const negotiationPolicies = pgTable("NegotiationPolicy", {
  id: cuidId("id"),
  campaignId: text("campaignId")
    .notNull()
    .unique()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  floorCents: integer("floorCents"),
  ceilingCents: integer("ceilingCents"),
  preferredFeeCents: integer("preferredFeeCents"),
  // PLU-136: replaces the old bare commissionRate scalar, which had no
  // documented meaning (offer? floor? ceiling?) and mixed public/private
  // concerns awkwardly. These three mirror the fee fields above exactly —
  // the PRIVATE flexibility around campaignDetails.publicCommissionRate.
  commissionFloorRate: doublePrecision("commissionFloorRate"),
  commissionCeilingRate: doublePrecision("commissionCeilingRate"),
  preferredCommissionRate: doublePrecision("preferredCommissionRate"),
  maxRounds: integer("maxRounds"),
  openingOfferPosition: doublePrecision("openingOfferPosition"),
  overCeilingTolerance: doublePrecision("overCeilingTolerance"),
  negotiationGuidance: text("negotiationGuidance"),
  // PLU-136: whether a substitute product may be offered in place of the one
  // described in campaignDetails.productOrOffer. Only meaningful when
  // campaignDetails.includesGifting is true or campaignType is GIFT_ONLY.
  giftSubstitutionAllowed: boolean("giftSubstitutionAllowed"),
  // How far the value of the offered product may move if a substitute is
  // offered. Same applicability as giftSubstitutionAllowed.
  giftValueFlexibilityCents: integer("giftValueFlexibilityCents"),
  // String lists stored as JSON — no Postgres native array precedent exists
  // elsewhere in this schema, so this follows the established Json-for-lists
  // convention (metadata/socialLinks/etc.) instead of introducing a new one.
  negotiableTerms: jsonb("negotiableTerms").$type<JsonValue>(),
  nonNegotiableTerms: jsonb("nonNegotiableTerms").$type<JsonValue>(),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

// PLU-135 (1a): the immutable freeze of negotiationPolicies at launch — same
// mechanism and reason as campaignTermsSnapshots, kept as its OWN table
// (rather than folded into campaignTermsSnapshots.detailsSnapshot) because
// private policy must never share a row with anything a creator-facing agent
// might read from. Explicit typed columns mirroring negotiationPolicies
// exactly (rather than a JSON blob) since these are stable scalar fields, not
// a growing free-form document. Written once, by launchCampaign(), never
// updated after.
export const negotiationPolicySnapshots = pgTable("NegotiationPolicySnapshot", {
  id: cuidId("id"),
  campaignId: text("campaignId")
    .notNull()
    .unique()
    .references(() => campaigns.id, { onDelete: "restrict" }),
  floorCents: integer("floorCents"),
  ceilingCents: integer("ceilingCents"),
  preferredFeeCents: integer("preferredFeeCents"),
  // PLU-136: mirrors negotiationPolicies' own commission restructure.
  commissionFloorRate: doublePrecision("commissionFloorRate"),
  commissionCeilingRate: doublePrecision("commissionCeilingRate"),
  preferredCommissionRate: doublePrecision("preferredCommissionRate"),
  maxRounds: integer("maxRounds"),
  openingOfferPosition: doublePrecision("openingOfferPosition"),
  overCeilingTolerance: doublePrecision("overCeilingTolerance"),
  negotiationGuidance: text("negotiationGuidance"),
  // PLU-136: mirrors negotiationPolicies' gift-flexibility fields.
  giftSubstitutionAllowed: boolean("giftSubstitutionAllowed"),
  giftValueFlexibilityCents: integer("giftValueFlexibilityCents"),
  negotiableTerms: jsonb("negotiableTerms").$type<JsonValue>(),
  nonNegotiableTerms: jsonb("nonNegotiableTerms").$type<JsonValue>(),
  launchedAt: tsNow("launchedAt"),
  createdAt: tsNow("createdAt"),
});

// PLU-135 (1a): brand logo/colors/typography for anything rendered on the
// campaign's behalf (e.g. campaignBriefs). One per campaign.
export const brandIdentities = pgTable("BrandIdentity", {
  id: cuidId("id"),
  campaignId: text("campaignId")
    .notNull()
    .unique()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  logoRef: text("logoRef"),
  primaryColor: text("primaryColor"),
  secondaryColor: text("secondaryColor"),
  typography: text("typography"),
  extractionSource: brandIdentityExtractionSourceEnum("extractionSource"),
  extractedAt: ts("extractedAt"),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

// PLU-135 (1a): informational-only criteria for what kind of creator a
// campaign wants. Explicitly must NOT drive matching/ranking/outreach in this
// issue — display/edit only. No existing table covers this; built empty, with
// nothing to backfill (creators.niche/platform/location describe one real
// creator's own profile, a different concept entirely).
export const creatorRequirements = pgTable("CreatorRequirement", {
  id: cuidId("id"),
  campaignId: text("campaignId")
    .notNull()
    .unique()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  // PLU-139 (B): only the worksheet-backed creator criteria remain — platforms
  // (S3.1), geography (S3.10), minFollowers (S3.11). niches/languages/
  // audienceNotes/contentStyle/brandSafety were legacy fields with no worksheet
  // row and no downstream reader; dropped to keep the intake worksheet-exact.
  platforms: jsonb("platforms").$type<JsonValue>(),
  geography: jsonb("geography").$type<JsonValue>(),
  minFollowers: integer("minFollowers"),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

// PLU-135 (1a): redefined as a pointer to the RENDERED brief document handed
// to a creator — not the uploaded source PDF (that stays referenced from
// workflow node config for now; campaignBriefExtractions above is its durable
// reading, unrelated to this table). The actual rendering logic is Issue 3's
// job; this is just the receipt. The composite FK to
// campaignTermsSnapshots(id, campaignId) makes "a brief can never reference a
// different campaign's snapshot" a real database constraint.
//
// PLU-135 schema review §2.2 (Calvin, 2026-08-08) — named in review as the
// most important open concern. BrandIdentity is deliberately NOT locked at
// launch, so a logo/colour edit is live today — a doc comment telling Issue 3
// to "always insert a new row" does not protect an already-rendered brief,
// because even a new row would re-resolve the CURRENT identity. The rendered
// brief has to carry the identity it actually used, as a point-in-time copy
// (brandIdentitySnapshot) — NOT a version pointer to BrandIdentity, which
// would mean a second snapshot table and a lock discussion for something
// review explicitly wants kept simple and freely editable. supersededAt marks
// a newer render superseding an older one — the row is NEVER deleted, so a
// creator who already received this exact brief can still be shown what they
// actually got. Staleness stays keyed to campaignTermsSnapshotId ALONE: a
// BrandIdentity edit must never mark an existing brief stale.
export const campaignBriefs = pgTable(
  "CampaignBrief",
  {
    id: cuidId("id"),
    campaignId: text("campaignId").notNull(),
    campaignTermsSnapshotId: text("campaignTermsSnapshotId").notNull(),
    renderedAssetRef: text("renderedAssetRef"),
    status: campaignBriefRenderStatusEnum("status").notNull().default("GENERATING"),
    generatedAt: ts("generatedAt"),
    brandIdentitySnapshot: jsonb("brandIdentitySnapshot").$type<JsonValue>().notNull(),
    templateVersion: text("templateVersion").notNull(),
    renderedAt: tsNow("renderedAt"),
    supersededAt: ts("supersededAt"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    index("CampaignBrief_campaignId_idx").on(table.campaignId),
    index("CampaignBrief_campaignTermsSnapshotId_idx").on(table.campaignTermsSnapshotId),
    index("CampaignBrief_campaignId_renderedAt_idx").on(table.campaignId, table.renderedAt),
    foreignKey({
      columns: [table.campaignId],
      foreignColumns: [campaigns.id],
      name: "CampaignBrief_campaignId_fkey",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.campaignTermsSnapshotId, table.campaignId],
      foreignColumns: [campaignTermsSnapshots.id, campaignTermsSnapshots.campaignId],
      name: "CampaignBrief_campaignTermsSnapshotId_campaignId_fkey",
    }).onDelete("restrict"),
  ],
);

// PLU-135 (1a): append-only campaign history. No updatedAt by design — nothing
// should ever revise a diary entry. Kept separate from ExecutionInstance's
// per-creator Event log and the workflow-graph validation log, which record
// different things.
export const campaignAuditEvents = pgTable(
  "CampaignAuditEvent",
  {
    id: cuidId("id"),
    campaignId: text("campaignId")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    eventType: campaignAuditEventTypeEnum("eventType").notNull(),
    payload: jsonb("payload").$type<JsonValue>(),
    actorId: text("actorId"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [index("CampaignAuditEvent_campaignId_idx").on(table.campaignId)],
);

// PLU-122: per-campaign UTC-day quota + pacing cursor. Email payloads remain in
// Message and delivery remains in the existing delayed-send queue.
export const campaignOutreachDays = pgTable(
  "CampaignOutreachDay",
  {
    id: cuidId("id"),
    campaignId: text("campaignId")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    dayStart: ts("dayStart").notNull(),
    startedCount: integer("startedCount").notNull().default(0),
    nextEligibleAt: ts("nextEligibleAt"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("CampaignOutreachDay_campaignId_dayStart_key").on(
      table.campaignId,
      table.dayStart,
    ),
  ],
);

export const workflows = pgTable("Workflow", {
  id: cuidId("id"),
  name: text("name").notNull(),
  description: text("description"),
  status: workflowStatusEnum("status").notNull().default("DRAFT"),
  campaignId: text("campaignId").references(() => campaigns.id),
  draftNodes: jsonb("draftNodes").$type<JsonValue>(),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

export const workflowVersions = pgTable(
  "WorkflowVersion",
  {
    id: cuidId("id"),
    workflowId: text("workflowId")
      .notNull()
      .references(() => workflows.id),
    version: integer("version").notNull(),
    nodeGraph: jsonb("nodeGraph").$type<JsonValue>().notNull(),
    publishedAt: tsNow("publishedAt"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    uniqueIndex("WorkflowVersion_workflowId_version_key").on(
      table.workflowId,
      table.version,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Creator model
// ---------------------------------------------------------------------------

export const creators = pgTable(
  "Creator",
  {
    id: cuidId("id"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    handle: text("handle"),
    niche: text("niche"),
    platform: text("platform"),
    metadata: jsonb("metadata").$type<JsonValue>(),
    // PLU-109: promoted from a CSV / creator-discovery vendor export. These are
    // columns rather than JSON keys because the enroll picker SORTS by
    // followerCount/engagementRate and the outreach prompt interpolates
    // platform/niche/name — see src/validation/creatorFields.ts.
    profileUrl: text("profileUrl"),
    // NULL means UNKNOWN, never 0 — so an unknown creator does not sort as
    // "zero followers" at the bottom of the picker.
    followerCount: integer("followerCount"),
    engagementRate: doublePrecision("engagementRate"),
    location: text("location"),
    language: text("language"),
    bio: text("bio"),
    socialLinks: jsonb("socialLinks").$type<JsonValue>(),
    platformStats: jsonb("platformStats").$type<JsonValue>(),
    signals: jsonb("signals").$type<JsonValue>(),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("Creator_email_key").on(table.email),
    index("Creator_followerCount_idx").on(table.followerCount),
  ],
);

// ---------------------------------------------------------------------------
// Creator import models (PLU-109)
// ---------------------------------------------------------------------------

export const creatorImportBatches = pgTable(
  "CreatorImportBatch",
  {
    id: cuidId("id"),
    label: text("label").notNull(),
    sourceFilename: text("sourceFilename").notNull(),
    /** Opaque storage-seam reference, not a path. */
    fileReference: text("fileReference"),
    delimiter: text("delimiter"),
    status: importBatchStatusEnum("status").notNull().default("DRAFT"),
    rowCount: integer("rowCount").notNull().default(0),
    createdCount: integer("createdCount").notNull().default(0),
    updatedCount: integer("updatedCount").notNull().default(0),
    skippedCount: integer("skippedCount").notNull().default(0),
    createdAt: tsNow("createdAt"),
    committedAt: ts("committedAt"),
    archivedAt: ts("archivedAt"),
  },
  (table) => [
    index("CreatorImportBatch_status_createdAt_idx").on(table.status, table.createdAt),
  ],
);

export const creatorImportBatchMembers = pgTable(
  "CreatorImportBatchMember",
  {
    id: cuidId("id"),
    batchId: text("batchId")
      .notNull()
      .references(() => creatorImportBatches.id, { onDelete: "cascade" }),
    // Nullable: a SKIPPED row has no creator, and ON DELETE SET NULL means the
    // audit row outlives a deleted creator rather than vanishing with them.
    creatorId: text("creatorId").references(() => creators.id, { onDelete: "set null" }),
    rowNumber: integer("rowNumber").notNull(),
    outcome: importRowOutcomeEnum("outcome").notNull().default("PENDING"),
    errorReason: text("errorReason"),
    rawRow: jsonb("rawRow").$type<JsonValue>(),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    uniqueIndex("CreatorImportBatchMember_batchId_rowNumber_key").on(
      table.batchId,
      table.rowNumber,
    ),
    index("CreatorImportBatchMember_batchId_outcome_idx").on(table.batchId, table.outcome),
    index("CreatorImportBatchMember_creatorId_idx").on(table.creatorId),
  ],
);

// ---------------------------------------------------------------------------
// Execution models
// ---------------------------------------------------------------------------

export const executionInstances = pgTable(
  "ExecutionInstance",
  {
    id: cuidId("id"),
    workflowVersionId: text("workflowVersionId")
      .notNull()
      .references(() => workflowVersions.id),
    creatorId: text("creatorId")
      .notNull()
      .references(() => creators.id),
    currentState: instanceStateEnum("currentState").notNull().default("ENROLLED"),
    currentNodeId: text("currentNodeId"),
    followUpCount: integer("followUpCount").notNull().default(0),
    negotiationRound: integer("negotiationRound").notNull().default(0),
    // BUG-E1: monotonic OCC counter. updateInstanceStateConditional predicates on
    // (currentState AND version) and bumps version on every write, so two
    // concurrent writes — including an X→X self-transition, which currentState
    // alone can't distinguish — can never both commit. The first wins; the second
    // matches the stale version, updates 0 rows, and no-ops.
    version: integer("version").notNull().default(0),
    // PLU-70: the post-acceptance behavior this execution is LOCKED to. Stamped
    // once at enrollment and never rewritten — reading it here rather than from
    // the campaign is what isolates a running execution from a later edit.
    postAcceptanceMode: postAcceptanceModeEnum("postAcceptanceMode")
      .notNull()
      .default("local_payment"),
    // PLU-121: the connected mailbox this run is PINNED to. Stamped once at
    // enrollment and never rewritten — reading it here keeps a whole conversation
    // on one mailbox. Nullable; backfilled to the default account by the migration.
    emailAccountId: text("emailAccountId").references(() => connectedEmailAccounts.id, {
      onDelete: "set null",
    }),
    // PLU-135 (1a): the campaignTermsSnapshot this execution is PINNED to,
    // stamped once at enrollment and never rewritten — same mechanism as
    // postAcceptanceMode/emailAccountId above. Nullable: executions enrolled
    // before this migration have no snapshot to point at.
    campaignTermsSnapshotId: text("campaignTermsSnapshotId").references(
      () => campaignTermsSnapshots.id,
      { onDelete: "restrict" },
    ),
    // PLU-135 (1a): same pinning, for the private negotiation bounds. A
    // negotiation must never see its bounds change mid-conversation.
    negotiationPolicySnapshotId: text("negotiationPolicySnapshotId").references(
      () => negotiationPolicySnapshots.id,
      { onDelete: "restrict" },
    ),
    dueAt: ts("dueAt"),
    enrolledAt: tsNow("enrolledAt"),
    completedAt: ts("completedAt"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("ExecutionInstance_workflowVersionId_creatorId_key").on(
      table.workflowVersionId,
      table.creatorId,
    ),
    // HARD-R1: poller + reconciliation sweep scan by currentState (+ dueAt).
    index("ExecutionInstance_currentState_dueAt_idx").on(
      table.currentState,
      table.dueAt,
    ),
    index("ExecutionInstance_emailAccountId_idx").on(table.emailAccountId),
    index("ExecutionInstance_campaignTermsSnapshotId_idx").on(
      table.campaignTermsSnapshotId,
    ),
    index("ExecutionInstance_negotiationPolicySnapshotId_idx").on(
      table.negotiationPolicySnapshotId,
    ),
  ],
);

export const messages = pgTable(
  "Message",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    direction: messageDirectionEnum("direction").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    threadId: text("threadId"),
    senderEmail: text("senderEmail"),
    externalMessageId: text("externalMessageId"),
    idempotencyKey: text("idempotencyKey"),
    replyIntent: replyIntentEnum("replyIntent"),
    classifyConfidence: doublePrecision("classifyConfidence"),
    // Randomized Send Delay — §4.4 poison-loop bound. How many times the poller
    // safety-net sweep has re-driven this reserved-but-unsent OUTBOUND row. The
    // sweep only claims a row while redriveCount < SEND_DELAY_MAX_REDRIVES; past
    // that (or past SEND_DELAY_MAX_SWEEP_AGE_MS) it is left for manual inspection
    // rather than re-enqueued forever. 0 for every non-swept / inbound row.
    redriveCount: integer("redriveCount").notNull().default(0),
    scheduledFor: ts("scheduledFor"),
    initialOutreachQuotaDay: ts("initialOutreachQuotaDay"),
    sentAt: ts("sentAt"),
    receivedAt: ts("receivedAt"),
    processedAt: ts("processedAt"),
    // PLU-121: which connected mailbox this message was sent from / received on.
    // Stamped at send finalize (OUTBOUND) and from the run's pinned account
    // (INBOUND). Nullable; backfilled to the default account by the migration.
    emailAccountId: text("emailAccountId").references(() => connectedEmailAccounts.id, {
      // Historical provider-id namespaces must never collapse to NULL on account
      // deletion: two grants may reuse the same externalMessageId. Operators
      // disable/revoke accounts; rows with message history are deletion-restricted.
      onDelete: "restrict",
    }),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    // Provider message ids are grant-local, not globally unique. Keep one
    // namespace per connected mailbox, while preserving the pre-PLU-121
    // account-less namespace for legacy/mock rows. The second partial index is
    // intentionally not represented in Prisma (partial indexes are unsupported
    // there), but is created by the owning migration.
    uniqueIndex("Message_emailAccountId_externalMessageId_key").on(
      table.emailAccountId,
      table.externalMessageId,
    ),
    uniqueIndex("Message_legacyExternalMessageId_key")
      .on(table.externalMessageId)
      .where(sql`${table.emailAccountId} IS NULL AND ${table.externalMessageId} IS NOT NULL`),
    uniqueIndex("Message_idempotencyKey_key").on(table.idempotencyKey),
    index("Message_threadId_idx").on(table.threadId),
    index("Message_instanceId_idx").on(table.instanceId),
    index("Message_scheduledFor_idx").on(table.scheduledFor),
    index("Message_emailAccountId_idx").on(table.emailAccountId),
  ],
);

export const events = pgTable(
  "Event",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    type: eventTypeEnum("type").notNull(),
    nodeId: text("nodeId"),
    payload: jsonb("payload").$type<JsonValue>(),
    occurredAt: tsNow("occurredAt"),
  },
  (table) => [
    index("Event_instanceId_occurredAt_idx").on(
      table.instanceId,
      table.occurredAt,
    ),
  ],
);

export const outboxJobs = pgTable(
  "OutboxJob",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    dedupeKey: text("dedupeKey").notNull(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("lastError"),
    createdAt: tsNow("createdAt"),
    sentAt: ts("sentAt"),
  },
  (table) => [
    uniqueIndex("OutboxJob_dedupeKey_key").on(table.dedupeKey),
    index("OutboxJob_status_createdAt_idx").on(table.status, table.createdAt),
    index("OutboxJob_instanceId_idx").on(table.instanceId),
  ],
);

// BUG-Q1/Q2: durable dead-letter store for BullMQ jobs that exhausted their
// retries. A worker's on("failed") handler writes a row here on the final failed
// attempt, so the job survives a Redis eviction/flush and can be re-driven (the
// inbound-email re-drive sweep recovers a lost creator reply). instanceId is a
// plain nullable TEXT with NO foreign key on purpose (see the migration).
export const deadLetterJobs = pgTable(
  "DeadLetterJob",
  {
    id: cuidId("id"),
    queue: text("queue").notNull(),
    jobId: text("jobId"),
    jobName: text("jobName"),
    payload: jsonb("payload").$type<JsonValue>().notNull(),
    instanceId: text("instanceId"),
    failReason: text("failReason"),
    attemptsMade: integer("attemptsMade").notNull().default(0),
    status: deadLetterStatusEnum("status").notNull().default("PENDING"),
    redriveCount: integer("redriveCount").notNull().default(0),
    createdAt: tsNow("createdAt"),
    redrivenAt: ts("redrivenAt"),
  },
  (table) => [
    index("DeadLetterJob_queue_status_createdAt_idx").on(
      table.queue,
      table.status,
      table.createdAt,
    ),
    index("DeadLetterJob_instanceId_idx").on(table.instanceId),
    // Idempotent dead-lettering: a (queue, jobId) is recorded at most once. jobId
    // can be null, so this is a PARTIAL unique index over rows that have one.
    uniqueIndex("DeadLetterJob_queue_jobId_key")
      .on(table.queue, table.jobId)
      .where(sql`${table.jobId} IS NOT NULL`),
  ],
);

export const brandNotifications = pgTable(
  "BrandNotification",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    recipient: text("recipient").notNull(),
    reason: text("reason").notNull(),
    status: brandNotificationStatusEnum("status").notNull().default("SENT"),
    idempotencyKey: text("idempotencyKey").notNull(),
    error: text("error"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    uniqueIndex("BrandNotification_idempotencyKey_key").on(table.idempotencyKey),
    index("BrandNotification_instanceId_idx").on(table.instanceId),
  ],
);

export const paymentInfo = pgTable(
  "PaymentInfo",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    token: text("token").notNull(),
    status: paymentInfoStatusEnum("status").notNull().default("PAYMENT_PENDING"),
    method: payoutMethodEnum("method"),
    accountIdentifier: text("accountIdentifier"),
    country: text("country"),
    notes: text("notes"),
    extra: jsonb("extra").$type<JsonValue>(),
    expiresAt: ts("expiresAt"),
    createdAt: tsNow("createdAt"),
    submittedAt: ts("submittedAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("PaymentInfo_instanceId_key").on(table.instanceId),
    uniqueIndex("PaymentInfo_token_key").on(table.token),
    index("PaymentInfo_instanceId_idx").on(table.instanceId),
  ],
);

// PLU-70: the closed-deal snapshot an operator needs to finalize and onboard the
// creator manually in main Pluvus, plus their progress on doing so. The UNIQUE
// instanceId is the idempotency guard — a retried handoff step re-inserts, hits
// the constraint, and no-ops, so the acceptance record is never duplicated.
// Holds no payout fields and no transcript by design.
export const dealHandoffs = pgTable(
  "DealHandoff",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    creatorName: text("creatorName").notNull(),
    creatorEmail: text("creatorEmail").notNull(),
    campaignName: text("campaignName"),
    // Null for commission-only deals — an absent fee is NOT an escalation here,
    // because a human is already the reviewer.
    fixedFee: doublePrecision("fixedFee"),
    commissionRate: doublePrecision("commissionRate"),
    // The negotiation band the deal closed within, snapshotted so the brand
    // confirmation email can show "your range: $500–$600" without re-reading the
    // node config. Null when the campaign had no band configured.
    negotiationFloor: doublePrecision("negotiationFloor"),
    negotiationCeiling: doublePrecision("negotiationCeiling"),
    deliverables: text("deliverables"),
    timeline: text("timeline"),
    paymentTerms: text("paymentTerms"),
    // The campaign perk/reward blurb (e.g. "one pair of the Tempo trainer"),
    // surfaced in the brand confirmation email. Null when the campaign has none.
    rewardDescription: text("rewardDescription"),
    acceptanceMessage: text("acceptanceMessage"),
    threadId: text("threadId"),
    acceptedAt: ts("acceptedAt").notNull(),
    status: dealHandoffStatusEnum("status").notNull().default("AWAITING_FINALIZATION"),
    completedAt: ts("completedAt"),
    completedBy: text("completedBy"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("DealHandoff_instanceId_key").on(table.instanceId),
    index("DealHandoff_status_idx").on(table.status),
  ],
);

// Brand-approval gate: the snapshot the BRAND sees when asked to approve a
// creator the AI closed, plus the magic-link token + their decision. Modeled on
// DealHandoff (same denormalized agreed-terms snapshot) with the Payout token
// pattern bolted on: the DB stores ONLY the sha256 hash of the approve/reject
// token (approveTokenHash) — the raw token lives solely in the brand's email, so
// a DB dump cannot forge an approval. UNIQUE instanceId is the idempotency guard:
// a retried send re-inserts, hits the constraint, and reuses the existing row +
// token (so the emailed links stay valid across retries).
export const brandApprovals = pgTable(
  "BrandApproval",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    creatorName: text("creatorName").notNull(),
    creatorEmail: text("creatorEmail").notNull(),
    campaignName: text("campaignName"),
    // The brand's DISPLAY name (resolveBrandName: node config → campaign.brand),
    // distinct from the campaign name. The hosted approval page headed itself with
    // campaignName, which could show the wrong brand (PLU-118, Calvin review). We
    // persist the resolved brand name so the page can head with the real brand and
    // still say "…for {campaignName}". Nullable: rows written before this column
    // fall back to campaignName at read time (legacy-safe).
    brandName: text("brandName"),
    // Null for commission-only deals. Present on fee deals — the brand email
    // states this figure, so the executor escalates rather than snapshotting a
    // fabricated fee (CRITICAL-3 parity with the merged Content Brief email).
    // NOTE (PLU-118): fixedFee/commissionRate are DISPLAY-ONLY snapshots — the
    // brand email + hosted page render them, nothing does arithmetic on them, and
    // the authoritative money lives in the payout ledger (Obligation/Payout).
    // doublePrecision matches the proto-wide convention for these display figures
    // (Campaign.*, DealHandoff.*); switching this one table to minor-units would
    // diverge from every sibling snapshot without any correctness gain here.
    fixedFee: doublePrecision("fixedFee"),
    commissionRate: doublePrecision("commissionRate"),
    negotiationFloor: doublePrecision("negotiationFloor"),
    negotiationCeiling: doublePrecision("negotiationCeiling"),
    deliverables: text("deliverables"),
    timeline: text("timeline"),
    paymentTerms: text("paymentTerms"),
    rewardDescription: text("rewardDescription"),
    // Platform/handle for the "creator profile" block in the brand email.
    creatorHandle: text("creatorHandle"),
    creatorPlatform: text("creatorPlatform"),
    threadId: text("threadId"),
    acceptedAt: ts("acceptedAt").notNull(),
    // Magic-link token: only the hash is stored (Payout pattern). Expiry gates a
    // leaked/forwarded link; a null expiry never expires (grandfathered).
    approveTokenHash: text("approveTokenHash").notNull(),
    tokenExpiresAt: ts("tokenExpiresAt"),
    status: brandApprovalStatusEnum("status").notNull().default("AWAITING_APPROVAL"),
    // Audit trail of the decision — who/when, and from where.
    decidedAt: ts("decidedAt"),
    decidedIp: text("decidedIp"),
    decidedUserAgent: text("decidedUserAgent"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("BrandApproval_instanceId_key").on(table.instanceId),
    index("BrandApproval_status_idx").on(table.status),
  ],
);

// PLU-111: durable conversation obligations. ONLY-lifecycle data — status +
// pointers back into the canonical Message rows + the original wording (audit).
// NOT a second copy of the conversation (the transcript stays sourced from
// Message rows, PLU-85). Non-terminal rows (OPEN/DEFERRED/ESCALATED) are fed
// into every subsequent /negotiate + /draft context until they reach a terminal
// state (ANSWERED/COMPLETED/CANCELED/NO_LONGER_RELEVANT).
export const conversationObligations = pgTable(
  "ConversationObligation",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    type: obligationTypeEnum("type").notNull(),
    status: convObligationStatusEnum("status").notNull().default("OPEN"),
    // Verbatim, for audit — never overwritten.
    originalText: text("originalText").notNull(),
    // Dedup key (§4.3): lowercase, trimmed, punctuation-stripped, whitespace-
    // collapsed form of originalText.
    normalizedKey: text("normalizedKey").notNull(),
    // Optional light bucket (usage_rights, shipping, timeline, …), best-effort.
    category: text("category"),
    // Short note / answer summary, set on resolution.
    resolution: text("resolution"),
    // "ai" | "operator" | "system".
    resolutionSource: text("resolutionSource"),
    // The inbound row that raised it.
    sourceMessageId: text("sourceMessageId").references(() => messages.id),
    // The SENT row that resolved it (stamped at reserve; flipped terminal at flush).
    resolutionMessageId: text("resolutionMessageId").references(() => messages.id),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
    // Set only on a terminal transition.
    resolvedAt: ts("resolvedAt"),
  },
  (table) => [
    index("ConversationObligation_instanceId_status_idx").on(
      table.instanceId,
      table.status,
    ),
    // Conservative dedup guard (§4.3): at most one NON-TERMINAL obligation per
    // (instance, type, normalizedKey). Partial so terminal history accumulates —
    // an answered-then-re-asked question mints a fresh open row (a new thread).
    // Mirrors migration 20260722140000_plu111_conversation_obligations.
    uniqueIndex("ConversationObligation_open_key")
      .on(table.instanceId, table.type, table.normalizedKey)
      .where(sql`${table.status} IN ('OPEN', 'DEFERRED', 'ESCALATED')`),
  ],
);

// PLU-112: one rolling narrative summary per instance. The summary covers the
// ELIDED transcript prefix so a long draft prompt can window its raw history
// without losing it. `summarizedThroughSentAt` is the coverage cursor — the
// sentAt high-water mark of the folded-in prefix, the same ordering key the
// transcript uses (never a message id; a filtered/rolled-back message must not
// strand the cursor). Narrative-only: rates/questions/commitments stay owned by
// events / obligations / creator memory, never restated here.
export const conversationSummaries = pgTable(
  "ConversationSummary",
  {
    id: cuidId("id"),
    // One summary per instance (unique) — refreshed incrementally, not per-thread.
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    // The narrative body (no dollar/percent figures — post-gen guarded).
    text: text("text").notNull(),
    // The coverage cursor: entries with sentAt <= this are covered by the summary
    // and may be windowed out; entries after it always stay raw. Populated, never
    // null (the whole point — windowing is gated on a real cursor).
    summarizedThroughSentAt: ts("summarizedThroughSentAt").notNull(),
    // The specific Message at the cursor, for audit/debug only (not the key).
    summarizedThroughMessageId: text("summarizedThroughMessageId").references(
      () => messages.id,
    ),
    // Summarizer prompt-version stamp → observability `summaryVersion`.
    version: text("version").notNull(),
    // Best-effort tokens the window saved, for the debug proxy.
    estimatedTokensSaved: integer("estimatedTokensSaved").notNull().default(0),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("ConversationSummary_instanceId_key").on(table.instanceId),
  ],
);

// PLU-113: campaign-scoped creator memory — durable creator facts, keyed on the
// ExecutionInstance (NEVER the Creator: the same creator can have different terms
// across campaigns — issue "Goal"). This table is the LIVE HEAD: one row per fact,
// holding its current value. Every value the fact ever held (including the one it
// holds now) is an immutable row in CampaignCreatorMemoryRevision, so no earlier
// value is ever lost ($400 → $600 → $800 keeps all three — Calvin review #4). The
// head is NOT a second copy of the conversation; provenance is a pointer back to
// the source Message via the current revision.
export const campaignCreatorMemory = pgTable(
  "CampaignCreatorMemory",
  {
    id: cuidId("id"),
    // Campaign-scoped — NEVER the Creator (no cross-campaign leak; issue "Goal").
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    key: memoryFactKeyEnum("key").notNull(),
    status: memoryFactStatusEnum("status").notNull().default("ACTIVE"),
    // Current canonical value as text (numbers stringified). Mirrors the latest
    // revision's value; kept denormalized on the head so the live read is a single
    // indexed scan with no per-fact revision join.
    value: text("value").notNull(),
    // Numeric mirror for numeric keys (null otherwise). Recalculated whenever the
    // head value changes — including an operator edit (Calvin review #5).
    valueNumber: doublePrecision("valueNumber"),
    // Dedup/live-index key: normalize(value) for list keys; a per-key sentinel for
    // singleton keys so the partial-unique live index collapses to one row per
    // (instance, key). Derived by memoryDedupKey — one code path.
    normalizedValue: text("normalizedValue").notNull(),
    // Optional light bucket for objections (reuse topic-gate categories).
    category: text("category"),
    // The current revision this head reflects (its source/evidence/confidence).
    currentRevisionId: text("currentRevisionId"),
    // Conflict pair (Calvin review — "conflicting facts are not silently
    // overwritten"): when a singleton materially changes we set status=CONFLICTED
    // and keep the immediately-prior value + its source here so the model sees
    // "was X, now Y". The FULL history is in the revisions table.
    conflictValue: text("conflictValue"),
    conflictSourceMessageId: text("conflictSourceMessageId").references(
      () => messages.id,
    ),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    index("CampaignCreatorMemory_instanceId_status_idx").on(
      table.instanceId,
      table.status,
    ),
    // At most one LIVE (ACTIVE/CONFLICTED) row per (instance, key, normalizedValue).
    // Singletons collapse via the sentinel; list keys allow one row per distinct
    // value. Partial so SUPERSEDED/REMOVED heads accumulate as history. Mirrors
    // migration 20260803000000_plu113_campaign_creator_memory.
    uniqueIndex("CampaignCreatorMemory_live_key")
      .on(table.instanceId, table.key, table.normalizedValue)
      .where(sql`${table.status} IN ('ACTIVE', 'CONFLICTED')`),
  ],
);

// PLU-113: the immutable revision log for a memory fact (Calvin review #4). Every
// value a fact ever held is one append-only row here — never updated, never
// deleted — so an operator retains the complete audit trail (each prior value +
// its source message + evidence) even after many changes. The AI only reads the
// live head; this table exists for provenance and operator review.
export const campaignCreatorMemoryRevision = pgTable(
  "CampaignCreatorMemoryRevision",
  {
    id: cuidId("id"),
    memoryId: text("memoryId")
      .notNull()
      .references(() => campaignCreatorMemory.id),
    value: text("value").notNull(),
    valueNumber: doublePrecision("valueNumber"),
    // Who authored this value (Calvin review #5). A 'creator' revision carries the
    // sourceMessageId + evidenceText it was extracted from; an 'operator' revision
    // has NO sourceMessageId (the edit did not come from a creator message) and an
    // optional note instead of evidence.
    source: memoryRevisionSourceEnum("source").notNull(),
    // The inbound Message this value was extracted from (creator revisions only;
    // null for operator edits — Calvin review #5).
    sourceMessageId: text("sourceMessageId").references(() => messages.id),
    // The verbatim creator phrase that supports this value (Calvin review #3 +
    // #8). Server-verified to appear in the normalized creator reply before the
    // revision is written; null for operator edits.
    evidenceText: text("evidenceText"),
    // Extraction confidence 0..1 (creator revisions); 1.0 for operator entries.
    confidence: doublePrecision("confidence").notNull().default(0),
    // Operator note on a correction (operator revisions only).
    note: text("note"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    index("CampaignCreatorMemoryRevision_memoryId_idx").on(table.memoryId),
  ],
);

// PLU-113: a durable record of a memory write plan that FAILED to apply (Calvin
// review #6). Persisting the reply must never be blocked by a memory-write error,
// but the failure must not vanish into stdout either: the plan is captured here so
// it is operator-visible and a sweep can retry it. Reuses DeadLetterStatus:
// PENDING → REDRIVEN (a retry succeeded) | DISCARDED (an operator dismissed it).
// Written from OUTSIDE the failed transaction, so a rolled-back memory tx still
// leaves a recoverable trace.
export const failedMemoryWrite = pgTable(
  "FailedMemoryWrite",
  {
    id: cuidId("id"),
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    // The serialized MemoryWritePlanItem[] that failed — enough to replay.
    plan: jsonb("plan").notNull().$type<JsonValue>(),
    // The source inbound message id the plan's creator facts came from.
    sourceMessageId: text("sourceMessageId").references(() => messages.id),
    error: text("error").notNull(),
    // PENDING until a retry succeeds or an operator dismisses it.
    status: deadLetterStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
    resolvedAt: ts("resolvedAt"),
  },
  (table) => [
    index("FailedMemoryWrite_instanceId_status_idx").on(
      table.instanceId,
      table.status,
    ),
  ],
);

// HARD-O1: one row per LLM call the agent service made on behalf of a workflow
// instance — the durable token/latency/cost telemetry the in-process agent ring
// buffer cannot provide. Rows are written best-effort by the observability sink
// (llmUsage.ts) from the `llmUsage` block each agent response carries; a lost
// row degrades reporting, never the workflow, so there is no FK-cascade or
// NOT NULL coupling beyond the instance reference. instanceId is nullable:
// calls made outside an instance step (harnesses, ad-hoc API use) still count
// toward totals. Token columns are nullable — a provider that reports no
// usage_metadata stays "unreported", distinct from 0.
export const llmCalls = pgTable(
  "LlmCall",
  {
    id: cuidId("id"),
    instanceId: text("instanceId").references(() => executionInstances.id),
    // Which agent path made the call: "classify" | "negotiate" | "draft".
    role: text("role").notNull(),
    // Provider-qualified model label (e.g. "anthropic:claude-opus-4-8").
    model: text("model").notNull(),
    promptVersion: text("promptVersion"),
    latencyMs: doublePrecision("latencyMs").notNull(),
    inputTokens: integer("inputTokens"),
    outputTokens: integer("outputTokens"),
    totalTokens: integer("totalTokens"),
    estCostUsd: doublePrecision("estCostUsd"),
    ok: boolean("ok").notNull().default(true),
    errorKind: text("errorKind"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    index("LlmCall_instanceId_idx").on(table.instanceId),
    index("LlmCall_createdAt_idx").on(table.createdAt),
  ],
);

/** The agent paths that produce LLM calls (LlmCall.role values). */
export type LlmCallRole = "classify" | "negotiate" | "draft" | "summarize";

// ---------------------------------------------------------------------------
// Attribution & Payout ledger (Phase 1+)
// ---------------------------------------------------------------------------

export const partnerships = pgTable(
  "Partnership",
  {
    id: cuidId("id"),
    instanceId: text("instanceId").notNull().references(() => executionInstances.id),
    campaignId: text("campaignId").references(() => campaigns.id),
    creatorId: text("creatorId").notNull().references(() => creators.id),
    referralCode: text("referralCode").notNull(),
    trackingLink: text("trackingLink"),
    commissionRate: real("commissionRate"),
    agreedFeeCents: integer("agreedFeeCents"),
    status: partnershipStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    uniqueIndex("Partnership_instanceId_key").on(table.instanceId),
    uniqueIndex("Partnership_referralCode_key").on(table.referralCode),
    index("Partnership_campaignId_idx").on(table.campaignId),
    index("Partnership_creatorId_idx").on(table.creatorId),
  ],
);

// ---------------------------------------------------------------------------
// Attribution tables (Phase 2)
// ---------------------------------------------------------------------------

export const clicks = pgTable(
  "Click",
  {
    id: cuidId("id"),
    partnershipId: text("partnershipId").notNull().references(() => partnerships.id),
    referralCode: text("referralCode").notNull(),
    ip: text("ip"),
    userAgent: text("userAgent"),
    referer: text("referer"),
    clickedAt: tsNow("clickedAt"),
  },
  (table) => [
    index("Click_partnershipId_idx").on(table.partnershipId),
    index("Click_clickedAt_idx").on(table.clickedAt),
  ],
);

export const conversions = pgTable(
  "Conversion",
  {
    id: cuidId("id"),
    partnershipId: text("partnershipId").references(() => partnerships.id),
    referralCode: text("referralCode"),
    externalId: text("externalId").notNull(),
    valueCents: integer("valueCents").notNull(),
    currency: text("currency").notNull().default("USD"),
    commissionCents: integer("commissionCents").notNull().default(0),
    customerEmail: text("customerEmail"),
    metadata: jsonb("metadata").$type<JsonValue>(),
    payoutId: text("payoutId"),
    refunded: boolean("refunded").notNull().default(false),
    attributedAt: tsNow("attributedAt"),
  },
  (table) => [
    uniqueIndex("Conversion_externalId_key").on(table.externalId),
    index("Conversion_partnershipId_idx").on(table.partnershipId),
    index("Conversion_payoutId_idx").on(table.payoutId),
  ],
);

// ---------------------------------------------------------------------------
// Payout ledger (Phase 3)
// ---------------------------------------------------------------------------
// The post-terminal money ledger, keyed off the completed instance's
// Partnership. An Obligation is the fixed collaboration fee owed (minted at
// partnership activation); a Payout is a concrete disbursement the brand records
// as paid (commission-batch or fixed-fee). Money is integer cents (I-1); the
// method/destination are COPIED from PaymentInfo at creation (I-2). Confirm
// tokens are stored sha256-hashed only — the raw token lives solely in the email.

export const obligations = pgTable(
  "Obligation",
  {
    id: cuidId("id"),
    partnershipId: text("partnershipId")
      .notNull()
      .references(() => partnerships.id),
    description: text("description").notNull(), // "Agreed collaboration fee"
    amountCents: integer("amountCents").notNull(),
    status: obligationStatusEnum("status").notNull().default("PENDING"),
    payoutId: text("payoutId"), // set when converted to a payout (I-4)
    createdAt: tsNow("createdAt"),
    paidAt: ts("paidAt"),
  },
  (table) => [
    index("Obligation_partnershipId_idx").on(table.partnershipId),
    // BUG-D1: a partnership has at most ONE auto-minted fee obligation. This
    // partial unique index enforces that invariant at the DB level so a
    // concurrent mint race (BullMQ retry vs reconciliation) cannot slip a second
    // "Agreed collaboration fee" row past mintFeeObligation's check-then-insert →
    // the brand never pays the fee twice. Partial (scoped to the fee row's fixed
    // description) so future manual/extra obligations remain unconstrained.
    // Mirrors migration 20260719120000_bug_d1_obligation_fee_unique.
    uniqueIndex("Obligation_partnershipId_fee_key")
      .on(table.partnershipId)
      .where(sql`${table.description} = 'Agreed collaboration fee'`),
  ],
);

export const payouts = pgTable(
  "Payout",
  {
    id: cuidId("id"),
    partnershipId: text("partnershipId")
      .notNull()
      .references(() => partnerships.id),
    payoutType: payoutTypeEnum("payoutType").notNull(),
    amountCents: integer("amountCents").notNull(),
    currency: text("currency").notNull().default("USD"),
    status: payoutStatusEnum("status").notNull().default("PENDING"),
    method: payoutMethodEnum("method"), // I-2: copied from PaymentInfo at creation
    destination: text("destination"), // I-2: copied accountIdentifier (PayPal email)
    reference: text("reference"), // PayPal txn id, set at mark-sent
    note: text("note"),
    conversionCount: integer("conversionCount").notNull().default(0),
    confirmTokenHash: text("confirmTokenHash"), // sha256 hex — raw token never stored
    confirmTokenExpiresAt: ts("confirmTokenExpiresAt"),
    confirmIp: text("confirmIp"),
    confirmUserAgent: text("confirmUserAgent"),
    sentAt: ts("sentAt"),
    confirmedAt: ts("confirmedAt"),
    disputedAt: ts("disputedAt"),
    settledAt: ts("settledAt"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    index("Payout_partnershipId_idx").on(table.partnershipId),
    index("Payout_status_idx").on(table.status),
  ],
);

// ---------------------------------------------------------------------------
// drizzle-zod insert-schema companions (parent Pluvus convention)
// ---------------------------------------------------------------------------

export const insertCampaignSchema = createInsertSchema(campaigns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertWorkflowSchema = createInsertSchema(workflows).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertConnectedEmailAccountSchema = createInsertSchema(
  connectedEmailAccounts,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertWorkflowVersionSchema = createInsertSchema(
  workflowVersions,
).omit({ id: true, createdAt: true, publishedAt: true });
export const insertCreatorSchema = createInsertSchema(creators).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertCreatorImportBatchSchema = createInsertSchema(
  creatorImportBatches,
).omit({ id: true, createdAt: true });
export const insertCreatorImportBatchMemberSchema = createInsertSchema(
  creatorImportBatchMembers,
).omit({ id: true, createdAt: true });
export const insertExecutionInstanceSchema = createInsertSchema(
  executionInstances,
).omit({ id: true, createdAt: true, updatedAt: true, enrolledAt: true });
export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});
export const insertEventSchema = createInsertSchema(events).omit({
  id: true,
  occurredAt: true,
});
export const insertOutboxJobSchema = createInsertSchema(outboxJobs).omit({
  id: true,
  createdAt: true,
});
export const insertDeadLetterJobSchema = createInsertSchema(deadLetterJobs).omit({
  id: true,
  createdAt: true,
});
export const insertBrandNotificationSchema = createInsertSchema(
  brandNotifications,
).omit({ id: true, createdAt: true });
export const insertPaymentInfoSchema = createInsertSchema(paymentInfo).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertDealHandoffSchema = createInsertSchema(dealHandoffs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertConversationObligationSchema = createInsertSchema(
  conversationObligations,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCampaignCreatorMemorySchema = createInsertSchema(
  campaignCreatorMemory,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCampaignCreatorMemoryRevisionSchema = createInsertSchema(
  campaignCreatorMemoryRevision,
).omit({ id: true, createdAt: true });
export const insertFailedMemoryWriteSchema = createInsertSchema(
  failedMemoryWrite,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPartnershipSchema = createInsertSchema(partnerships).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertClickSchema = createInsertSchema(clicks).omit({
  id: true,
  clickedAt: true,
});
export const insertConversionSchema = createInsertSchema(conversions).omit({
  id: true,
  attributedAt: true,
});
export const insertObligationSchema = createInsertSchema(obligations).omit({
  id: true,
  createdAt: true,
});
export const insertPayoutSchema = createInsertSchema(payouts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// ---------------------------------------------------------------------------
// Inferred model types — same names @prisma/client exported
// ---------------------------------------------------------------------------

export type Campaign = typeof campaigns.$inferSelect;
export type CampaignOutreachDay = typeof campaignOutreachDays.$inferSelect;
export type ConnectedEmailAccount = typeof connectedEmailAccounts.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type Creator = typeof creators.$inferSelect;
export type CreatorImportBatch = typeof creatorImportBatches.$inferSelect;
export type CreatorImportBatchMember = typeof creatorImportBatchMembers.$inferSelect;
export type ExecutionInstance = typeof executionInstances.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Event = typeof events.$inferSelect;
export type OutboxJob = typeof outboxJobs.$inferSelect;
export type DeadLetterJob = typeof deadLetterJobs.$inferSelect;
export type BrandNotification = typeof brandNotifications.$inferSelect;
export type PaymentInfo = typeof paymentInfo.$inferSelect;
export type DealHandoff = typeof dealHandoffs.$inferSelect;
export type BrandApproval = typeof brandApprovals.$inferSelect;
export type ConversationObligation = typeof conversationObligations.$inferSelect;
export type ConversationSummary = typeof conversationSummaries.$inferSelect;
export type CampaignCreatorMemory = typeof campaignCreatorMemory.$inferSelect;
export type CampaignCreatorMemoryRevision =
  typeof campaignCreatorMemoryRevision.$inferSelect;
export type FailedMemoryWrite = typeof failedMemoryWrite.$inferSelect;
export type Partnership = typeof partnerships.$inferSelect;
export type Click = typeof clicks.$inferSelect;
export type Conversion = typeof conversions.$inferSelect;
export type Obligation = typeof obligations.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type LlmCall = typeof llmCalls.$inferSelect;

// PLU-135 (1a)
export type CampaignDetails = typeof campaignDetails.$inferSelect;
export type CampaignTermsSnapshot = typeof campaignTermsSnapshots.$inferSelect;
export type CampaignBriefExtraction = typeof campaignBriefExtractions.$inferSelect;
export type NegotiationPolicy = typeof negotiationPolicies.$inferSelect;
export type NegotiationPolicySnapshot = typeof negotiationPolicySnapshots.$inferSelect;
export type BrandIdentity = typeof brandIdentities.$inferSelect;
export type CreatorRequirement = typeof creatorRequirements.$inferSelect;
export type CampaignBrief = typeof campaignBriefs.$inferSelect;
export type CampaignAuditEvent = typeof campaignAuditEvents.$inferSelect;

export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type InsertWorkflowVersion = z.infer<typeof insertWorkflowVersionSchema>;
export type InsertCreator = z.infer<typeof insertCreatorSchema>;
export type InsertExecutionInstance = z.infer<
  typeof insertExecutionInstanceSchema
>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type InsertOutboxJob = z.infer<typeof insertOutboxJobSchema>;
export type InsertDeadLetterJob = z.infer<typeof insertDeadLetterJobSchema>;
export type InsertBrandNotification = z.infer<
  typeof insertBrandNotificationSchema
>;
export type InsertPaymentInfo = z.infer<typeof insertPaymentInfoSchema>;
export type InsertDealHandoff = z.infer<typeof insertDealHandoffSchema>;
export type InsertConversationObligation = z.infer<
  typeof insertConversationObligationSchema
>;
export type InsertPartnership = z.infer<typeof insertPartnershipSchema>;
export type InsertClick = z.infer<typeof insertClickSchema>;
export type InsertConversion = z.infer<typeof insertConversionSchema>;
export type InsertObligation = z.infer<typeof insertObligationSchema>;
export type InsertPayout = z.infer<typeof insertPayoutSchema>;

// Raw insert types (what db.insert(...).values() accepts, ids/timestamps
// optional because of the $defaultFn/default declarations above).
export type CampaignInsert = typeof campaigns.$inferInsert;
export type CampaignOutreachDayInsert = typeof campaignOutreachDays.$inferInsert;
export type ConnectedEmailAccountInsert = typeof connectedEmailAccounts.$inferInsert;
export type InsertConnectedEmailAccount = z.infer<
  typeof insertConnectedEmailAccountSchema
>;
export type WorkflowInsert = typeof workflows.$inferInsert;
export type WorkflowVersionInsert = typeof workflowVersions.$inferInsert;
export type CreatorInsert = typeof creators.$inferInsert;
export type CreatorImportBatchInsert = typeof creatorImportBatches.$inferInsert;
export type CreatorImportBatchMemberInsert = typeof creatorImportBatchMembers.$inferInsert;
export type ExecutionInstanceInsert = typeof executionInstances.$inferInsert;
export type MessageInsert = typeof messages.$inferInsert;
export type EventInsert = typeof events.$inferInsert;
export type OutboxJobInsert = typeof outboxJobs.$inferInsert;
export type DeadLetterJobInsert = typeof deadLetterJobs.$inferInsert;
export type BrandNotificationInsert = typeof brandNotifications.$inferInsert;
export type PaymentInfoInsert = typeof paymentInfo.$inferInsert;
export type DealHandoffInsert = typeof dealHandoffs.$inferInsert;
export type BrandApprovalInsert = typeof brandApprovals.$inferInsert;
export type ConversationObligationInsert = typeof conversationObligations.$inferInsert;
export type ConversationSummaryInsert = typeof conversationSummaries.$inferInsert;
export type CampaignCreatorMemoryInsert = typeof campaignCreatorMemory.$inferInsert;
export type CampaignCreatorMemoryRevisionInsert =
  typeof campaignCreatorMemoryRevision.$inferInsert;
export type FailedMemoryWriteInsert = typeof failedMemoryWrite.$inferInsert;
export type PartnershipInsert = typeof partnerships.$inferInsert;
export type ClickInsert = typeof clicks.$inferInsert;
export type ConversionInsert = typeof conversions.$inferInsert;
export type ObligationInsert = typeof obligations.$inferInsert;
export type PayoutInsert = typeof payouts.$inferInsert;
export type LlmCallInsert = typeof llmCalls.$inferInsert;

// PLU-135 (1a)
export type CampaignDetailsInsert = typeof campaignDetails.$inferInsert;
export type CampaignTermsSnapshotInsert = typeof campaignTermsSnapshots.$inferInsert;
export type CampaignBriefExtractionInsert = typeof campaignBriefExtractions.$inferInsert;
export type NegotiationPolicyInsert = typeof negotiationPolicies.$inferInsert;
export type NegotiationPolicySnapshotInsert =
  typeof negotiationPolicySnapshots.$inferInsert;
export type BrandIdentityInsert = typeof brandIdentities.$inferInsert;
export type CreatorRequirementInsert = typeof creatorRequirements.$inferInsert;
export type CampaignBriefInsert = typeof campaignBriefs.$inferInsert;
export type CampaignAuditEventInsert = typeof campaignAuditEvents.$inferInsert;
