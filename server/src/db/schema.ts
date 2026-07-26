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
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
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

// Brand-approval gate: lifecycle of the brand's Approve/Reject decision on a
// creator the AI closed. AWAITING_APPROVAL until the brand clicks a magic link;
// then APPROVED (content brief released) or REJECTED (halt to manual review).
export const brandApprovalStatusEnum = pgEnum("BrandApprovalStatus", [
  "AWAITING_APPROVAL",
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

// PLU-113: Campaign-Scoped Creator Memory. The narrow durable-fact taxonomy +
// the fact lifecycle. Member order mirrors the DB (created whole by CREATE TYPE
// in the migration). Distinct from the payout Obligation and the PLU-111
// ConversationObligation — named CampaignCreatorMemory / MemoryFactKey /
// MemoryFactStatus to avoid any collision.
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
export const memoryFactStatusEnum = pgEnum("MemoryFactStatus", [
  "ACTIVE",
  "CONFLICTED",
  "SUPERSEDED",
  "REMOVED",
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
// PLU-113 — campaign-scoped creator memory.
export type MemoryFactKey = (typeof memoryFactKeyEnum.enumValues)[number];
export type MemoryFactStatus = (typeof memoryFactStatusEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Definition models
// ---------------------------------------------------------------------------

export const campaigns = pgTable("Campaign", {
  id: cuidId("id"),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  objective: text("objective"),
  notes: text("notes"),
  notifyEmail: text("notifyEmail"),
  brandDescription: text("brandDescription"),
  deliverables: text("deliverables"),
  timeline: text("timeline"),
  rewardDescription: text("rewardDescription"),
  shipsPhysicalProduct: boolean("shipsPhysicalProduct").notNull().default(false),
  usageRights: text("usageRights"),
  exclusivity: text("exclusivity"),
  paymentTerms: text("paymentTerms"),
  attributionWindow: text("attributionWindow"),
  targetUrl: text("targetUrl"),
  hiddenParamKey: text("hiddenParamKey").notNull().default("_from"),
  // PLU-70: the campaign-level DEFAULT only. Enrollment stamps the effective
  // mode onto each ExecutionInstance, so editing this cannot reach a running one.
  postAcceptanceMode: postAcceptanceModeEnum("postAcceptanceMode")
    .notNull()
    .default("local_payment"),
  createdAt: tsNow("createdAt"),
  updatedAt: tsUpdatedAt("updatedAt"),
});

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
    sentAt: ts("sentAt"),
    receivedAt: ts("receivedAt"),
    processedAt: ts("processedAt"),
    createdAt: tsNow("createdAt"),
  },
  (table) => [
    uniqueIndex("Message_externalMessageId_key").on(table.externalMessageId),
    uniqueIndex("Message_idempotencyKey_key").on(table.idempotencyKey),
    index("Message_threadId_idx").on(table.threadId),
    index("Message_instanceId_idx").on(table.instanceId),
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
    // Null for commission-only deals. Present on fee deals — the brand email
    // states this figure, so the executor escalates rather than snapshotting a
    // fabricated fee (CRITICAL-3 parity with the merged Content Brief email).
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

// PLU-113: campaign-scoped creator memory — one row per durable creator fact,
// keyed on ExecutionInstance (NEVER Creator, invariant #1). A fact is durable
// state + a pointer back to the inbound Message that stated it (sourceMessageId,
// invariant #3), NOT a second copy of the conversation (invariant #2). See
// .claude/spec/plu-113-campaign-scoped-creator-memory/PLAN.md.
export const campaignCreatorMemory = pgTable(
  "CampaignCreatorMemory",
  {
    id: cuidId("id"),
    // Campaign-scoped key — NEVER Creator (invariant #1).
    instanceId: text("instanceId")
      .notNull()
      .references(() => executionInstances.id),
    key: memoryFactKeyEnum("key").notNull(),
    status: memoryFactStatusEnum("status").notNull().default("ACTIVE"),
    // Canonical value as text (numbers stringified). e.g. "600", "unavailable
    // until August", "no perpetual usage rights", "Jane <jane@mgmt.co>".
    value: text("value").notNull(),
    // Convenience numeric mirror for the rate facts (null for non-numeric keys).
    valueNumber: doublePrecision("valueNumber"),
    // Dedup key (§4.6): normalized(value) for list keys; a per-key sentinel for
    // singleton keys so the partial-unique live index collapses to one row per
    // (instance, key).
    normalizedValue: text("normalizedValue").notNull(),
    // Optional light bucket for objections (reuse topic-gate categories), best-effort.
    category: text("category"),
    // Provenance (invariant #3). The inbound Message that stated it; null for
    // operator entries.
    sourceMessageId: text("sourceMessageId").references(() => messages.id),
    // "ai" (extracted from creator inbound) | "operator" (entered/corrected).
    source: text("source").notNull().default("ai"),
    // 0..1. Model-reported extraction confidence; 1.0 for operator-entered/confirmed.
    confidence: doublePrecision("confidence").notNull().default(0),
    // Conflict trail (invariant #5): when a singleton value materially changes we
    // keep the PRIOR value + its source here and set status = CONFLICTED.
    priorValue: text("priorValue"),
    priorSourceMessageId: text("priorSourceMessageId").references(
      () => messages.id,
    ),
    // Operator note on a correction/resolution.
    note: text("note"),
    createdAt: tsNow("createdAt"),
    updatedAt: tsUpdatedAt("updatedAt"),
  },
  (table) => [
    index("CampaignCreatorMemory_instanceId_status_idx").on(
      table.instanceId,
      table.status,
    ),
    // At most one LIVE (ACTIVE/CONFLICTED) row per (instance, key,
    // normalizedValue). For SINGLETON keys normalizedValue is a per-key sentinel
    // → one live row per (instance, key). For LIST keys it's normalized(value) →
    // one row per distinct value. Partial so superseded/removed history can
    // accumulate. Mirrors migration 20260726120000_plu113_campaign_creator_memory.
    uniqueIndex("CampaignCreatorMemory_live_key")
      .on(table.instanceId, table.key, table.normalizedValue)
      .where(sql`${table.status} IN ('ACTIVE', 'CONFLICTED')`),
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
export type LlmCallRole = "classify" | "negotiate" | "draft";

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
export type CampaignCreatorMemory = typeof campaignCreatorMemory.$inferSelect;
export type CampaignCreatorMemoryInsert =
  typeof campaignCreatorMemory.$inferInsert;
export type Partnership = typeof partnerships.$inferSelect;
export type Click = typeof clicks.$inferSelect;
export type Conversion = typeof conversions.$inferSelect;
export type Obligation = typeof obligations.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type LlmCall = typeof llmCalls.$inferSelect;

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
export type InsertCampaignCreatorMemory = z.infer<
  typeof insertCampaignCreatorMemorySchema
>;
export type InsertPartnership = z.infer<typeof insertPartnershipSchema>;
export type InsertClick = z.infer<typeof insertClickSchema>;
export type InsertConversion = z.infer<typeof insertConversionSchema>;
export type InsertObligation = z.infer<typeof insertObligationSchema>;
export type InsertPayout = z.infer<typeof insertPayoutSchema>;

// Raw insert types (what db.insert(...).values() accepts, ids/timestamps
// optional because of the $defaultFn/default declarations above).
export type CampaignInsert = typeof campaigns.$inferInsert;
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
export type PartnershipInsert = typeof partnerships.$inferInsert;
export type ClickInsert = typeof clicks.$inferInsert;
export type ConversionInsert = typeof conversions.$inferInsert;
export type ObligationInsert = typeof obligations.$inferInsert;
export type PayoutInsert = typeof payouts.$inferInsert;
export type LlmCallInsert = typeof llmCalls.$inferInsert;
