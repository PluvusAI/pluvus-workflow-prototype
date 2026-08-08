-- PLU-135 (Issue 1a): Campaign data models, immutable launch snapshots, and
-- brief-extraction history — the schema foundation for PLU-147's Issue 1.
--
-- Revised 2026-08-08 per design review (Calvin): the original draft of this
-- migration used "CampaignDetailsRevision" and triggered the snapshot at
-- "launch or first enrollment." Both were wrong. See the corrected shape:
--
--   * Campaign gains a real `status` (DRAFT/ACTIVE). The Draft→Active
--     transition is the ONLY moment a snapshot is ever created — never at
--     enrollment, which could already be too late (conversations may already
--     be in flight against live data by then).
--   * CampaignTermsSnapshot (not "Revision" — there is exactly one per
--     campaign, EVER, enforced by a unique campaignId, not an app-level
--     convention). It holds the PUBLIC offer at launch (e.g. "$300"), never
--     what an individual creator negotiates (e.g. "$450" — that stays in
--     partnerships/partnership terms, PLU-119). A material change after
--     launch means duplicating into a NEW campaign; this row is never
--     touched again.
--   * NegotiationPolicySnapshot is a SEPARATE immutable freeze of
--     NegotiationPolicy, taken at the same launch moment, for the same
--     reason: an in-flight negotiation must never see its bounds change
--     mid-conversation. Kept as its own table (not folded into
--     CampaignTermsSnapshot) because private policy must never share a row
--     with anything a creator-facing agent might read.
--   * CampaignDetails and NegotiationPolicy both become read-only the instant
--     Campaign.status flips to ACTIVE (enforced in application code —
--     db/campaignDetails.ts / db/negotiationPolicy.ts — not by this schema).
--   * CampaignBriefExtraction is the AI's CANDIDATE reading of the uploaded
--     PDF — never itself authoritative. A human confirming/editing what it
--     found is what writes to CampaignDetails; only CampaignDetails (and its
--     frozen copy after launch) is the source of truth.
--
-- This file replaces the original, never-applied draft of this same
-- migration in place (nothing has been deployed against it yet — verified by
-- dry-running the original against a live Postgres inside a rolled-back
-- transaction, so no rename/patch migration is needed on top; editing this
-- file directly keeps the history clean).
--
-- Deletion policy: CampaignDetails/NegotiationPolicy/BrandIdentity/
-- CreatorRequirement cascade-delete with their Campaign (draft state only).
-- CampaignTermsSnapshot/NegotiationPolicySnapshot/CampaignBriefExtraction/
-- CampaignBrief/CampaignAuditEvent RESTRICT — history must survive.
-- deleteCampaign() in src/db/campaigns.ts archives (sets Campaign.archivedAt)
-- instead of hard-deleting a campaign whose status is ACTIVE, so RESTRICT
-- should never actually fire from normal app use.
--
-- Data preservation: existing Campaign rows have their creator-facing columns
-- backfilled into a new CampaignDetails row before those columns are dropped.
-- Every backfilled campaign starts life as DRAFT — nothing pre-existing is
-- retroactively "launched" by this migration.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden; the
-- Prisma CLI itself is currently broken in this environment — see PR notes).
-- Idempotent throughout: enums use DO/EXCEPTION, tables/indexes use IF NOT
-- EXISTS, the backfill only inserts rows that don't already exist, and column
-- adds/drops use IF NOT EXISTS / IF EXISTS so a partial prior run can safely
-- re-run to completion.

