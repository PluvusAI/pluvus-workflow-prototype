-- PLU-139 (B): drop the six fields that had no worksheet row and no downstream
-- reader, so the Stage-1 intake matches docs/campaign-question-review-worksheet.md
-- exactly. Five were legacy CreatorRequirement criteria (never fed matching/
-- ranking/outreach — informational-only, by construction); prohibitedClaims was a
-- CampaignDetails column populated only from the brief parser's "restrictions"
-- section, which is removed in the same change (agent/app/brief.py).
--
-- Destructive but low-risk: all six were nullable and unread outside the intake
-- PATCH plumbing. DROP COLUMN IF EXISTS → safe to re-run.

ALTER TABLE "CreatorRequirement" DROP COLUMN IF EXISTS "niches";
ALTER TABLE "CreatorRequirement" DROP COLUMN IF EXISTS "languages";
ALTER TABLE "CreatorRequirement" DROP COLUMN IF EXISTS "audienceNotes";
ALTER TABLE "CreatorRequirement" DROP COLUMN IF EXISTS "contentStyle";
ALTER TABLE "CreatorRequirement" DROP COLUMN IF EXISTS "brandSafety";

ALTER TABLE "CampaignDetails" DROP COLUMN IF EXISTS "prohibitedClaims";
