-- PLU-139: sectioned campaign Draft intake — the structured PUBLIC-terms contract.
--
-- Purely ADDITIVE. Three new enums (CampaignStatus / CompensationStructure /
-- PriceStrategy), one new column on Campaign (status), and three 1:1 tables
-- (CampaignDetails / BrandIdentity / CreatorRequirement). Nothing existing is
-- altered besides the additive Campaign.status column, so every in-flight
-- campaign/execution keeps working.
--
-- Scope note: NO private-policy field, NO fieldProvenance, NO CampaignBriefExtraction
-- here — those are PR B. This migration is only the public-Draft contract + lifecycle.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Constraint
-- names follow the Prisma convention (_pkey / _fkey / _key). Idempotent: enums use
-- DO/EXCEPTION, column/tables/indexes use IF NOT EXISTS, so the .mjs Neon runner is
-- safe to re-run. Both new-enum members are created WHOLE by CREATE TYPE (no ALTER
-- TYPE ... ADD VALUE), so the Campaign.status default can cast a literal.

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSING', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "CompensationStructure" AS ENUM ('PAID', 'GIFTING', 'AFFILIATE', 'HYBRID');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "PriceStrategy" AS ENUM ('REQUEST_RATE_CARD', 'PROPOSE_STARTING_AMOUNT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable — Campaign.status. New rows default DRAFT; the backfill below marks
-- every EXISTING row ACTIVE (they are already live — leaving them DRAFT would
-- wrongly unlock material edits). Idempotent via IF NOT EXISTS.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT';

-- Backfill — all pre-migration rows are running campaigns → ACTIVE. Guarded on
-- createdAt < now() so a re-run cannot demote a genuinely-new DRAFT created after
-- this migration first ran.
UPDATE "Campaign" SET "status" = 'ACTIVE' WHERE "status" = 'DRAFT' AND "createdAt" < now();

-- CreateTable — structured PUBLIC creator-facing terms (1:1 with Campaign).
CREATE TABLE IF NOT EXISTS "CampaignDetails" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "compensationStructure" "CompensationStructure" NOT NULL,
    "priceStrategy" "PriceStrategy",
    "proposedFeeCents" INTEGER,
    "feeCurrency" TEXT,
    "additiveGifting" BOOLEAN NOT NULL DEFAULT false,
    "giftDescription" TEXT,
    "giftIsCompensation" BOOLEAN,
    "giftIsPhysical" BOOLEAN,
    "giftAccessMethod" TEXT,
    "commissionRate" INTEGER,
    "commissionMode" TEXT,
    "commissionDurationKind" TEXT,
    "commissionDurationValue" INTEGER,
    "attributionWindowDays" INTEGER,
    "publicPaymentTerms" TEXT,
    "objective" TEXT,
    "summary" TEXT,
    "keyMessages" JSONB,
    "prohibitedClaims" JSONB,
    "contentRequirements" JSONB,
    "usageRights" TEXT,
    "usageRightsDurationDays" INTEGER,
    "exclusivity" TEXT,
    "exclusivityDurationDays" INTEGER,
    "adAuthorizationDays" INTEGER,
    "postRetentionDays" INTEGER,
    "contentRepurposeDays" INTEGER,
    "platforms" JSONB,
    "deliverables" JSONB,
    "postDeadline" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable — brand identity/branding (1:1 with Campaign).
CREATE TABLE IF NOT EXISTS "BrandIdentity" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "brandName" TEXT,
    "brandDescription" TEXT,
    "websiteUrl" TEXT,
    "productUrl" TEXT,
    "productDescription" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "typography" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable — informational creator-fit notes (1:1 with Campaign).
CREATE TABLE IF NOT EXISTS "CreatorRequirement" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "platforms" JSONB,
    "niche" TEXT,
    "geographies" JSONB,
    "languages" JSONB,
    "audience" TEXT,
    "minFollowers" INTEGER,
    "maxFollowers" INTEGER,
    "contentStyle" TEXT,
    "safetyNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the 1:1 unique on campaignId for each detail table.
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignDetails_campaignId_key" ON "CampaignDetails" ("campaignId");
CREATE UNIQUE INDEX IF NOT EXISTS "BrandIdentity_campaignId_key" ON "BrandIdentity" ("campaignId");
CREATE UNIQUE INDEX IF NOT EXISTS "CreatorRequirement_campaignId_key" ON "CreatorRequirement" ("campaignId");

-- AddForeignKey — each detail table → Campaign (cascade so DELETE campaign clears them).
ALTER TABLE "CampaignDetails"
    ADD CONSTRAINT "CampaignDetails_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BrandIdentity"
    ADD CONSTRAINT "BrandIdentity_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CreatorRequirement"
    ADD CONSTRAINT "CreatorRequirement_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
