import { desc, eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { withDraftLock } from "./campaignDetails.js";
import {
  campaignBriefExtractions,
  type CampaignBriefExtraction,
  type CampaignBriefExtractionInsert,
  type JsonValue,
} from "./schema.js";

// ---------------------------------------------------------------------------
// CampaignBriefExtraction access module (PLU-139 2a — import/candidate review)
// ---------------------------------------------------------------------------
// The durable record of ONE brief-upload parse: its flat text, the structured
// section map the parser produced, the stored source-file reference, and the
// parser version. Unlike the 1:1 section tables (CampaignDetails / BrandIdentity
// / CreatorRequirement) this is APPEND-ONLY — a campaign can have many
// extractions over time (re-uploads), and "the current candidates" is always the
// most recent row. It is EVIDENCE, never authoritative: nothing here writes to
// CampaignDetails. The brand reviews these sections as candidates and confirms
// them into CampaignDetails through the normal PATCH; re-uploading adds a new
// extraction and never overwrites already-confirmed CampaignDetails values.
//
// Draft-locked via the ONE shared guard (assertCampaignIsDraft → CampaignLocked
// on ACTIVE), same as the sibling tables — you don't attach a new brief to a
// launched campaign; you duplicate it.

export async function getLatestBriefExtraction(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignBriefExtraction | null> {
  const rows = await client
    .select()
    .from(campaignBriefExtractions)
    .where(eq(campaignBriefExtractions.campaignId, campaignId))
    // Backed by CampaignBriefExtraction_campaignId_createdAt_idx.
    .orderBy(desc(campaignBriefExtractions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface BriefExtractionInput {
  flatText: string;
  sections: JsonValue;
  other?: JsonValue | null;
  sourceFileReference: string;
  parserVersion: string;
}

/**
 * Append one brief-extraction record. Insert-only (no upsert) — every upload is
 * kept so provenance/history survives. Throws CampaignLockedError once the
 * campaign has launched (status ACTIVE), same draft-only lock as CampaignDetails.
 */
export async function insertBriefExtraction(
  campaignId: string,
  data: BriefExtractionInput,
  client: Db | DbTx = db,
): Promise<CampaignBriefExtraction> {
  return withDraftLock(campaignId, client, async (tx) => {
    const values: CampaignBriefExtractionInsert = {
      campaignId,
      flatText: data.flatText,
      sections: data.sections,
      other: data.other ?? null,
      sourceFileReference: data.sourceFileReference,
      parserVersion: data.parserVersion,
    };
    const rows = await tx.insert(campaignBriefExtractions).values(values).returning();
    return rows[0]!;
  });
}
