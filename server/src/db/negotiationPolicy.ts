import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { withDraftLock } from "./campaignDetails.js";
import {
  negotiationPolicies,
  type NegotiationPolicy,
  type NegotiationPolicyInsert,
} from "./schema.js";

export async function getNegotiationPolicy(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<NegotiationPolicy | null> {
  const rows = await client
    .select()
    .from(negotiationPolicies)
    .where(eq(negotiationPolicies.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Insert-or-update the one NegotiationPolicy row a campaign owns. Unlike
 * CampaignDetails, not every campaign has one yet — until PLU-136's gap fix
 * this had zero callers anywhere (no route ever wrote to it, which meant
 * validateCompensationReadiness's "explicitly marked non-negotiable" branch
 * was permanently unreachable dead code). Now called from
 * `PATCH /campaigns/:id/negotiation-policy` (routes/campaigns.ts) — still
 * not a full negotiation-policy editor UI, just the API seam.
 *
 * Throws CampaignLockedError once the campaign has launched (status ACTIVE):
 * an in-flight negotiation must never see its bounds change mid-conversation
 * (Calvin review, 2026-08-08) — the frozen copy lives in
 * NegotiationPolicySnapshot from that point on.
 */
export async function upsertNegotiationPolicy(
  campaignId: string,
  data: Omit<Partial<NegotiationPolicyInsert>, "id" | "campaignId">,
  client: Db | DbTx = db,
): Promise<NegotiationPolicy> {
  return withDraftLock(campaignId, client, async (tx) => {
    const rows = await tx
      .insert(negotiationPolicies)
      .values({ campaignId, ...data })
      .onConflictDoUpdate({
        target: negotiationPolicies.campaignId,
        set: data,
      })
      .returning();
    return rows[0]!;
  });
}
