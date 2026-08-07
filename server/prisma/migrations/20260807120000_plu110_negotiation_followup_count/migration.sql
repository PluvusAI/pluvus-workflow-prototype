-- PLU-110: negotiation-nudge attempt counter. Additive, NOT NULL DEFAULT 0
-- (fast metadata-only backfill). Idempotent for re-runs.
ALTER TABLE "ExecutionInstance" ADD COLUMN IF NOT EXISTS "negotiationFollowUpCount" INTEGER NOT NULL DEFAULT 0;
