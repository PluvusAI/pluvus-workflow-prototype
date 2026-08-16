-- PLU-139: schema changes needed by Campaign Brief Rendering (§1a of
-- docs/plu-139-campaign-brief-rendering-plan.md). Four pieces:
--   1. CreatorRequirement.approvedForBrief — stub flag, §0.
--   2. CampaignBrief.renderRequestId — client-supplied idempotency key, §6a.
--   3. A partial unique index on CampaignBrief(campaignId) WHERE
--      status='READY' AND supersededAt IS NULL — the concurrency backstop,
--      §6.
--   4. CampaignBrief.errorCategory — added while implementing §6/§8's Phase
--      2 finalize/fail path: §8/§9 require a FAILED row to carry WHY
--      (DATA_INCOMPLETE / RENDER_FAILED / STALE), and no column existed for
--      it. Caught before this migration was ever applied for real, so
--      folded in here rather than filed as a second migration.
--   5. CampaignBrief.creatorTokenHash — §7's creator-facing magic-link
--      retrieval, hashed-token posture mirroring PaymentInfo.token (BUG-S1):
--      only the SHA-256 hash is ever persisted.
--
-- Both CampaignBrief and CreatorRequirement have zero rows in the live
-- database as of this migration (no renderer exists yet to write either
-- table), confirmed by direct query before writing this file — so
-- renderRequestId can be added NOT NULL directly, no backfill needed and no
-- "add nullable, backfill, then set NOT NULL" split required.
--
-- Idempotent throughout: columns use IF NOT EXISTS, indexes use IF NOT
-- EXISTS — safe to re-run.

-- =============================================================================
-- AlterTable — CreatorRequirement
-- =============================================================================

ALTER TABLE "CreatorRequirement" ADD COLUMN IF NOT EXISTS "approvedForBrief" BOOLEAN NOT NULL DEFAULT false;

-- =============================================================================
-- AlterTable — CampaignBrief
-- =============================================================================

ALTER TABLE "CampaignBrief" ADD COLUMN IF NOT EXISTS "renderRequestId" TEXT;

-- Backfill is a no-op today (table is empty) but this keeps the migration
-- correct even if run against a database where that stops being true before
-- the NOT NULL is applied below — every existing row gets a distinct
-- placeholder rather than colliding on a shared default.
UPDATE "CampaignBrief" SET "renderRequestId" = 'backfill-' || "id" WHERE "renderRequestId" IS NULL;

ALTER TABLE "CampaignBrief" ALTER COLUMN "renderRequestId" SET NOT NULL;

ALTER TABLE "CampaignBrief" ADD COLUMN IF NOT EXISTS "errorCategory" TEXT;
ALTER TABLE "CampaignBrief" ADD COLUMN IF NOT EXISTS "creatorTokenHash" TEXT;

-- =============================================================================
-- CreateIndex
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "CampaignBrief_renderRequestId_key" ON "CampaignBrief"("renderRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignBrief_creatorTokenHash_key" ON "CampaignBrief"("creatorTokenHash");

-- The concurrency backstop from §6: at most one CURRENT row per campaign.
-- Partial — SUPERSEDED/FAILED/older READY rows are explicitly excluded so
-- they can accumulate as history without tripping the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignBrief_campaignId_current_key"
  ON "CampaignBrief"("campaignId")
  WHERE "status" = 'READY' AND "supersededAt" IS NULL;
