import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  brandIdentity,
  type BrandIdentity,
  type BrandIdentityInsert,
} from "./schema.js";

// ---------------------------------------------------------------------------
// BrandIdentity access module (PLU-139)
// ---------------------------------------------------------------------------
// The brand's identity/branding for a campaign (1:1). Same shape as
// campaignDetails.ts. The Draft-lock guard lives ONCE in campaignDetails.ts
// (assertCampaignIsDraft) — the route calls it; this module does not re-implement it.

export async function getBrandIdentity(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<BrandIdentity | null> {
  const rows = await client
    .select()
    .from(brandIdentity)
    .where(eq(brandIdentity.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/** Insert or patch the brand-identity row. Concurrent-double-insert safe via the
 *  unique campaignId (isUniqueViolation → fall through to update). */
export async function upsertBrandIdentity(
  campaignId: string,
  patch: Partial<BrandIdentityInsert>,
  client: Db | DbTx = db,
): Promise<BrandIdentity> {
  const existing = await getBrandIdentity(campaignId, client);
  if (existing) {
    const rows = await client
      .update(brandIdentity)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(brandIdentity.campaignId, campaignId))
      .returning();
    return rows[0] ?? existing;
  }
  try {
    const rows = await client
      .insert(brandIdentity)
      .values({ ...patch, campaignId })
      .returning();
    return rows[0]!;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const rows = await client
      .update(brandIdentity)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(brandIdentity.campaignId, campaignId))
      .returning();
    if (rows[0]) return rows[0];
    const raced = await getBrandIdentity(campaignId, client);
    if (raced) return raced;
    throw err;
  }
}
