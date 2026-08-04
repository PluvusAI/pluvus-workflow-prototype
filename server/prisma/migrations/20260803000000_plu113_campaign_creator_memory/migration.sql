-- PLU-113: Campaign-Scoped Creator Memory — durable creator facts that survive
-- summarization, with a full immutable revision history and recoverable failed
-- writes.
--
-- Purely ADDITIVE. Three new enums (MemoryFactKey / MemoryFactStatus /
-- MemoryRevisionSource), three new tables, and their indexes/FKs. Nothing existing
-- is altered, so every in-flight instance keeps working; with the feature flag off
-- no rows are written and /negotiate + /draft prompts are byte-identical to today.
--
-- Design (mirrors Calvin's review):
--   * CampaignCreatorMemory is the LIVE HEAD — one row per fact, its current value.
--   * CampaignCreatorMemoryRevision is the IMMUTABLE history — every value the fact
--     ever held (source message + evidence), never updated/deleted (review #4).
--   * FailedMemoryWrite makes a fail-soft memory-write error recoverable + operator
--     visible instead of stdout-only (review #6). It reuses the existing
--     DeadLetterStatus enum.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Constraint
-- names follow the Prisma convention (_pkey / _fkey / _idx / _key). Idempotent:
-- enums use DO/EXCEPTION, tables/indexes use IF NOT EXISTS. Both new enums are
-- created WHOLE by CREATE TYPE (no ALTER TYPE ... ADD VALUE), so the partial index
-- can compare status against literals cast to the already-created type.

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "MemoryFactKey" AS ENUM (
    'REQUESTED_RATE', 'MINIMUM_RATE', 'AVAILABILITY', 'LOGISTICS_CONSTRAINT',
    'OBJECTION', 'DELIVERABLE_PREFERENCE', 'COMPENSATION_PREFERENCE',
    'MANAGER_INVOLVED', 'MANAGER_CONTACT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "MemoryFactStatus" AS ENUM (
    'ACTIVE', 'CONFLICTED', 'SUPERSEDED', 'REMOVED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "MemoryRevisionSource" AS ENUM ('creator', 'operator');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable — the live head (one row per fact).
CREATE TABLE IF NOT EXISTS "CampaignCreatorMemory" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "key" "MemoryFactKey" NOT NULL,
    "status" "MemoryFactStatus" NOT NULL DEFAULT 'ACTIVE',
    "value" TEXT NOT NULL,
    "valueNumber" DOUBLE PRECISION,
    "normalizedValue" TEXT NOT NULL,
    "category" TEXT,
    "currentRevisionId" TEXT,
    "conflictValue" TEXT,
    "conflictSourceMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCreatorMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable — the immutable revision log (never updated/deleted).
CREATE TABLE IF NOT EXISTS "CampaignCreatorMemoryRevision" (
    "id" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueNumber" DOUBLE PRECISION,
    "source" "MemoryRevisionSource" NOT NULL,
    "sourceMessageId" TEXT,
    "evidenceText" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignCreatorMemoryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable — durable failed memory-write record (recoverable, operator-visible).
CREATE TABLE IF NOT EXISTS "FailedMemoryWrite" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "sourceMessageId" TEXT,
    "error" TEXT NOT NULL,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "FailedMemoryWrite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — the AI-context read + observability scan by (instance, status).
CREATE INDEX IF NOT EXISTS "CampaignCreatorMemory_instanceId_status_idx"
    ON "CampaignCreatorMemory" ("instanceId", "status");

-- CreateIndex (PARTIAL UNIQUE) — at most one LIVE (ACTIVE/CONFLICTED) row per
-- (instance, key, normalizedValue). Singleton keys collapse via a per-key sentinel
-- normalizedValue → one live row per (instance, key); list keys allow one live row
-- per distinct value. Partial so SUPERSEDED/REMOVED heads accumulate as history.
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignCreatorMemory_live_key"
    ON "CampaignCreatorMemory" ("instanceId", "key", "normalizedValue")
    WHERE ("status" IN ('ACTIVE', 'CONFLICTED'));

-- CreateIndex — revisions of a fact, chronological read for the operator panel.
CREATE INDEX IF NOT EXISTS "CampaignCreatorMemoryRevision_memoryId_idx"
    ON "CampaignCreatorMemoryRevision" ("memoryId");

-- CreateIndex — the recovery-sweep + operator scan by (instance, status).
CREATE INDEX IF NOT EXISTS "FailedMemoryWrite_instanceId_status_idx"
    ON "FailedMemoryWrite" ("instanceId", "status");

-- AddForeignKey — memory head → instance (campaign-scoped, never Creator).
ALTER TABLE "CampaignCreatorMemory"
    ADD CONSTRAINT "CampaignCreatorMemory_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — the conflict pair's prior source message (nullable).
ALTER TABLE "CampaignCreatorMemory"
    ADD CONSTRAINT "CampaignCreatorMemory_conflictSourceMessageId_fkey"
    FOREIGN KEY ("conflictSourceMessageId") REFERENCES "Message"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey — revision → head.
ALTER TABLE "CampaignCreatorMemoryRevision"
    ADD CONSTRAINT "CampaignCreatorMemoryRevision_memoryId_fkey"
    FOREIGN KEY ("memoryId") REFERENCES "CampaignCreatorMemory"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — revision → source message (creator revisions only; nullable).
ALTER TABLE "CampaignCreatorMemoryRevision"
    ADD CONSTRAINT "CampaignCreatorMemoryRevision_sourceMessageId_fkey"
    FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey — failed write → instance.
ALTER TABLE "FailedMemoryWrite"
    ADD CONSTRAINT "FailedMemoryWrite_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — failed write → source message (nullable).
ALTER TABLE "FailedMemoryWrite"
    ADD CONSTRAINT "FailedMemoryWrite_sourceMessageId_fkey"
    FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
