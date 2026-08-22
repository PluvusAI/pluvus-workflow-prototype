-- PLU-172: the closed-form Page-8 private-policy contract — 10 new enums,
-- 17 new NegotiationPolicy/NegotiationPolicySnapshot columns (mirrored
-- identically across both), 2 new CampaignDetails columns.
--
-- Every mode column is NOT NULL with a conservative default (see
-- schema.prisma's NegotiationPolicy doc comment for why) — safe on an
-- existing table: Postgres backfills the default for every current row as
-- part of the ALTER TABLE, no separate UPDATE needed (same pattern already
-- used by 20260701175232_campaign_product_reward's shipsPhysicalProduct).
--
-- No CampaignAuditEventType changes — private-policy edits are audited
-- under the EXISTING POLICY_CHANGED value (Calvin review: no new event type
-- needed as long as the payload never carries raw private values — see
-- db/negotiationPolicy.ts's upsertNegotiationPolicy).
--
-- Idempotent throughout: enums use DO/EXCEPTION, columns use IF NOT EXISTS
-- — safe to re-run, same convention as every migration since
-- 20260810120000_plu136_campaign_type_duplication.

-- =============================================================================
-- CreateEnum (idempotent)
-- =============================================================================

DO $$ BEGIN
  CREATE TYPE "FeeNegotiationMode" AS ENUM ('KEEP_PUBLIC_OFFER', 'ALLOW_WITHIN_LIMIT', 'ASK_FOR_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CommissionNegotiationMode" AS ENUM ('KEEP_PUBLIC_COMMISSION', 'ALLOW_WITHIN_LIMIT', 'ASK_FOR_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CommissionDurationMode" AS ENUM ('KEEP_PUBLIC_DURATION', 'ALLOW_WITHIN_LIMIT', 'ASK_FOR_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DurationUnit" AS ENUM ('DAYS', 'LIFETIME', 'COUNT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "GiftSubstitutionMode" AS ENUM ('KEEP_OFFERED_BENEFIT', 'ALLOW_EQUIVALENT_APPROVED_OPTION', 'ASK_FOR_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "GiftCashReplacementMode" AS ENUM ('REJECT', 'ASK_FOR_APPROVAL', 'ALLOW_UP_TO_AMOUNT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DeliverableNegotiationMode" AS ENUM ('KEEP_REQUESTED', 'ASK_FOR_APPROVAL', 'ALLOW_SELECTED_CHANGES');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PostingNegotiationMode" AS ENUM ('KEEP_DEADLINE', 'ALLOW_DELAY_DAYS', 'ASK_FOR_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RightsNegotiationMode" AS ENUM ('KEEP_REQUESTED', 'ALLOW_TO_MINIMUM', 'ASK_FOR_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Calvin review: script submission (S8.C5) does NOT share RightsNegotiationMode
-- — ALLOW_TO_MINIMUM has no meaning for a boolean-ish "require the script or
-- not" term. Its own dedicated mode.
DO $$ BEGIN
  CREATE TYPE "ScriptWaiverMode" AS ENUM ('KEEP_SUBMISSION_REQUIRED', 'ALLOW_WAIVER', 'ASK_FOR_APPROVAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "OutOfPolicyAction" AS ENUM ('ASK_FOR_APPROVAL', 'REJECT_REQUEST');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- AlterTable — CampaignDetails (2 new public columns)
-- =============================================================================

ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "commissionDurationUnit" "DurationUnit";
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "contentRepurposeRights" TEXT;

-- =============================================================================
-- AlterTable — NegotiationPolicy (17 new private-authority columns)
-- =============================================================================

ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "feeMode" "FeeNegotiationMode" NOT NULL DEFAULT 'KEEP_PUBLIC_OFFER';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionNegotiationMode" "CommissionNegotiationMode" NOT NULL DEFAULT 'KEEP_PUBLIC_COMMISSION';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionCeilingAmountCents" INTEGER;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionDurationMode" "CommissionDurationMode" NOT NULL DEFAULT 'KEEP_PUBLIC_DURATION';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionDurationLimitValue" INTEGER;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "commissionDurationLimitUnit" "DurationUnit";
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "giftSubstitutionMode" "GiftSubstitutionMode" NOT NULL DEFAULT 'KEEP_OFFERED_BENEFIT';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "giftApprovedSubstitutes" JSONB;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "giftCashReplacementMode" "GiftCashReplacementMode" NOT NULL DEFAULT 'REJECT';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "giftCashReplacementLimitCents" INTEGER;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "deliverableNegotiationMode" "DeliverableNegotiationMode" NOT NULL DEFAULT 'KEEP_REQUESTED';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "deliverablePolicyRules" JSONB;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "postingNegotiationMode" "PostingNegotiationMode" NOT NULL DEFAULT 'KEEP_DEADLINE';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "postingMaxDelayDays" INTEGER;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "rightsPolicyRules" JSONB;
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "scriptWaiverMode" "ScriptWaiverMode" NOT NULL DEFAULT 'KEEP_SUBMISSION_REQUIRED';
ALTER TABLE "NegotiationPolicy" ADD COLUMN IF NOT EXISTS "outOfPolicyAction" "OutOfPolicyAction" NOT NULL DEFAULT 'ASK_FOR_APPROVAL';

-- =============================================================================
-- AlterTable — NegotiationPolicySnapshot (same 17 columns, identical defaults)
-- =============================================================================
--
-- Calvin review (defaults on immutable snapshots): a DEFAULT here only ever
-- backfills a PRE-EXISTING row that predates this migration — i.e. an
-- already-launched campaign whose snapshot was frozen before this ticket's
-- concepts existed. That backfilled value carries NO decision provenance
-- (no brand ever chose KEEP_PUBLIC_OFFER for that campaign; the column
-- simply didn't exist yet) and MUST NOT be read as one. Nothing in this
-- codebase reads these columns yet (POLICY_CAPABILITIES marks every
-- category evaluated:false), so there is no present consumer at risk of
-- misreading a backfilled default as a real decision — but this is a real
-- caveat for whichever of PLU-175/176/178 eventually builds the first
-- evaluator: an old snapshot's default values are schema filler, not
-- brand intent, and should not silently be treated as equivalent to a new
-- snapshot's explicitly-projected ones without that distinction being
-- made deliberately (e.g. by also checking the snapshot's launchedAt
-- against this migration's rollout date, or a future explicit
-- "policy contract version" marker if this ever becomes a real ambiguity
-- in practice).

ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "feeMode" "FeeNegotiationMode" NOT NULL DEFAULT 'KEEP_PUBLIC_OFFER';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionNegotiationMode" "CommissionNegotiationMode" NOT NULL DEFAULT 'KEEP_PUBLIC_COMMISSION';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionCeilingAmountCents" INTEGER;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionDurationMode" "CommissionDurationMode" NOT NULL DEFAULT 'KEEP_PUBLIC_DURATION';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionDurationLimitValue" INTEGER;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "commissionDurationLimitUnit" "DurationUnit";
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "giftSubstitutionMode" "GiftSubstitutionMode" NOT NULL DEFAULT 'KEEP_OFFERED_BENEFIT';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "giftApprovedSubstitutes" JSONB;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "giftCashReplacementMode" "GiftCashReplacementMode" NOT NULL DEFAULT 'REJECT';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "giftCashReplacementLimitCents" INTEGER;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "deliverableNegotiationMode" "DeliverableNegotiationMode" NOT NULL DEFAULT 'KEEP_REQUESTED';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "deliverablePolicyRules" JSONB;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "postingNegotiationMode" "PostingNegotiationMode" NOT NULL DEFAULT 'KEEP_DEADLINE';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "postingMaxDelayDays" INTEGER;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "rightsPolicyRules" JSONB;
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "scriptWaiverMode" "ScriptWaiverMode" NOT NULL DEFAULT 'KEEP_SUBMISSION_REQUIRED';
ALTER TABLE "NegotiationPolicySnapshot" ADD COLUMN IF NOT EXISTS "outOfPolicyAction" "OutOfPolicyAction" NOT NULL DEFAULT 'ASK_FOR_APPROVAL';
