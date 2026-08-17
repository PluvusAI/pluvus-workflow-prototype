import { eq, inArray } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
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

// Exported so the sibling draft-only tables (BrandIdentity, CreatorRequirement)
// reuse the ONE guard rather than re-implementing the status check (PLU-139 2a).
//
// MUST run inside a transaction that also performs the section write (see
// withDraftLock): the SELECT ... FOR UPDATE takes the SAME Campaign-row lock
// launchCampaign() takes, so a concurrent launch either (a) holds the lock and
// commits ACTIVE before we read — we then see ACTIVE and throw, or (b) blocks
// behind us until our write commits. Without the lock + shared transaction the
// status read and the write are two statements a launch can interleave between,
// letting a write land on an already-launched campaign.
export async function assertCampaignIsDraft(campaignId: string, tx: Db | DbTx): Promise<void> {
  const [campaign] = await tx
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .for("update")
    .limit(1);
  if (campaign?.status === "ACTIVE") {
    throw new CampaignLockedError(campaignId);
  }
}

/**
 * Run `write` atomically with the draft-status check, holding the Campaign-row
 * lock across both so a concurrent launchCampaign() cannot flip the campaign to
 * ACTIVE between them (see assertCampaignIsDraft). Opens a transaction; nested
 * on an existing tx (drizzle savepoint) so it composes inside a caller's tx.
 * The three draft-only upserts (CampaignDetails, BrandIdentity, CreatorRequirement)
 * all route through this so the lock lives in ONE place.
 */
export async function withDraftLock<T>(
  campaignId: string,
  client: Db | DbTx,
  write: (tx: Db | DbTx) => Promise<T>,
): Promise<T> {
  return client.transaction(async (tx) => {
    await assertCampaignIsDraft(campaignId, tx);
    return write(tx);
  });
}

export async function getCampaignDetails(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignDetails | null> {
  const rows = await client
    .select()
    .from(campaignDetails)
    .where(eq(campaignDetails.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/** Batch lookup for list views — avoids one query per campaign. */
export async function getCampaignDetailsByCampaignIds(
  campaignIds: string[],
  client: Db | DbTx = db,
): Promise<Map<string, CampaignDetails>> {
  if (campaignIds.length === 0) return new Map();
  const rows = await client
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
  client: Db | DbTx = db,
): Promise<CampaignDetails> {
  return withDraftLock(campaignId, client, async (tx) => {
    const rows = await tx
      .insert(campaignDetails)
      .values({ campaignId, ...data })
      .onConflictDoUpdate({
        target: campaignDetails.campaignId,
        set: data,
      })
      .returning();
    return rows[0]!;
  });
}