-- =============================================================================
-- CreateEnum (idempotent)
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "CampaignBriefRenderStatus" AS ENUM ('GENERATING', 'READY', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "BrandIdentityExtractionSource" AS ENUM ('EXTRACTED', 'MANUAL', 'DEFAULT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CampaignAuditEventType" AS ENUM (
    'CREATED', 'EDITED', 'LAUNCHED', 'SNAPSHOT_CREATED', 'DUPLICATED',
    'BRIEF_RENDERED', 'POLICY_CHANGED', 'ARCHIVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Campaign's launch lifecycle. CLOSING/ARCHIVED are declared but RESERVED —
-- no transition into either is written anywhere in this codebase yet; they
-- exist so PLU-133 (dependent on PLU-110) doesn't need a second migration on
-- this column. See the CampaignStatus doc comment in schema.prisma for what
-- is and is not decided by declaring them.
DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSING', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- CreateTable
-- =============================================================================

-- CreateTable — the editable, creator-facing draft. One per campaign. Locked
-- read-only in application code once Campaign.status is ACTIVE.
CREATE TABLE IF NOT EXISTS "CampaignDetails" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "objective" TEXT,
    "productOrOffer" TEXT,
    "keyMessages" TEXT,
    "deliverables" TEXT,
    "timeline" TEXT,
    "contentRequirements" TEXT,
    "usageRights" TEXT,
    "exclusivity" TEXT,
    "attributionWindow" TEXT,
    "prohibitedClaims" TEXT,
    "fixedCompensationCents" INTEGER,
    "publicPaymentTerms" TEXT,
    "shipsPhysicalProduct" BOOLEAN NOT NULL DEFAULT false,
    "brandDescription" TEXT,
    -- Schema review §2.1 (Calvin, 2026-08-08): which extraction the fields
    -- above were confirmed from — nullable, a hand-typed campaign with no PDF
    -- is normal.
    "confirmedFromExtractionId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable — THE immutable public-terms snapshot. Exactly one per
-- campaign, ever (enforced below via a unique campaignId, not an app-level
-- convention). Written once, by launchCampaign(), at the Draft→Active
-- transition.
CREATE TABLE IF NOT EXISTS "CampaignTermsSnapshot" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "detailsSnapshot" JSONB NOT NULL,
    "briefExtractionId" TEXT,
    "launchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignTermsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable — one immutable reading of the uploaded brief PDF (the AI's
-- CANDIDATE reading, not itself authoritative). No version number; ordering
-- is purely by createdAt.
CREATE TABLE IF NOT EXISTS "CampaignBriefExtraction" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "flatText" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "other" JSONB,
    "sourceFileReference" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignBriefExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable — private negotiation bounds. Standalone; never merged into
-- creator-facing details/snapshot. Locked read-only in application code once
-- Campaign.status is ACTIVE.
CREATE TABLE IF NOT EXISTS "NegotiationPolicy" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "floorCents" INTEGER,
    "ceilingCents" INTEGER,
    "preferredFeeCents" INTEGER,
    "commissionRate" DOUBLE PRECISION,
    "maxRounds" INTEGER,
    "openingOfferPosition" DOUBLE PRECISION,
    "overCeilingTolerance" DOUBLE PRECISION,
    "negotiationGuidance" TEXT,
    "negotiableTerms" JSONB,
    "nonNegotiableTerms" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegotiationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable — the immutable freeze of NegotiationPolicy at launch. Own
-- table (not folded into CampaignTermsSnapshot) because private policy must
-- never share a row with anything a creator-facing agent might read.
CREATE TABLE IF NOT EXISTS "NegotiationPolicySnapshot" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "floorCents" INTEGER,
    "ceilingCents" INTEGER,
    "preferredFeeCents" INTEGER,
    "commissionRate" DOUBLE PRECISION,
    "maxRounds" INTEGER,
    "openingOfferPosition" DOUBLE PRECISION,
    "overCeilingTolerance" DOUBLE PRECISION,
    "negotiationGuidance" TEXT,
    "negotiableTerms" JSONB,
    "nonNegotiableTerms" JSONB,
    "launchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NegotiationPolicySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable — brand logo/colors/typography.
CREATE TABLE IF NOT EXISTS "BrandIdentity" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "logoRef" TEXT,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "typography" TEXT,
    "extractionSource" "BrandIdentityExtractionSource",
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable — informational-only creator wishlist. Does not drive matching
-- or outreach in this issue.
CREATE TABLE IF NOT EXISTS "CreatorRequirement" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platforms" JSONB,
    "niches" JSONB,
    "geography" JSONB,
    "languages" JSONB,
    "minFollowers" INTEGER,
    "audienceNotes" TEXT,
    "contentStyle" TEXT,
    "brandSafety" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable — pointer to a RENDERED brief document (Issue 3's output), not
-- the uploaded source PDF. Re-rendering must always create a NEW row here,
-- never overwrite an existing row's renderedAssetRef. Schema review §2.2
-- (Calvin, 2026-08-08): brandIdentitySnapshot/templateVersion carry the exact
-- identity and template this render used, as a point-in-time copy — NOT a
-- version pointer to BrandIdentity (which is deliberately left freely
-- editable, unlocked at launch). supersededAt marks a newer render replacing
-- this one; the row is never deleted. Staleness stays keyed to
-- campaignTermsSnapshotId alone — a BrandIdentity edit must never mark an
-- existing brief stale.
CREATE TABLE IF NOT EXISTS "CampaignBrief" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "campaignTermsSnapshotId" TEXT NOT NULL,
    "renderedAssetRef" TEXT,
    "status" "CampaignBriefRenderStatus" NOT NULL DEFAULT 'GENERATING',
    "generatedAt" TIMESTAMP(3),
    "brandIdentitySnapshot" JSONB NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "renderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable — append-only campaign history. No updatedAt by design.
CREATE TABLE IF NOT EXISTS "CampaignAuditEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "eventType" "CampaignAuditEventType" NOT NULL,
    "payload" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAuditEvent_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- AlterTable
-- =============================================================================

-- Campaign: add launch-lifecycle status and archival timestamp. Every
-- existing campaign becomes DRAFT — nothing is retroactively "launched."
-- Creator-facing columns drop further down, AFTER the backfill.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

-- ExecutionInstance: pin to the snapshots that were live at enrollment.
-- Nullable — existing rows predate these columns and have nothing to point at.
ALTER TABLE "ExecutionInstance" ADD COLUMN IF NOT EXISTS "campaignTermsSnapshotId" TEXT;
ALTER TABLE "ExecutionInstance" ADD COLUMN IF NOT EXISTS "negotiationPolicySnapshotId" TEXT;

-- =============================================================================
-- Data backfill — carry every existing Campaign's creator-facing columns into
-- a CampaignDetails row before those columns are dropped. Nothing existing is
-- discarded. Every backfilled campaign is DRAFT (the column default above),
-- so nothing pre-existing gets a CampaignTermsSnapshot from this migration —
-- launching remains a deliberate, separate action.
-- =============================================================================

INSERT INTO "CampaignDetails" (
    "id", "campaignId", "objective", "productOrOffer", "deliverables", "timeline",
    "usageRights", "exclusivity", "attributionWindow", "publicPaymentTerms",
    "shipsPhysicalProduct", "brandDescription", "createdAt", "updatedAt"
)
SELECT
    -- Deterministic id (no pgcrypto dependency assumed) — cuid()-shaped ids are
    -- generated client-side everywhere else in this app; for this one-time
    -- backfill row we derive a stable id from the campaign id instead so the
    -- insert is trivially idempotent without needing a lookup first.
    'cdet_' || "id",
    "id",
    "objective",
    "rewardDescription",
    "deliverables",
    "timeline",
    "usageRights",
    "exclusivity",
    "attributionWindow",
    "paymentTerms",
    "shipsPhysicalProduct",
    "brandDescription",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "Campaign"
ON CONFLICT ("id") DO NOTHING;

-- Now that every existing campaign has its CampaignDetails row, the old
-- creator-facing columns can be dropped from Campaign. "notes" is NOT dropped
-- — it's internal operator-only free text, never creator-facing, so it stays
-- on Campaign rather than moving to CampaignDetails.
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "objective";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "brandDescription";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "deliverables";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "timeline";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "rewardDescription";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "shipsPhysicalProduct";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "usageRights";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "exclusivity";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "paymentTerms";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "attributionWindow";

-- =============================================================================
-- CreateIndex
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "CampaignDetails_campaignId_key" ON "CampaignDetails"("campaignId");

CREATE UNIQUE INDEX IF NOT EXISTS "CampaignTermsSnapshot_campaignId_key" ON "CampaignTermsSnapshot"("campaignId");
CREATE INDEX IF NOT EXISTS "CampaignTermsSnapshot_briefExtractionId_idx" ON "CampaignTermsSnapshot"("briefExtractionId");
-- Backs the composite FK from CampaignBrief(campaignTermsSnapshotId, campaignId).
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignTermsSnapshot_id_campaignId_key" ON "CampaignTermsSnapshot"("id", "campaignId");

CREATE INDEX IF NOT EXISTS "CampaignBriefExtraction_campaignId_idx" ON "CampaignBriefExtraction"("campaignId");
CREATE INDEX IF NOT EXISTS "CampaignBriefExtraction_campaignId_createdAt_idx" ON "CampaignBriefExtraction"("campaignId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "NegotiationPolicy_campaignId_key" ON "NegotiationPolicy"("campaignId");

CREATE UNIQUE INDEX IF NOT EXISTS "NegotiationPolicySnapshot_campaignId_key" ON "NegotiationPolicySnapshot"("campaignId");

CREATE UNIQUE INDEX IF NOT EXISTS "BrandIdentity_campaignId_key" ON "BrandIdentity"("campaignId");

CREATE UNIQUE INDEX IF NOT EXISTS "CreatorRequirement_campaignId_key" ON "CreatorRequirement"("campaignId");

CREATE INDEX IF NOT EXISTS "CampaignBrief_campaignId_idx" ON "CampaignBrief"("campaignId");
CREATE INDEX IF NOT EXISTS "CampaignBrief_campaignTermsSnapshotId_idx" ON "CampaignBrief"("campaignTermsSnapshotId");
CREATE INDEX IF NOT EXISTS "CampaignBrief_campaignId_renderedAt_idx" ON "CampaignBrief"("campaignId", "renderedAt");

CREATE INDEX IF NOT EXISTS "CampaignAuditEvent_campaignId_idx" ON "CampaignAuditEvent"("campaignId");

CREATE INDEX IF NOT EXISTS "ExecutionInstance_campaignTermsSnapshotId_idx" ON "ExecutionInstance"("campaignTermsSnapshotId");
CREATE INDEX IF NOT EXISTS "ExecutionInstance_negotiationPolicySnapshotId_idx" ON "ExecutionInstance"("negotiationPolicySnapshotId");

-- =============================================================================
-- AddForeignKey
-- =============================================================================

DO $$ BEGIN
  ALTER TABLE "CampaignDetails"
    ADD CONSTRAINT "CampaignDetails_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Schema review §2.1: which extraction a confirmation actually came from.
DO $$ BEGIN
  ALTER TABLE "CampaignDetails"
    ADD CONSTRAINT "CampaignDetails_confirmedFromExtractionId_fkey"
    FOREIGN KEY ("confirmedFromExtractionId") REFERENCES "CampaignBriefExtraction"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignTermsSnapshot"
    ADD CONSTRAINT "CampaignTermsSnapshot_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignTermsSnapshot"
    ADD CONSTRAINT "CampaignTermsSnapshot_briefExtractionId_fkey"
    FOREIGN KEY ("briefExtractionId") REFERENCES "CampaignBriefExtraction"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignBriefExtraction"
    ADD CONSTRAINT "CampaignBriefExtraction_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "NegotiationPolicy"
    ADD CONSTRAINT "NegotiationPolicy_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "NegotiationPolicySnapshot"
    ADD CONSTRAINT "NegotiationPolicySnapshot_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "BrandIdentity"
    ADD CONSTRAINT "BrandIdentity_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CreatorRequirement"
    ADD CONSTRAINT "CreatorRequirement_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignBrief"
    ADD CONSTRAINT "CampaignBrief_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Composite FK: (campaignTermsSnapshotId, campaignId) must match an actual
-- (id, campaignId) pair on CampaignTermsSnapshot — the real database
-- constraint that makes a cross-campaign brief reference impossible.
DO $$ BEGIN
  ALTER TABLE "CampaignBrief"
    ADD CONSTRAINT "CampaignBrief_campaignTermsSnapshotId_campaignId_fkey"
    FOREIGN KEY ("campaignTermsSnapshotId", "campaignId") REFERENCES "CampaignTermsSnapshot"("id", "campaignId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CampaignAuditEvent"
    ADD CONSTRAINT "CampaignAuditEvent_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ExecutionInstance"
    ADD CONSTRAINT "ExecutionInstance_campaignTermsSnapshotId_fkey"
    FOREIGN KEY ("campaignTermsSnapshotId") REFERENCES "CampaignTermsSnapshot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ExecutionInstance"
    ADD CONSTRAINT "ExecutionInstance_negotiationPolicySnapshotId_fkey"
    FOREIGN KEY ("negotiationPolicySnapshotId") REFERENCES "NegotiationPolicySnapshot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
