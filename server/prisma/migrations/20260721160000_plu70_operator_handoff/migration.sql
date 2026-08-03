-- PLU-70: operator handoff after acceptance.
--
-- Purely ADDITIVE. Two new InstanceState members, one new EventType trio, two
-- new enums, two new columns (both NOT NULL DEFAULT 'local_payment', so every
-- existing Campaign and every in-flight ExecutionInstance is backfilled to the
-- current behavior), and one new table.
--
-- Note on transactionality: Postgres forbids USING a newly added enum value in
-- the same transaction that adds it. This migration only ADDS members — it never
-- inserts or compares one — so it is safe inside Prisma's single-transaction
-- migration. The new DealHandoffStatus/PostAcceptanceMode types are created
-- whole by CREATE TYPE, which carries no such restriction.
--
-- Idempotent: ALTER TYPE uses IF NOT EXISTS, CREATE TYPE uses DO/EXCEPTION,
-- tables/indexes/columns use IF NOT EXISTS, constraints use DO/EXCEPTION.

-- AlterEnum (idempotent)
ALTER TYPE "InstanceState" ADD VALUE IF NOT EXISTS 'NEEDS_DEAL_FINALIZATION';
ALTER TYPE "InstanceState" ADD VALUE IF NOT EXISTS 'HANDOFF_COMPLETE';

-- AlterEnum (idempotent)
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'DEAL_HANDOFF_REQUESTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'DEAL_HANDOFF_REPLY';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'DEAL_HANDOFF_COMPLETED';

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "PostAcceptanceMode" AS ENUM ('local_payment', 'operator_handoff');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "DealHandoffStatus" AS ENUM ('AWAITING_FINALIZATION', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable (idempotent)
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "postAcceptanceMode" "PostAcceptanceMode" NOT NULL DEFAULT 'local_payment';

-- AlterTable (idempotent)
ALTER TABLE "ExecutionInstance" ADD COLUMN IF NOT EXISTS "postAcceptanceMode" "PostAcceptanceMode" NOT NULL DEFAULT 'local_payment';

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "DealHandoff" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "creatorName" TEXT NOT NULL,
    "creatorEmail" TEXT NOT NULL,
    "campaignName" TEXT,
    "fixedFee" DOUBLE PRECISION,
    "commissionRate" DOUBLE PRECISION,
    "deliverables" TEXT,
    "timeline" TEXT,
    "paymentTerms" TEXT,
    "acceptanceMessage" TEXT,
    "threadId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "status" "DealHandoffStatus" NOT NULL DEFAULT 'AWAITING_FINALIZATION',
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "DealHandoff_instanceId_key" ON "DealHandoff"("instanceId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "DealHandoff_status_idx" ON "DealHandoff"("status");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "DealHandoff" ADD CONSTRAINT "DealHandoff_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
