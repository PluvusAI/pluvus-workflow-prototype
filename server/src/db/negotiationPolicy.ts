import { eq } from "drizzle-orm";
import { db } from "./drizzle.js";
import { CampaignLockedError } from "./campaignDetails.js";
import {
  campaigns,
  negotiationPolicies,
  type NegotiationPolicy,
  type NegotiationPolicyInsert,
} from "./schema.js";

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

export async function getNegotiationPolicy(
  campaignId: string,
): Promise<NegotiationPolicy | null> {
  const rows = await db
    .select()
    .from(negotiationPolicies)
    .where(eq(negotiationPolicies.campaignId, campaignId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Insert-or-update the one NegotiationPolicy row a campaign owns. Unlike
 * CampaignDetails, not every campaign has one yet (no route creates one
 * automatically) — this is the entry point for whichever later issue wires up
 * a negotiation-policy editor.
 *
 * Throws CampaignLockedError once the campaign has launched (status ACTIVE):
 * an in-flight negotiation must never see its bounds change mid-conversation
 * (Calvin review, 2026-08-08) — the frozen copy lives in
 * NegotiationPolicySnapshot from that point on.
 */
export async function upsertNegotiationPolicy(
  campaignId: string,
  data: Omit<Partial<NegotiationPolicyInsert>, "id" | "campaignId">,
): Promise<NegotiationPolicy> {
  await assertCampaignIsDraft(campaignId);
  const rows = await db
    .insert(negotiationPolicies)
    .values({ campaignId, ...data })
    .onConflictDoUpdate({
      target: negotiationPolicies.campaignId,
      set: data,
    })
    .returning();
  return rows[0]!;
}
