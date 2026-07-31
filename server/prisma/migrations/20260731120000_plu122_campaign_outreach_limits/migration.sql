-- PLU-122: campaign-level daily initial-outreach cap plus campaign pacing.
--
-- Existing campaigns keep NULL settings, which preserves the legacy behavior:
-- unlimited/immediate initial outreach and the service-wide negotiation delay.
-- New-campaign defaults are applied by the API, not by DB defaults, so this
-- migration never silently changes a running campaign.

-- AlterEnum
ALTER TYPE "InstanceState" ADD VALUE 'OUTREACH_QUEUED';

-- AlterTable
ALTER TABLE "Campaign"
  ADD COLUMN "dailyInitialOutreachLimit" INTEGER,
  ADD COLUMN "outreachPacingMinMinutes" INTEGER,
  ADD COLUMN "outreachPacingMaxMinutes" INTEGER,
  ADD COLUMN "negotiationReplyPacingMinMinutes" INTEGER,
  ADD COLUMN "negotiationReplyPacingMaxMinutes" INTEGER;

-- Defense in depth for non-HTTP writes. NULL remains the intentional legacy
-- policy; configured values must always form complete, sensible windows.
ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_dailyInitialOutreachLimit_check"
    CHECK ("dailyInitialOutreachLimit" IS NULL OR
      "dailyInitialOutreachLimit" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "Campaign_outreachPacing_check"
    CHECK (
      ("outreachPacingMinMinutes" IS NULL AND "outreachPacingMaxMinutes" IS NULL) OR
      ("outreachPacingMinMinutes" BETWEEN 1 AND 60 AND
       "outreachPacingMaxMinutes" BETWEEN 1 AND 60 AND
       "outreachPacingMinMinutes" <= "outreachPacingMaxMinutes")
    ),
  ADD CONSTRAINT "Campaign_negotiationReplyPacing_check"
    CHECK (
      ("negotiationReplyPacingMinMinutes" IS NULL AND
       "negotiationReplyPacingMaxMinutes" IS NULL) OR
      ("negotiationReplyPacingMinMinutes" BETWEEN 1 AND 60 AND
       "negotiationReplyPacingMaxMinutes" BETWEEN 1 AND 60 AND
       "negotiationReplyPacingMinMinutes" <= "negotiationReplyPacingMaxMinutes")
    );

-- AlterTable
ALTER TABLE "Message"
  ADD COLUMN "scheduledFor" TIMESTAMP(3),
  ADD COLUMN "initialOutreachQuotaDay" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CampaignOutreachDay" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "dayStart" TIMESTAMP(3) NOT NULL,
    "startedCount" INTEGER NOT NULL DEFAULT 0,
    "nextEligibleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignOutreachDay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignOutreachDay_campaignId_dayStart_key"
  ON "CampaignOutreachDay"("campaignId", "dayStart");

-- CreateIndex
CREATE INDEX "Message_scheduledFor_idx" ON "Message"("scheduledFor");

-- AddForeignKey
ALTER TABLE "CampaignOutreachDay"
  ADD CONSTRAINT "CampaignOutreachDay_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
