-- PLU-136: campaign duplication support + the compensation data contract
-- (structure classification, public/private fee & commission split, product
-- gifting, compensation review gate).
--
-- Split into its OWN migration rather than folded into
-- 20260807120000_plu135_campaign_schema_snapshot: that earlier migration was
-- already applied for real against the live database (Campaign already
-- lacks its pre-1a columns, CampaignDetails/CampaignTermsSnapshot/
-- NegotiationPolicy already exist), even though `_migrations_applied` has no
-- record of it (run directly via psql). Editing that already-applied file
-- would never reach the database; this file is the correct, separate delta.
--
-- Revision history of THIS file (safe to rewrite in place — confirmed, by
-- introspection, never applied for real against any database):
--   1. Originally added only Campaign.campaignType + duplicatedFromCampaignId.
--   2. Revised same day: campaignType's gating idea (a `compensationType`
--      FIXED/NEGOTIATED switch) was dropped before it ever reached this
--      file — every campaign type negotiates, no on/off switch exists.
--   3. THIS revision (compensation data contract): campaignType moves from
--      Campaign to CampaignDetails entirely (it must be inside the frozen
--      CampaignTermsSnapshot — a mutable Campaign column alone is not
--      sufficient), gains a 4th value (GIFT_ONLY, renamed from GIFT),
--      product gifting becomes an orthogonal flag (composes with
--      PAID/AFFILIATE/HYBRID rather than being a 5th enum value),
--      CampaignDetails.fixedCompensationCents (created for real by the 1a
--      migration) is renamed to publicStartingFeeCents and gains public
--      commission fields, and NegotiationPolicy/NegotiationPolicySnapshot's
--      single ambiguous `commissionRate` scalar (also created for real by
--      1a) is replaced with an explicit floor/ceiling/preferred triad
--      mirroring the existing fee fields, plus gift-flexibility fields.
--
-- Idempotent throughout: enums use DO/EXCEPTION, columns use IF NOT EXISTS /
-- IF EXISTS, the rename is guarded by an information_schema check (Postgres
-- has no `RENAME COLUMN IF EXISTS`), FK uses DO/EXCEPTION — safe to re-run.

-- =============================================================================
-- CreateEnum (idempotent)
-- =============================================================================

-- The four canonical compensation structures. Never created for real under
-- the old GIFT/PAID/AFFILIATE/HYBRID shape (see revision history above), so
-- this is a direct CREATE with the final values — no rename needed.
DO $$ BEGIN
  CREATE TYPE "CampaignType" AS ENUM ('PAID', 'AFFILIATE', 'HYBRID', 'GIFT_ONLY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Whether a supplied/shipped product is itself part of the compensation
-- offer, and if so what happens to it. See GiftDisposition's doc comment in
-- schema.prisma for the distinction from shipsPhysicalProduct.
DO $$ BEGIN
  CREATE TYPE "GiftDisposition" AS ENUM ('KEEP', 'LOAN', 'RETURN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- For a PAID/HYBRID campaign: request the creator's rate card, or propose a
-- starting fee up front.
DO $$ BEGIN
  CREATE TYPE "PriceStrategy" AS ENUM ('REQUEST_RATE_CARD', 'PROPOSE_STARTING_FEE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Every campaign predating this migration has campaignType = PAID only
-- because that's the column default, never because anyone verified it.
-- NEEDS_REVIEW is the default for the backfill below; launchCampaign()
-- refuses to launch a NEEDS_REVIEW campaign until an operator confirms it.
DO $$ BEGIN
  CREATE TYPE "CompensationReviewStatus" AS ENUM ('NEEDS_REVIEW', 'CONFIRMED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- AlterTable — Campaign (duplication support only; campaignType never lands
-- here — see revision history above)
-- =============================================================================

-- Self-FK for campaign duplication — nullable, SET NULL on delete of the
-- source.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "duplicatedFromCampaignId" TEXT;

-- =============================================================================
-- AlterTable — CampaignDetails
-- =============================================================================

-- Rename fixedCompensationCents -> publicStartingFeeCents (created for real
-- by the 1a migration; this file has never touched it before now). Guarded:
-- Postgres has no RENAME COLUMN IF EXISTS, and this must stay safe to re-run
-- and safe against a database that already has the new name.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CampaignDetails' AND column_name = 'fixedCompensationCents'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'CampaignDetails' AND column_name = 'publicStartingFeeCents'
  ) THEN
    ALTER TABLE "CampaignDetails" RENAME COLUMN "fixedCompensationCents" TO "publicStartingFeeCents";
  END IF;
END $$;

-- campaignType moved here from Campaign — must be inside the frozen
-- CampaignTermsSnapshot (a mutable Campaign column alone is not sufficient).
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "campaignType" "CampaignType" NOT NULL DEFAULT 'PAID';
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "includesGifting" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "giftDisposition" "GiftDisposition";
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "compensationReviewStatus" "CompensationReviewStatus" NOT NULL DEFAULT 'NEEDS_REVIEW';
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "priceStrategy" "PriceStrategy";
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "publicCommissionRate" DOUBLE PRECISION;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "commissionDurationDays" INTEGER;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "commissionConditions" TEXT;

-- =============================================================================
-- AlterTable — NegotiationPolicy: replace the ambiguous single commissionRate
-- scalar (created for real by 1a) with an explicit floor/ceiling/preferred
-- triad mirroring the fee fields, plus gift-flexibility fields.
-- =============================================================================

ALTER TABLE "NegotiationPolicy" DROP COLUMN IF EXISTS "commissionRate";
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionFloorRate" DOUBLE PRECISION;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionCeilingRate" DOUBLE PRECISION;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "preferredCommissionRate" DOUBLE PRECISION;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "giftSubstitutionAllowed" BOOLEAN;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "giftValueFlexibilityCents" INTEGER;

-- =============================================================================
-- AlterTable — NegotiationPolicySnapshot: mirrors NegotiationPolicy exactly.
-- =============================================================================

ALTER TABLE "NegotiationPolicySnapshot" DROP COLUMN IF EXISTS "commissionRate";
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionFloorRate" DOUBLE PRECISION;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionCeilingRate" DOUBLE PRECISION;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "preferredCommissionRate" DOUBLE PRECISION;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "giftSubstitutionAllowed" BOOLEAN;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "giftValueFlexibilityCents" INTEGER;

-- =============================================================================
-- CreateIndex
-- =============================================================================

CREATE INDEX IF NOT EXISTS "Campaign_duplicatedFromCampaignId_idx" ON "Campaign"("duplicatedFromCampaignId");

-- =============================================================================
-- AddForeignKey
-- =============================================================================

DO $$ BEGIN
  ALTER TABLE "Campaign"
    ADD CONSTRAINT "Campaign_duplicatedFromCampaignId_fkey"
    FOREIGN KEY ("duplicatedFromCampaignId") REFERENCES "Campaign"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
