-- PLU-139 (2a): the worksheet Stage-1 public-brief questions that had no
-- CampaignDetails column, so the sectioned intake could never persist them.
-- All creator-facing, all nullable (an incomplete Draft is valid). Closed-set
-- fields (creatorAccessNeeded, briefDeliveryMethod, giftDeliveryMethod,
-- trackingLinkMode) are plain TEXT/BOOLEAN validated at the route rather than PG
-- enums, so PLU-159 can retune the option sets without another migration.
--
-- Additive only: every statement is ADD COLUMN IF NOT EXISTS, so this is safe to
-- re-run and safe against a live DB that already has some columns.

-- Page 2 — Campaign & product.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "productType" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "creatorAccessNeeded" BOOLEAN;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "uniqueSellingPoints" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "whyTrust" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "howToUse" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "brandAssets" TEXT;

-- Page 1 — supporting-materials upload reference (S1.4).
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "brandMaterialsRef" TEXT;

-- Page 3 — per-platform deliverable quantities (S3.2–S3.9): a JSON list of
-- { platform, format, quantity }.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "deliverableQuantities" JSONB;

-- Page 5 — brief delivery method (S5.1).
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "briefDeliveryMethod" TEXT;

-- Page 6 — rights durations / options not previously modelled.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "linkInBioDuration" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "postRetention" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "instagramCollab" BOOLEAN;

-- Page 7 — shared onboarding + affiliate/gift specifics.
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "requireApproval" BOOLEAN;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "variableCommission" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "giftDeliveryMethod" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "promoCode" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "giftContactEmail" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "requiresShippingInfo" BOOLEAN;

-- Page 7 — public affiliate tracking (T-series).
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "affiliateTrackingUrl" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "trackingLinkMode" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "trackingDestinationUrl" TEXT;
ALTER TABLE "CampaignDetails" ADD COLUMN IF NOT EXISTS "trackingParameter" TEXT;
