import { eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { withDraftLock } from "./campaignDetails.js";
import {
  creatorRequirements,
  type CreatorRequirement,
  type CreatorRequirementInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// CreatorRequirement access module (PLU-139 2a)
// ---------------------------------------------------------------------------
// Informational creator-fit criteria for a campaign (1:1). INFORMATIONAL ONLY —
// nothing reads this into matching/ranking/discovery/outreach (guaranteed by
// construction: this module + the campaigns route are the only touch points).
// Mirrors campaignDetails.ts; Draft-lock reuses the one exported guard.

export async function getCreatorRequirement(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CreatorRequirement | null> {
  const rows = await client
    .select()
    .from(creatorRequirements)
    .where(eq(creatorRequirements.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/** Batch lookup for list views — avoids one query per campaign. */
export async function getCreatorRequirementsByCampaignIds(
  campaignIds: string[],
  client: Db | DbTx = db,
): Promise<Map<string, CreatorRequirement>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await client
    .select()
    .from(creatorRequirements)
    .where(inArray(creatorRequirements.campaignId, campaignIds));
  return new Map(rows.map((row) => [row.campaignId, row]));
}

/**
 * Insert-or-update the one CreatorRequirement row a campaign owns. Throws
 * CampaignLockedError once the campaign has launched (status ACTIVE).
 */
export async function upsertCreatorRequirement(
  campaignId: string,
  data: Omit<Partial<CreatorRequirementInsert>, "id" | "campaignId">,
  client: Db | DbTx = db,
): Promise<CreatorRequirement> {
  return withDraftLock(campaignId, client, async (tx) => {
    const rows = await tx
      .insert(creatorRequirements)
      .values({ campaignId, ...data })
      .onConflictDoUpdate({ target: creatorRequirements.campaignId, set: data })
      .returning();
    return rows[0]!;
  });
}
