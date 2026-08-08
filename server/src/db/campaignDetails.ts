import { eq, inArray } from "drizzle-orm";
import { db } from "./drizzle.js";
import {
  campaignDetails,
  campaigns,
  type CampaignDetails,
  type CampaignDetailsInsert,
} from "./schema.js";

/**
 * Thrown when a write is attempted against a draft-only table (CampaignDetails,
 * NegotiationPolicy) on a campaign whose status is ACTIVE. Per the 1a design
 * (Calvin review, 2026-08-08): once launched, these are locked read-only —
 * their values are already frozen into the campaign's snapshot, and a
 * material change means duplicating into a new campaign, never editing this
 * one. Routes should catch this and surface a 409, not a 500.
 */
export class CampaignLockedError extends Error {
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} is launched (ACTIVE) — its draft fields are locked`);
    this.name = "CampaignLockedError";
  }
}

async function assertCampaignIsDraft(campaignId: string): Promise<void> {
  const [campaign] = await db
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (campaign?.status === "ACTIVE") {
    throw new CampaignLockedError(campaignId);
  }
}

export async function getCampaignDetails(
  campaignId: string,
): Promise<CampaignDetails | null> {
  const rows = await db
    .select()
    .from(campaignDetails)
    .where(eq(campaignDetails.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/** Batch lookup for list views — avoids one query per campaign. */
export async function getCampaignDetailsByCampaignIds(
  campaignIds: string[],
): Promise<Map<string, CampaignDetails>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(campaignDetails)
    .where(inArray(campaignDetails.campaignId, campaignIds));
  return new Map(rows.map((row) => [row.campaignId, row]));
}

/**
 * Insert-or-update the one CampaignDetails row a campaign owns. Every campaign
 * gets one at creation (see routes/campaigns.ts), so this is normally an
 * update in practice — upsert semantics just make the function safe to call
 * unconditionally rather than requiring every caller to check existence first.
 *
 * Throws CampaignLockedError once the campaign has launched (status ACTIVE) —
 * see that class's doc comment.
 */
export async function upsertCampaignDetails(
  campaignId: string,
  data: Omit<Partial<CampaignDetailsInsert>, "id" | "campaignId">,
): Promise<CampaignDetails> {
  await assertCampaignIsDraft(campaignId);
  const rows = await db
    .insert(campaignDetails)
    .values({ campaignId, ...data })
    .onConflictDoUpdate({
      target: campaignDetails.campaignId,
      set: data,
    })
    .returning();
  return rows[0]!;
}
