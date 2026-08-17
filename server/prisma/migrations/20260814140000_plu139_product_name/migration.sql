-- PLU-139 (2a): the one remaining worksheet Page-2 question with no column.
-- S2.3 "Product name" — the AHA-required product name, previously folded into
-- brandDescription (S2.6). Creator-facing public brief field, nullable (an
-- incomplete Draft is valid). Additive — ADD COLUMN IF NOT EXISTS, safe to
-- re-run and safe against a live DB that already has the other Stage-1 columns.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "productName" TEXT;
