-- PLU-139 (2a): the three worksheet controls whose full fidelity needed a real
-- column (the single-scalar columns couldn't hold them):
--   S7.P1 pricing grid       → deliverablePricing: per-deliverable cents map
--   S3.11 follower ranges     → followerRanges: per-platform {min,max} map
--   S7.A1 commission %/flat    → commissionMode: "percent" | "flat"
-- All creator-facing public brief fields, all nullable (incomplete Draft valid).
-- Additive only (ADD COLUMN IF NOT EXISTS) — safe to re-run.

-- S7.P1: { "<platform>:<format>": <cents> } — one price per selected deliverable.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "deliverablePricing" JSONB;

-- S3.11: { "<platform>": { "min": <int|null>, "max": <int|null> } } — per-platform
-- follower ranges (null max = no upper limit), following the deliverableQuantities
-- jsonb precedent.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "followerRanges" JSONB;

-- S7.A1: whether publicCommissionRate is a percentage or a flat amount.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "commissionMode" TEXT;
