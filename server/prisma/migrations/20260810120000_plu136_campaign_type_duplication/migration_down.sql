-- PLU-136 (Issue 1b) — DOWN migration (rollback) for migration.sql in this
-- same folder.
--
--   psql "$DATABASE_URL" -f migration_down.sql
--
-- Lossy only in the sense that campaignType/duplicatedFromCampaignId values
-- are discarded — there is no "old" representation to restore, since neither
-- existed before this migration. Idempotent: every step uses IF EXISTS.

ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_duplicatedFromCampaignId_fkey";

ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "duplicatedFromCampaignId";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "campaignType";

DROP TYPE IF EXISTS "CampaignType";
