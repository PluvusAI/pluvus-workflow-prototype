-- Brand-approval gate: hold a creator the AI closed for the brand's Approve/Reject
-- (via magic link) before the content brief + payout link go out.
--
-- Purely ADDITIVE. One new InstanceState member, one new EventType trio, one new
-- enum (BrandApprovalStatus), and one new table (BrandApproval). No column added
-- to any existing table and no data backfill — the gate is opt-in behind the
-- BRAND_APPROVAL_GATE_ENABLED flag and only affects executions that ACCEPT while
-- it is on, so every in-flight and historical run is untouched.
--
-- Note on transactionality: Postgres forbids USING a newly added enum value in the
-- same transaction that adds it. This migration only ADDS members — it never
-- inserts or compares one — so it is safe inside Prisma's single-transaction
-- migration. The new BrandApprovalStatus type is created whole by CREATE TYPE,
-- which carries no such restriction.
--
-- Idempotent: ALTER TYPE uses IF NOT EXISTS, CREATE TYPE uses DO/EXCEPTION,
-- table/indexes use IF NOT EXISTS, constraints use DO/EXCEPTION.

-- AlterEnum (idempotent)
ALTER TYPE "InstanceState" ADD VALUE IF NOT EXISTS 'AWAITING_BRAND_APPROVAL';

-- AlterEnum (idempotent)
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'BRAND_APPROVAL_REQUESTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'BRAND_APPROVED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'BRAND_REJECTED';

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "BrandApprovalStatus" AS ENUM ('AWAITING_APPROVAL', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "BrandApproval" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "creatorName" TEXT NOT NULL,
    "creatorEmail" TEXT NOT NULL,
    "campaignName" TEXT,
    "fixedFee" DOUBLE PRECISION,
    "commissionRate" DOUBLE PRECISION,
    "negotiationFloor" DOUBLE PRECISION,
    "negotiationCeiling" DOUBLE PRECISION,
    "deliverables" TEXT,
    "timeline" TEXT,
    "paymentTerms" TEXT,
    "rewardDescription" TEXT,
    "creatorHandle" TEXT,
    "creatorPlatform" TEXT,
    "threadId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "approveTokenHash" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "status" "BrandApprovalStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "decidedAt" TIMESTAMP(3),
    "decidedIp" TEXT,
    "decidedUserAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "BrandApproval_instanceId_key" ON "BrandApproval"("instanceId");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "BrandApproval_status_idx" ON "BrandApproval"("status");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "BrandApproval" ADD CONSTRAINT "BrandApproval_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
