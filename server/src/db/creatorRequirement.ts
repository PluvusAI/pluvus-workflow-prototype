import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  creatorRequirement,
  type CreatorRequirement,
  type CreatorRequirementInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// CreatorRequirement access module (PLU-139)
// ---------------------------------------------------------------------------
// Informational creator-fit notes for a campaign (1:1). INFORMATIONAL ONLY —
// nothing reads this into matching/ranking/discovery/outreach (guaranteed by
// construction: this module and the campaigns route are the only touch points).
// The Draft-lock guard is the shared assertCampaignIsDraft in campaignDetails.ts.

export async function getCreatorRequirement(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CreatorRequirement | null> {
  const rows = await client
    .select()
    .from(creatorRequirement)
    .where(eq(creatorRequirement.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/** Insert or patch the creator-requirement row. Concurrent-double-insert safe via
 *  the unique campaignId (isUniqueViolation → fall through to update). */
export async function upsertCreatorRequirement(
  campaignId: string,
  patch: Partial<CreatorRequirementInsert>,
  client: Db | DbTx = db,
): Promise<CreatorRequirement> {
  const existing = await getCreatorRequirement(campaignId, client);
  if (existing) {
    const rows = await client
      .update(creatorRequirement)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(creatorRequirement.campaignId, campaignId))
      .returning();
    return rows[0] ?? existing;
  }
  try {
    const rows = await client
      .insert(creatorRequirement)
      .values({ ...patch, campaignId })
      .returning();
    return rows[0]!;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const rows = await client
      .update(creatorRequirement)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(creatorRequirement.campaignId, campaignId))
      .returning();
    if (rows[0]) return rows[0];
    const raced = await getCreatorRequirement(campaignId, client);
    if (raced) return raced;
    throw err;
  }
}
