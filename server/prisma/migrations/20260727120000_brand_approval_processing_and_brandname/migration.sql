-- PLU-118 (Calvin review follow-up): harden the brand-approval gate.
--
-- Purely ADDITIVE. Two changes:
--   1. Add a PROCESSING member to BrandApprovalStatus. It is a short-lived claim
--      held ONLY while the workflow action (content-brief send / halt to manual
--      review) runs, so the brand's decision is finalized (APPROVED/REJECTED)
--      STRICTLY AFTER that action succeeds. A PROCESSING row whose action fails
--      reverts to AWAITING_APPROVAL so the brand can retry the same link instead of
--      being told "already actioned" while the execution is still parked (§2).
--   2. Add a nullable BrandApproval.brandName column so the hosted approval page can
--      head itself with the real brand name instead of the campaign name (§ page
--      heading). Existing rows keep NULL and fall back to campaignName at read.
--
-- No data backfill and no column is dropped or made NOT NULL, so every in-flight
-- and historical BrandApproval row is untouched.
--
-- Idempotent: ALTER TYPE uses IF NOT EXISTS, ADD COLUMN uses IF NOT EXISTS.

-- AlterEnum (idempotent)
ALTER TYPE "BrandApprovalStatus" ADD VALUE IF NOT EXISTS 'PROCESSING' BEFORE 'APPROVED';

-- AlterTable (idempotent)
ALTER TABLE "BrandApproval" ADD COLUMN IF NOT EXISTS "brandName" TEXT;
