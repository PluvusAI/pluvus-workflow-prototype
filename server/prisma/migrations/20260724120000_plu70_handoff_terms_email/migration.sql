-- PLU-70: richer brand confirmation email on operator handoff.
--
-- Purely ADDITIVE. Three new nullable columns on DealHandoff so the deal
-- finalization email sent to the campaign's notifyEmail can quote the
-- negotiation range ("your range: $500–$600") and the campaign perk/reward,
-- alongside the agreed terms it already carries.
--
-- All three are nullable with no default, so every existing DealHandoff row is
-- valid as-is (NULL = "not captured") and no backfill is required.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS so a partial prior run does not fail a re-run.

-- AlterTable
ALTER TABLE "DealHandoff" ADD COLUMN IF NOT EXISTS "negotiationFloor" DOUBLE PRECISION;
ALTER TABLE "DealHandoff" ADD COLUMN IF NOT EXISTS "negotiationCeiling" DOUBLE PRECISION;
ALTER TABLE "DealHandoff" ADD COLUMN IF NOT EXISTS "rewardDescription" TEXT;
