-- PLU-139 — DOWN migration (rollback) for migration.sql in this same folder.
--
--   psql "$DATABASE_URL" -f migration_down.sql
--
-- Lossy: renderRequestId values (or the backfill placeholders, if any were
-- ever written) are dropped with the column. approvedForBrief is dropped
-- too — nothing sets it true today, so there is nothing meaningful to lose
-- in practice. Idempotent throughout: every step uses IF EXISTS.

DROP INDEX IF EXISTS "CampaignBrief_campaignId_current_key";
DROP INDEX IF EXISTS "CampaignBrief_creatorTokenHash_key";
DROP INDEX IF EXISTS "CampaignBrief_renderRequestId_key";

ALTER TABLE "CampaignBrief" DROP COLUMN IF EXISTS "creatorTokenHash";
ALTER TABLE "CampaignBrief" DROP COLUMN IF EXISTS "errorCategory";
ALTER TABLE "CampaignBrief" DROP COLUMN IF EXISTS "renderRequestId";

ALTER TABLE "CreatorRequirement" DROP COLUMN IF EXISTS "approvedForBrief";
