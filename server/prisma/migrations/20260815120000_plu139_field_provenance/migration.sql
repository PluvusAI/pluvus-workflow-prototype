-- PLU-139: field-level provenance for CampaignDetails.
-- One JSONB map { "<fieldKey>": "manual" | "pdf_extracted" } recording how each
-- creator-facing value got here — a field the brand typed/edited is "manual"; a
-- value applied from an uploaded brief candidate is "pdf_extracted". Only the
-- reachable sources are recorded (no website crawl / copy-flow tags yet). Nullable
-- (an absent key = no provenance recorded). Additive — ADD COLUMN IF NOT EXISTS,
-- safe to re-run.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "fieldProvenance" JSONB;
