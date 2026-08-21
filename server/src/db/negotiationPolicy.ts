import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { withDraftLock } from "./campaignDetails.js";
import {
  campaignAuditEvents,
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
    const changedFields = Object.keys(data).sort();

    // Review fix: `data` can legitimately be empty (a PATCH body with no
    // recognized fields, or an already-normalized no-op). Drizzle's
    // `.onConflictDoUpdate({ set: data })` throws "No values to set" when
    // `data` is empty — a real, previously-untested crash path (any client
    // sending an empty-body PATCH to this route hit a raw 500, not a clean
    // no-op). Route empty data through `onConflictDoNothing` instead, which
    // needs no `set` clause; on a genuine conflict (the common case — a
    // policy row already exists) it returns nothing, so the existing row is
    // re-selected explicitly rather than assumed.
    let row: NegotiationPolicy;
    if (changedFields.length > 0) {
      const rows = await tx
        .insert(negotiationPolicies)
        .values({ campaignId, ...data })
        .onConflictDoUpdate({
          target: negotiationPolicies.campaignId,
          set: data,
        })
        .returning();
      row = rows[0]!;

      // PLU-172 (Calvin review): a private-policy edit is audited under the
      // EXISTING POLICY_CHANGED event type (no new enum value needed) — the
      // payload records WHICH fields changed, NEVER their values. This is a
      // privacy boundary, not an oversight: NegotiationPolicy is the one
      // table a creator-facing surface must never read from, and an audit
      // log is exactly the kind of "ordinary log" the ticket's own privacy
      // requirement calls out (docs/plu-172-...-plan.md §10).
      await tx.insert(campaignAuditEvents).values({
        campaignId,
        eventType: "POLICY_CHANGED",
        payload: { changedFields },
      });
    } else {
      const inserted = await tx
        .insert(negotiationPolicies)
        .values({ campaignId })
        .onConflictDoNothing({ target: negotiationPolicies.campaignId })
        .returning();
      row =
        inserted[0] ??
        (await tx.select().from(negotiationPolicies).where(eq(negotiationPolicies.campaignId, campaignId)))[0]!;
      // Nothing changed — nothing to audit.
    }

    return row;
  });
}
