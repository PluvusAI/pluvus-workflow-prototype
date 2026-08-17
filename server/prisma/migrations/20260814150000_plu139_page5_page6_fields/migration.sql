-- PLU-139 (2a): the remaining worksheet Page-5 and Page-6 questions that had no
-- CampaignDetails column, so the sectioned intake could never persist them.
-- All creator-facing public brief fields, all nullable (an incomplete Draft is
-- valid). Additive only — ADD COLUMN IF NOT EXISTS, safe to re-run and safe
-- against a live DB that already has the other Stage-1 columns.

-- Page 5 — content brief / creative requirements (previously folded into the
-- single contentRequirements textarea, so they had no home of their own).
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "briefHighlight" TEXT;      -- S5.2
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "creativeConcept" TEXT;     -- S5.4
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "referenceVideos" TEXT;     -- S5.5 (one link per line)
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "scriptSubmission" TEXT;    -- S5.6 ("require" | "skip")

-- Page 6 — ad authorization (S6.3) was previously merged with repurpose rights
-- (S6.5) into usageRights. Split it out so each maps to its own worksheet row.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "adAuthorization" TEXT;      -- S6.3
