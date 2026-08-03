-- PLU-112: Rolling Conversation Summary — one narrative summary per instance that
-- covers the elided transcript prefix, so a long draft prompt can window its raw
-- history without losing it.
--
-- Purely ADDITIVE. One new table + its unique index and FKs. Nothing existing is
-- altered; with CONVERSATION_SUMMARY_ENABLED off no rows are written and the draft
-- prompt is byte-identical to today.
--
-- summarizedThroughSentAt is the coverage cursor (the sentAt high-water mark of the
-- folded-in prefix) — the same ordering key the transcript uses, so a filtered or
-- rolled-back message never strands it. Narrative-only: rates/questions/commitments
-- stay owned by events / obligations / creator memory, never restated here.
--
-- Forward-only, hand-written (drizzle-kit push/generate is forbidden). Constraint
-- names follow the Prisma convention (_pkey / _fkey / _idx / _key). Idempotent:
-- table/index use IF NOT EXISTS, FKs guard against duplicate_object.

-- CreateTable — one rolling summary per instance.
CREATE TABLE IF NOT EXISTS "ConversationSummary" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "summarizedThroughSentAt" TIMESTAMP(3) NOT NULL,
    "summarizedThroughMessageId" TEXT,
    "version" TEXT NOT NULL,
    "estimatedTokensSaved" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one summary per instance (the CAS upsert keys on this).
CREATE UNIQUE INDEX IF NOT EXISTS "ConversationSummary_instanceId_key"
    ON "ConversationSummary"("instanceId");

-- AddForeignKey — summary → instance.
DO $$ BEGIN
  ALTER TABLE "ConversationSummary"
      ADD CONSTRAINT "ConversationSummary_instanceId_fkey"
      FOREIGN KEY ("instanceId") REFERENCES "ExecutionInstance"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey — cursor's audit message (nullable).
DO $$ BEGIN
  ALTER TABLE "ConversationSummary"
      ADD CONSTRAINT "ConversationSummary_summarizedThroughMessageId_fkey"
      FOREIGN KEY ("summarizedThroughMessageId") REFERENCES "Message"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
