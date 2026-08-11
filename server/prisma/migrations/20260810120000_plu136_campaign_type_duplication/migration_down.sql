-- PLU-136 — DOWN migration (rollback) for migration.sql in this same folder.
--
--   psql "$DATABASE_URL" -f migration_down.sql
--
-- Lossy: every column this migration adds is dropped with its data,
-- including anything an operator entered for campaignType/gifting/public or
-- private commission terms/compensationReviewStatus. There is no "old"
-- representation to restore for any of it — none of it existed before this
-- migration except fixedCompensationCents, which this rollback renames back.
-- Idempotent throughout: every step uses IF EXISTS.

-- =============================================================================
-- Drop foreign key first.
-- =============================================================================

ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_duplicatedFromCampaignId_fkey";

-- =============================================================================
-- NegotiationPolicySnapshot: drop the commission/gift-flexibility columns,
-- restore the old bare commissionRate scalar (empty — no historical values
-- to carry back, the triad this replaces has no single-scalar equivalent).
-- =============================================================================

ALTER TABLE "NegotiationPolicySnapshot" DROP COLUMN IF EXISTS "giftValueFlexibilityCents";
ALTER TABLE "NegotiationPolicySnapshot" DROP COLUMN IF EXISTS "giftSubstitutionAllowed";
ALTER TABLE "NegotiationPolicySnapshot" DROP COLUMN IF EXISTS "preferredCommissionRate";
ALTER TABLE "NegotiationPolicySnapshot" DROP COLUMN IF EXISTS "commissionCeilingRate";
ALTER TABLE "NegotiationPolicySnapshot" DROP COLUMN IF EXISTS "commissionFloorRate";
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionRate" DOUBLE PRECISION;

-- =============================================================================
-- NegotiationPolicy: same restore.
-- =============================================================================

ALTER TABLE "NegotiationPolicy" DROP COLUMN IF EXISTS "giftValueFlexibilityCents";
ALTER TABLE "NegotiationPolicy" DROP COLUMN IF EXISTS "giftSubstitutionAllowed";
ALTER TABLE "NegotiationPolicy" DROP COLUMN IF EXISTS "preferredCommissionRate";
ALTER TABLE "NegotiationPolicy" DROP COLUMN IF EXISTS "commissionCeilingRate";
ALTER TABLE "NegotiationPolicy" DROP COLUMN IF EXISTS "commissionFloorRate";
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionRate" DOUBLE PRECISION;

-- =============================================================================
-- CampaignDetails: drop everything this migration added, rename
-- publicStartingFeeCents back to fixedCompensationCents.
-- =============================================================================

ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "commissionConditions";
ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "commissionDurationDays";
ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "publicCommissionRate";
ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "priceStrategy";
ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "compensationReviewStatus";
ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "giftDisposition";
ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "includesGifting";
ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "campaignType";

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CampaignDetails' AND column_name = 'publicStartingFeeCents'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CampaignDetails' AND column_name = 'fixedCompensationCents'
  ) THEN
    ALTER TABLE "CampaignDetails" RENAME COLUMN "publicStartingFeeCents" TO "fixedCompensationCents";
  END IF;
END $$;

-- =============================================================================
-- Campaign: drop duplication support.
-- =============================================================================

ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "duplicatedFromCampaignId";

-- =============================================================================
-- Drop the new enums.
-- =============================================================================

DROP TYPE IF EXISTS "CompensationReviewStatus";
DROP TYPE IF EXISTS "PriceStrategy";
DROP TYPE IF EXISTS "GiftDisposition";
DROP TYPE IF EXISTS "CampaignType";
