-- PLU-136 (Issue 1b): Campaign.campaignType classification + campaign
-- duplication support.
--
-- Split into its OWN migration rather than folded into
-- 20260807120000_plu135_campaign_schema_snapshot: that earlier migration was
-- already applied for real against the live database (confirmed by
-- introspection — Campaign already lacks its pre-1a columns and
-- CampaignDetails/CampaignTermsSnapshot/NegotiationPolicy already exist —
-- even though `_migrations_applied` has no record of it, because it was run
-- directly rather than through apply-all-migrations.ts). Editing an
-- already-applied migration file in place would never reach the database;
-- this file is the correct, separate delta.
--
-- Design note (2026-08-10, corrected from an earlier draft of this same
-- change): this migration originally also added a
-- `CampaignDetails.compensationType: 'FIXED' | 'NEGOTIATED'` column meant to
-- gate whether NegotiationPolicy is required at launch. That was wrong — a
-- fixed-fee campaign still negotiates (the amount itself, plus deliverables/
-- timeline/usage rights/exclusivity); every campaign type goes through the
-- negotiation engine. So this migration adds ONLY a classification field
-- (`Campaign.campaignType`) and the duplication support column — no
-- negotiation on/off switch exists anywhere in this schema.
--
-- Idempotent: enum uses DO/EXCEPTION, columns/index use IF NOT EXISTS, FK
-- uses DO/EXCEPTION — safe to re-run.

-- =============================================================================
-- CreateEnum (idempotent)
-- =============================================================================

-- Classification of how the creator is compensated —
-- display/analytics/template-selection only. Does NOT gate whether
-- NegotiationPolicy is required at launch; every campaign type negotiates.
-- See the CampaignType doc comment in schema.prisma.
DO $$ BEGIN
  CREATE TYPE "CampaignType" AS ENUM ('GIFT', 'PAID', 'AFFILIATE', 'HYBRID');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- AlterTable
-- =============================================================================

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "campaignType" "CampaignType" NOT NULL DEFAULT 'PAID';

-- Self-FK for campaign duplication — nullable, SET NULL on delete of the
-- source (a DRAFT-only-deletable source being hard-deleted must never block
-- or cascade into its duplicates).
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "duplicatedFromCampaignId" TEXT;

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
