-- PLU-169 (1f): the ONE canonical accepted-terms record for a creator journey.
--
-- Purely ADDITIVE. Two new enums and one new table, referencing four existing
-- tables (ExecutionInstance, CampaignTermsSnapshot, NegotiationPolicySnapshot,
-- Message). No existing column/table is touched.
--
-- Idempotent: CREATE TYPE uses DO/EXCEPTION, the table/indexes use IF NOT
-- EXISTS, foreign-key constraints use DO/EXCEPTION — same conventions as
-- 20260721160000_plu70_operator_handoff/migration.sql (DealHandoff).

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "FinalAgreementSource" AS ENUM ('AI_NEGOTIATION', 'OPERATOR_MANUAL', 'BRAND_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "FinalAgreementCommissionMode" AS ENUM ('PERCENT', 'FLAT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "FinalAgreement" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,

    "campaignTermsSnapshotId" TEXT,
    "negotiationPolicySnapshotId" TEXT,

    "finalFeeCents" INTEGER,
    "finalCommissionMode" "FinalAgreementCommissionMode",
    "finalCommissionRate" DOUBLE PRECISION,
    "finalCommissionAmountCents" INTEGER,
    "finalCommissionDurationDays" INTEGER,
    "finalCommissionConditions" TEXT,

    "finalGiftProductDescription" TEXT,
    "finalGiftDisposition" "GiftDisposition",
    "finalFulfillmentTerms" TEXT,

    "finalDeliverables" JSONB,
    "finalTimeline" TEXT,
    "finalPostingDate" TIMESTAMP(3),

    "finalUsageRights" TEXT,
    "finalExclusivity" TEXT,
    "finalAttributionWindow" TEXT,
    "finalPaymentTerms" TEXT,

    "finalScriptSubmissionRequired" BOOLEAN NOT NULL DEFAULT false,

    "approvedDeviations" JSONB,

    "acceptanceSource" "FinalAgreementSource" NOT NULL,
    "sourceMessageId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinalAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "FinalAgreement_instanceId_key" ON "FinalAgreement"("instanceId");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "FinalAgreement" ADD CONSTRAINT "FinalAgreement_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "FinalAgreement" ADD CONSTRAINT "FinalAgreement_campaignTermsSnapshotId_fkey"
    FOREIGN KEY ("campaignTermsSnapshotId") REFERENCES "CampaignTermsSnapshot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "FinalAgreement" ADD CONSTRAINT "FinalAgreement_negotiationPolicySnapshotId_fkey"
    FOREIGN KEY ("negotiationPolicySnapshotId") REFERENCES "NegotiationPolicySnapshot"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "FinalAgreement" ADD CONSTRAINT "FinalAgreement_sourceMessageId_fkey"
    FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
