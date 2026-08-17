import { eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { withDraftLock } from "./campaignDetails.js";
import {
  brandIdentities,
  type BrandIdentity,
  type BrandIdentityInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// BrandIdentity access module (PLU-139 2a)
// ---------------------------------------------------------------------------
// The brand's identity/branding for a campaign (1:1). Mirrors campaignDetails.ts:
// get / batch-get / upsert-on-unique-campaignId. Draft-lock reuses the ONE
// exported guard (assertCampaignIsDraft → CampaignLockedError on ACTIVE); this
// module does not re-implement the status check.

export async function getBrandIdentity(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<BrandIdentity | null> {
  const rows = await client
    .select()
    .from(brandIdentities)
    .where(eq(brandIdentities.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/** Batch lookup for list views — avoids one query per campaign. */
export async function getBrandIdentitiesByCampaignIds(
  campaignIds: string[],
  client: Db | DbTx = db,
): Promise<Map<string, BrandIdentity>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await client
    .select()
    .from(brandIdentities)
    .where(inArray(brandIdentities.campaignId, campaignIds));
  return new Map(rows.map((row) => [row.campaignId, row]));
}

/**
 * Insert-or-update the one BrandIdentity row a campaign owns. Throws
 * CampaignLockedError once the campaign has launched (status ACTIVE) — same
 * draft-only lock as CampaignDetails.
 */
export async function upsertBrandIdentity(
  campaignId: string,
  data: Omit<Partial<BrandIdentityInsert>, "id" | "campaignId">,
  client: Db | DbTx = db,
): Promise<BrandIdentity> {
  return withDraftLock(campaignId, client, async (tx) => {
    const rows = await tx
      .insert(brandIdentities)
      .values({ campaignId, ...data })
      .onConflictDoUpdate({ target: brandIdentities.campaignId, set: data })
      .returning();
    return rows[0]!;
  });
}
