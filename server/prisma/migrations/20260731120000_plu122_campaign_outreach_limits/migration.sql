-- PLU-122: campaign-level daily initial-outreach cap plus campaign pacing.
--
-- Existing campaigns keep NULL settings, which preserves the legacy behavior:
-- unlimited/immediate initial outreach and the service-wide negotiation delay.
-- New-campaign defaults are applied by the API, not by DB defaults, so this
-- migration never silently changes a running campaign.
--
-- Idempotent: ALTER TYPE uses IF NOT EXISTS, ADD COLUMN uses IF NOT EXISTS,
-- CREATE TABLE/INDEX use IF NOT EXISTS, ADD CONSTRAINT uses DO/EXCEPTION.

-- AlterEnum (idempotent)
ALTER TYPE "InstanceState" ADD VALUE IF NOT EXISTS 'OUTREACH_QUEUED';

-- AlterTable (idempotent)
ALTER TABLE "Campaign"
  ADD COLUMN IF NOT EXISTS "dailyInitialOutreachLimit" INTEGER,
  ADD COLUMN IF NOT EXISTS "outreachPacingMinMinutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "outreachPacingMaxMinutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "negotiationReplyPacingMinMinutes" INTEGER,
  ADD COLUMN IF NOT EXISTS "negotiationReplyPacingMaxMinutes" INTEGER;

-- ADD CONSTRAINT (idempotent)
DO $$ BEGIN
  ALTER TABLE "Campaign"
    ADD CONSTRAINT "Campaign_dailyInitialOutreachLimit_check"
      CHECK ("dailyInitialOutreachLimit" IS NULL OR
        "dailyInitialOutreachLimit" BETWEEN 1 AND 1000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Campaign"
    ADD CONSTRAINT "Campaign_outreachPacing_check"
      CHECK (
        ("outreachPacingMinMinutes" IS NULL AND "outreachPacingMaxMinutes" IS NULL) OR
        ("outreachPacingMinMinutes" BETWEEN 1 AND 60 AND
         "outreachPacingMaxMinutes" BETWEEN 1 AND 60 AND
         "outreachPacingMinMinutes" <= "outreachPacingMaxMinutes")
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Campaign"
    ADD CONSTRAINT "Campaign_negotiationReplyPacing_check"
      CHECK (
        ("negotiationReplyPacingMinMinutes" IS NULL AND
         "negotiationReplyPacingMaxMinutes" IS NULL) OR
        ("negotiationReplyPacingMinMinutes" BETWEEN 1 AND 60 AND
         "negotiationReplyPacingMaxMinutes" BETWEEN 1 AND 60 AND
         "negotiationReplyPacingMinMinutes" <= "negotiationReplyPacingMaxMinutes")
      );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable (idempotent)
ALTER TABLE "Message"
  ADD COLUMN IF NOT EXISTS "scheduledFor" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "initialOutreachQuotaDay" TIMESTAMP(3);

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "CampaignOutreachDay" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "dayStart" TIMESTAMP(3) NOT NULL,
    "startedCount" INTEGER NOT NULL DEFAULT 0,
    "nextEligibleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignOutreachDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignOutreachDay_campaignId_dayStart_key"
  ON "CampaignOutreachDay"("campaignId", "dayStart");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "Message_scheduledFor_idx" ON "Message"("scheduledFor");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "CampaignOutreachDay"
    ADD CONSTRAINT "CampaignOutreachDay_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
