-- PLU-143: Content Brief generation provenance on FinalAgreement.
--
-- Purely ADDITIVE. Four new nullable columns + one new foreign key. No
-- existing column/table is touched.
--
-- Idempotent: ADD COLUMN uses IF NOT EXISTS, the foreign-key constraint uses
-- DO/EXCEPTION — same conventions as 20260820120000_plu169_final_agreement.

-- AlterTable (idempotent)
ALTER TABLE "FinalAgreement" ADD COLUMN IF NOT EXISTS "contentBriefGeneratedAt" TIMESTAMP(3);
ALTER TABLE "FinalAgreement" ADD COLUMN IF NOT EXISTS "contentBriefCampaignBriefId" TEXT;
ALTER TABLE "FinalAgreement" ADD COLUMN IF NOT EXISTS "contentBriefAssetRef" TEXT;
ALTER TABLE "FinalAgreement" ADD COLUMN IF NOT EXISTS "contentBriefTemplateVersion" TEXT;

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "FinalAgreement" ADD CONSTRAINT "FinalAgreement_contentBriefCampaignBriefId_fkey"
    FOREIGN KEY ("contentBriefCampaignBriefId") REFERENCES "CampaignBrief"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
