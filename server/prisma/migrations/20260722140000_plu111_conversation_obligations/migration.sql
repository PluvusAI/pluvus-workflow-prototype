-- PLU-111: Conversation Obligations — durable creator questions + Pluvus
-- commitments with an explicit lifecycle.
--
-- Purely ADDITIVE. Two new enums, one new table (with a plain instanceId FK to
-- ExecutionInstance and two nullable Message FKs), one composite index, and one
-- PARTIAL UNIQUE index that backstops the conservative "at most one non-terminal
-- obligation per (instance, type, normalizedKey)" dedup guard (§4.3). Nothing
-- existing is altered, so every in-flight instance keeps working — an instance
-- with no obligation rows falls back to computeOpenQuestions (§4.7), byte-
-- identical to today.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Constraint
-- names follow the Prisma convention (_pkey / _fkey / _idx / _key) so a later
-- `drizzle-kit pull` sees the names it expects.
--
-- Idempotent: enums use DO/EXCEPTION, table/indexes use IF NOT EXISTS so a
-- partial prior run does not fail a re-run. This mirrors the DeadLetterJob
-- migration (20260719140000). Both enums are created WHOLE by CREATE TYPE — no
-- ALTER TYPE ... ADD VALUE — so there is no "can't use a new enum value in the
-- creating transaction" hazard; the partial index below compares status against
-- string literals cast to the already-created enum type.

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "ObligationType" AS ENUM ('CREATOR_QUESTION', 'PLUVUS_COMMITMENT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "ConversationObligationStatus" AS ENUM (
    'OPEN', 'ANSWERED', 'DEFERRED', 'ESCALATED', 'COMPLETED', 'CANCELED', 'NO_LONGER_RELEVANT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversationObligation" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "type" "ObligationType" NOT NULL,
    "status" "ConversationObligationStatus" NOT NULL DEFAULT 'OPEN',
    "originalText" TEXT NOT NULL,
    "normalizedKey" TEXT NOT NULL,
    "category" TEXT,
    "resolution" TEXT,
    "resolutionSource" TEXT,
    "sourceMessageId" TEXT,
    "resolutionMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ConversationObligation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The AI-context read + observability scan by (instance, status).
CREATE INDEX IF NOT EXISTS "ConversationObligation_instanceId_status_idx"
    ON "ConversationObligation" ("instanceId", "status");

-- CreateIndex (PARTIAL UNIQUE — the conservative dedup DB backstop, §4.3)
-- At most one NON-TERMINAL obligation per (instance, type, normalizedKey). A
-- concurrent double-insert (a BullMQ retry racing the same turn) hits this and
-- is caught as isUniqueViolation → treated as "already open", so the ledger
-- never double-lists a question. Partial (scoped to the non-terminal statuses)
-- so terminal history can accumulate: a question asked, answered, then re-asked
-- later gets a FRESH open row — correctly a new thread.
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationObligation_open_key"
    ON "ConversationObligation" ("instanceId", "type", "normalizedKey")
    WHERE ("status" IN ('OPEN', 'DEFERRED', 'ESCALATED'));

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "ConversationObligation"
      ADD CONSTRAINT "ConversationObligation_instanceId_fkey"
      FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "ConversationObligation"
      ADD CONSTRAINT "ConversationObligation_sourceMessageId_fkey"
      FOREIGN KEY ("sourceMessageId") REFERENCES "Message"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "ConversationObligation"
      ADD CONSTRAINT "ConversationObligation_resolutionMessageId_fkey"
      FOREIGN KEY ("resolutionMessageId") REFERENCES "Message"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
