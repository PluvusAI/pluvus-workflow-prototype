-- PLU-112: Rolling Conversation Summary — one narrative précis per ExecutionInstance
-- of the ELIDED transcript prefix (turns older than the recent raw window), so a
-- long thread does not ship every raw message yet older rates/promises/objections
-- stay reachable and recent wording is preserved for tone. It is a DERIVED artifact
-- (not a second copy of the conversation — PLU-69 §1.1); it earns its own table
-- because it has its own LIFECYCLE — a staleness/refresh cursor
-- (summarizedThroughSentAt) that advances as newer turns FINALIZE.
--
-- Purely ADDITIVE. One new table (ConversationSummary) with a plain instanceId FK
-- to ExecutionInstance and one nullable Message FK (summarizedThroughMessageId), one
-- UNIQUE index (one summary per instance). NO new enums, NO column changes to any
-- existing table. Nothing existing is altered — an instance with no summary row
-- renders no summary block, byte-identical to today when CONVERSATION_SUMMARY_ENABLED
-- is off (the dark path === the shipped path, PLU-69 §5.6).
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Constraint
-- names follow the Prisma convention (_pkey / _fkey / _key) so a later
-- `drizzle-kit pull` sees the names it expects.
--
-- Idempotent: table + index use IF NOT EXISTS, the FK ADD CONSTRAINTs are wrapped in
-- DO/EXCEPTION (duplicate_object) so a partial prior run does not fail a re-run.
--
-- ⚠ APPLY DIRECTLY TO NEON + PROBE THE LIVE SCHEMA AFTER. `migrate deploy` and
-- _prisma_migrations are UNRELIABLE on this project (silently skipped a
-- table/index/column twice — PLU-109, PLU-70). This migration is not "done" until
-- the table, both FKs, and the unique index are confirmed to exist on Neon.

-- CreateTable
CREATE TABLE IF NOT EXISTS "ConversationSummary" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    -- §5.4.1: the cursor is the transcript's OWN ordering key (sentAt), NOT a
    -- message id, so a send-delayed outbound (sentAt stamped at flush, up to 5 min
    -- late) is never summarized-past while still reserved.
    "summarizedThroughSentAt" TIMESTAMP(3),
    -- Audit/debug only — the Message row at the high-water mark (NOT the cursor).
    "summarizedThroughMessageId" TEXT,
    "version" TEXT,
    "estimatedInputTokensSaved" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (UNIQUE — one rolling summary per instance)
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationSummary_instanceId_key"
    ON "ConversationSummary" ("instanceId");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "ConversationSummary"
      ADD CONSTRAINT "ConversationSummary_instanceId_fkey"
      FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "ConversationSummary"
      ADD CONSTRAINT "ConversationSummary_summarizedThroughMessageId_fkey"
      FOREIGN KEY ("summarizedThroughMessageId") REFERENCES "Message"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
