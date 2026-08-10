-- PLU-135 (Issue 1a) — DOWN migration (rollback) for migration.sql in this
-- same folder.
--
-- Prisma's migration system is forward-only and does not track or run "down"
-- migrations automatically (there is no `prisma migrate down`). This file is
-- the hand-maintained rollback script for this specific migration, run
-- manually if this change needs to be reverted:
--
--   psql "$DATABASE_URL" -f migration_down.sql
--
-- IMPORTANT — this is a LOSSY rollback if any of the new capability has
-- actually been used:
--   * Any CampaignTermsSnapshot, NegotiationPolicySnapshot (a campaign that
--     has actually launched under the new model), CampaignBriefExtraction,
--     NegotiationPolicy row with data, BrandIdentity, CreatorRequirement,
--     CampaignBrief, or CampaignAuditEvent row is DELETED by this script
--     along with its table. There is no "old" representation for any of
--     that — it did not exist before this migration — so it cannot be
--     preserved by rolling back.
--   * Only CampaignDetails' content is restorable, because it started life as
--     a backfill FROM the old Campaign columns — this script copies it back.
--     If the draft was edited after the forward migration, this rollback
--     takes the CURRENT (possibly edited) CampaignDetails values as the
--     source of truth being restored, not whatever the original
--     pre-migration Campaign row happened to contain.
--   * Campaign.status is simply dropped — there is no prior representation
--     of "draft vs. active" to restore, because that distinction did not
--     exist before this migration.
--
-- If this is being rolled back after real usage, back up the database first;
-- this script does not create a backup for you.
--
-- Idempotent: every step uses IF EXISTS so a partial/prior rollback attempt
-- can safely re-run to completion.

-- =============================================================================
-- Drop foreign keys first (dependency order: children before what they
-- reference).
-- =============================================================================

ALTER TABLE "ExecutionInstance" DROP CONSTRAINT IF EXISTS "ExecutionInstance_negotiationPolicySnapshotId_fkey";
ALTER TABLE "ExecutionInstance" DROP CONSTRAINT IF EXISTS "ExecutionInstance_campaignTermsSnapshotId_fkey";
ALTER TABLE "CampaignAuditEvent" DROP CONSTRAINT IF EXISTS "CampaignAuditEvent_campaignId_fkey";
ALTER TABLE "CampaignBrief" DROP CONSTRAINT IF EXISTS "CampaignBrief_campaignTermsSnapshotId_campaignId_fkey";
ALTER TABLE "CampaignBrief" DROP CONSTRAINT IF EXISTS "CampaignBrief_campaignId_fkey";
ALTER TABLE "CreatorRequirement" DROP CONSTRAINT IF EXISTS "CreatorRequirement_campaignId_fkey";
ALTER TABLE "BrandIdentity" DROP CONSTRAINT IF EXISTS "BrandIdentity_campaignId_fkey";
ALTER TABLE "NegotiationPolicySnapshot" DROP CONSTRAINT IF EXISTS "NegotiationPolicySnapshot_campaignId_fkey";
ALTER TABLE "NegotiationPolicy" DROP CONSTRAINT IF EXISTS "NegotiationPolicy_campaignId_fkey";
ALTER TABLE "CampaignBriefExtraction" DROP CONSTRAINT IF EXISTS "CampaignBriefExtraction_campaignId_fkey";
ALTER TABLE "CampaignTermsSnapshot" DROP CONSTRAINT IF EXISTS "CampaignTermsSnapshot_briefExtractionId_fkey";
ALTER TABLE "CampaignTermsSnapshot" DROP CONSTRAINT IF EXISTS "CampaignTermsSnapshot_campaignId_fkey";
ALTER TABLE "CampaignDetails" DROP CONSTRAINT IF EXISTS "CampaignDetails_confirmedFromExtractionId_fkey";
ALTER TABLE "CampaignDetails" DROP CONSTRAINT IF EXISTS "CampaignDetails_campaignId_fkey";

-- =============================================================================
-- Restore Campaign's old creator-facing columns, then copy CampaignDetails'
-- current values back into them (see the lossiness note above).
-- =============================================================================

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "objective" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "brandDescription" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "deliverables" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "timeline" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "rewardDescription" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "shipsPhysicalProduct" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "usageRights" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "exclusivity" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "attributionWindow" TEXT;

UPDATE "Campaign" c SET
    "objective" = d."objective",
    "brandDescription" = d."brandDescription",
    "deliverables" = d."deliverables",
    "timeline" = d."timeline",
    "rewardDescription" = d."productOrOffer",
    "shipsPhysicalProduct" = d."shipsPhysicalProduct",
    "usageRights" = d."usageRights",
    "exclusivity" = d."exclusivity",
    "paymentTerms" = d."publicPaymentTerms",
    "attributionWindow" = d."attributionWindow"
FROM "CampaignDetails" d
WHERE d."campaignId" = c."id";

ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "archivedAt";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "status";

-- =============================================================================
-- Drop the new columns on ExecutionInstance.
-- =============================================================================

ALTER TABLE "ExecutionInstance" DROP COLUMN IF EXISTS "negotiationPolicySnapshotId";
ALTER TABLE "ExecutionInstance" DROP COLUMN IF EXISTS "campaignTermsSnapshotId";

-- =============================================================================
-- Drop the new tables. Order: whatever references another new table first.
-- =============================================================================

DROP TABLE IF EXISTS "CampaignAuditEvent";
DROP TABLE IF EXISTS "CampaignBrief";
DROP TABLE IF EXISTS "CreatorRequirement";
DROP TABLE IF EXISTS "BrandIdentity";
DROP TABLE IF EXISTS "NegotiationPolicySnapshot";
DROP TABLE IF EXISTS "NegotiationPolicy";
DROP TABLE IF EXISTS "CampaignTermsSnapshot";
DROP TABLE IF EXISTS "CampaignBriefExtraction";
DROP TABLE IF EXISTS "CampaignDetails";

-- =============================================================================
-- Drop the new enums.
-- =============================================================================

DROP TYPE IF EXISTS "CampaignStatus";
DROP TYPE IF EXISTS "CampaignAuditEventType";
DROP TYPE IF EXISTS "BrandIdentityExtractionSource";
DROP TYPE IF EXISTS "CampaignBriefRenderStatus";
