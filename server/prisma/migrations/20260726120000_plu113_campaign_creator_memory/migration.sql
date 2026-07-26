-- PLU-113: Campaign-Scoped Creator Memory — a narrow, campaign-scoped ledger of
-- durable creator facts (requested/minimum rate, availability, logistics,
-- objections, deliverable/compensation preferences, manager involvement), each
-- traced to the source Message it came from, updated ONLY from creator
-- communication or operator confirmation, conflicts surfaced not silently
-- overwritten.
--
-- Purely ADDITIVE. Two new enums (MemoryFactKey, MemoryFactStatus), one new table
-- (CampaignCreatorMemory) with a plain instanceId FK to ExecutionInstance
-- (campaign-scoped — NEVER Creator) and two nullable Message FKs (sourceMessageId,
-- priorSourceMessageId), one composite index, and one PARTIAL UNIQUE index that
-- backstops the "at most one live row per (instance, key, normalizedValue)" dedup
-- (§4.1, §4.6). Nothing existing is altered, so every in-flight instance keeps
-- working — an instance with no memory rows renders an empty block, byte-identical
-- to today when CREATOR_MEMORY_ENABLED is off (invariant #8).
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Constraint
-- names follow the Prisma convention (_pkey / _fkey / _idx / _key) so a later
-- `drizzle-kit pull` sees the names it expects.
--
-- Idempotent: enums use DO/EXCEPTION, table/indexes use IF NOT EXISTS, and the FK
-- ADD CONSTRAINTs are wrapped in DO/EXCEPTION (duplicate_object) so a partial
-- prior run does not fail a re-run. Both enums are created WHOLE by CREATE TYPE —
-- no ALTER TYPE ... ADD VALUE — so there is no "can't use a new enum value in the
-- creating transaction" hazard; the partial index below compares status against
-- string literals cast to the already-created enum type.
--
-- ⚠ APPLY DIRECTLY TO NEON + PROBE THE LIVE SCHEMA AFTER (§5.1). `migrate deploy`
-- and _prisma_migrations are UNRELIABLE on this project (shipped a
-- table/index/column that silently never landed twice — PLU-109, PLU-70). This
-- migration is not "done" until the table, both enums, the three FKs, the
-- composite index, and the partial-unique index are confirmed to exist on Neon.

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

-- CreateTable
CREATE TABLE IF NOT EXISTS "CampaignCreatorMemory" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "key" "MemoryFactKey" NOT NULL,
    "status" "MemoryFactStatus" NOT NULL DEFAULT 'ACTIVE',
    "value" TEXT NOT NULL,
    "valueNumber" DOUBLE PRECISION,
    "normalizedValue" TEXT NOT NULL,
    "category" TEXT,
    "sourceMessageId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'ai',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorValue" TEXT,
    "priorSourceMessageId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCreatorMemory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The AI-context read + observability scan by (instance, status).
CREATE INDEX IF NOT EXISTS "CampaignCreatorMemory_instanceId_status_idx"
    ON "CampaignCreatorMemory" ("instanceId", "status");

-- CreateIndex (PARTIAL UNIQUE — the dedup DB backstop, §4.6)
-- At most one LIVE (ACTIVE/CONFLICTED) row per (instance, key, normalizedValue).
-- For SINGLETON keys normalizedValue is a per-key sentinel → one live row per
-- (instance, key). For LIST keys it's normalized(value) → one live row per
-- distinct value, many per key. A concurrent double-insert (a BullMQ retry racing
-- the same turn) hits this and is caught as isUniqueViolation → treated as
-- "already live". Partial (scoped to the live statuses) so superseded/removed
-- history can accumulate: a corrected fact keeps its old row for audit.
CREATE UNIQUE INDEX IF NOT EXISTS "CampaignCreatorMemory_live_key"
    ON "CampaignCreatorMemory" ("instanceId", "key", "normalizedValue")
    WHERE ("status" IN ('ACTIVE', 'CONFLICTED'));

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "CampaignCreatorMemory"
      ADD CONSTRAINT "CampaignCreatorMemory_instanceId_fkey"
      FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "CampaignCreatorMemory"
      ADD CONSTRAINT "CampaignCreatorMemory_sourceMessageId_fkey"
      FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "CampaignCreatorMemory"
      ADD CONSTRAINT "CampaignCreatorMemory_priorSourceMessageId_fkey"
      FOREIGN KEY ("priorSourceMessageId") REFERENCES "Message"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
