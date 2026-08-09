import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import {
  brandApprovals,
  brandNotifications,
  campaignAuditEvents,
  campaignDetails,
  campaignTermsSnapshots,
  campaigns,
  clicks,
  conversationObligations,
  conversions,
  dealHandoffs,
  events,
  executionInstances,
  llmCalls,
  messages,
  negotiationPolicies,
  negotiationPolicySnapshots,
  obligations,
  outboxJobs,
  partnerships,
  paymentInfo,
  payouts,
  workflows,
  workflowVersions,
  type Campaign,
  type CampaignInsert,
  type CampaignTermsSnapshot,
  type WorkflowStatus,
} from "./schema.js";

export async function findCampaignById(id: string): Promise<Campaign | null> {
  const rows = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listCampaigns(): Promise<
  (Campaign & { _count: { workflows: number } })[]
> {
  // Prisma's include._count, expressed as a LEFT JOIN + GROUP BY on the pk.
  // PLU-135 (1a): excludes archived campaigns — deleteCampaign() archives
  // rather than deletes a launched campaign, so this filter is what keeps
  // them out of the normal browse list. Direct lookup by id (findCampaignById)
  // is deliberately unaffected.
  const rows = await db
    .select({ campaign: campaigns, workflowCount: count(workflows.id) })
    .from(campaigns)
    .leftJoin(workflows, eq(workflows.campaignId, campaigns.id))
    .where(isNull(campaigns.archivedAt))
    .groupBy(campaigns.id)
    .orderBy(desc(campaigns.createdAt));
  return rows.map((r) => ({ ...r.campaign, _count: { workflows: r.workflowCount } }));
}

export async function createCampaign(data: CampaignInsert): Promise<Campaign> {
  const rows = await db.insert(campaigns).values(data).returning();
  return rows[0]!;
}

export async function updateCampaign(
  id: string,
  data: Partial<CampaignInsert>,
): Promise<Campaign> {
  const rows = await db
    .update(campaigns)
    .set(data)
    .where(eq(campaigns.id, id))
    .returning();
  const updated = rows[0];
  if (!updated) {
    // Prisma threw P2025 here; callers resolve the campaign first.
    throw new Error(`Campaign ${id} not found`);
  }
  return updated;
}

/**
 * Delete every row that hangs off the given execution instances, then the
 * instances themselves — in foreign-key-safe order — inside the caller's
 * transaction. Extracted from deleteCampaign so the P8 harness-cleanup script
 * (scripts/cleanHarnessData.ts) purges test instances through the EXACT same
 * ordering; keeping one implementation means the two can't drift and re-open
 * the foreign-key violations this ordering was written to avoid.
 *
 * No-op when `instanceIds` is empty. Order (children → parents):
 *   Event, Message, BrandNotification, PaymentInfo  (direct instanceId FK)
 *   → Click/Conversion/Obligation/Payout            (via the instance's Partnership)
 *   → Partnership → ExecutionInstance
 */
export async function deleteInstanceCascade(
  tx: DbTx,
  instanceIds: string[],
): Promise<void> {
  if (instanceIds.length === 0) return;
  // Delete ALL rows that reference an instance before the instances themselves,
  // or the executionInstances delete hits a foreign-key violation. Besides
  // Event/Message, later phases added BrandNotification and PaymentInfo — each
  // with an instanceId FK — so they must be cleaned up here too (omitting them
  // was what broke campaign deletion).
  // PLU-70 DealHandoff + PLU-111 ConversationObligation each carry an instanceId
  // FK with NO ON DELETE rule, so an instance that reached ACCEPTED (handoff) or
  // ran any negotiation (obligations) blocks the executionInstances DELETE below
  // with a foreign-key violation — the 500 that broke campaign deletion once a run
  // produced either. Delete them FIRST: ConversationObligation ALSO references
  // Message (sourceMessageId / resolutionMessageId, no ON DELETE rule), so it must
  // be gone BEFORE the messages delete below or that delete FK-violates in turn.
  await tx.delete(dealHandoffs).where(inArray(dealHandoffs.instanceId, instanceIds));
  // Brand-approval gate (PLU-117): BrandApproval carries a UNIQUE instanceId FK
  // with no ON DELETE rule, so any instance that reached ACCEPTED under the gate
  // (AWAITING_BRAND_APPROVAL / approved / rejected) blocks the executionInstances
  // DELETE below — the same 500 DealHandoff/ConversationObligation caused. Purge
  // it here alongside the other post-acceptance snapshots.
  await tx.delete(brandApprovals).where(inArray(brandApprovals.instanceId, instanceIds));
  await tx
    .delete(conversationObligations)
    .where(inArray(conversationObligations.instanceId, instanceIds));
  await tx.delete(events).where(inArray(events.instanceId, instanceIds));
  await tx.delete(messages).where(inArray(messages.instanceId, instanceIds));
  await tx.delete(outboxJobs).where(inArray(outboxJobs.instanceId, instanceIds));
  await tx
    .delete(brandNotifications)
    .where(inArray(brandNotifications.instanceId, instanceIds));
  await tx.delete(paymentInfo).where(inArray(paymentInfo.instanceId, instanceIds));
  // HARD-O1 LlmCall carries an instanceId FK (no ON DELETE rule); a nullable FK
  // still blocks the parent delete while rows reference it, so any instance that
  // made an LLM call (every negotiated run) must have its telemetry purged here.
  await tx.delete(llmCalls).where(inArray(llmCalls.instanceId, instanceIds));
  // Attribution/payout ledger (Phase 2–4) hangs off the instance's Partnership,
  // not the instance directly. clicks/conversions/obligations/payouts all carry
  // a partnershipId FK, so they MUST be deleted before the partnerships
  // themselves or the partnerships DELETE hits a foreign-key violation (this is
  // what 500'd campaign deletion once a hybrid run completed and minted a
  // Partnership + fee Obligation). Scope by the partnership ids belonging to
  // these instances.
  const partnershipRows = await tx
    .select({ id: partnerships.id })
    .from(partnerships)
    .where(inArray(partnerships.instanceId, instanceIds));
  const partnershipIds = partnershipRows.map((p) => p.id);
  if (partnershipIds.length > 0) {
    await tx.delete(clicks).where(inArray(clicks.partnershipId, partnershipIds));
    await tx
      .delete(conversions)
      .where(inArray(conversions.partnershipId, partnershipIds));
    await tx
      .delete(obligations)
      .where(inArray(obligations.partnershipId, partnershipIds));
    await tx.delete(payouts).where(inArray(payouts.partnershipId, partnershipIds));
  }
  await tx.delete(partnerships).where(inArray(partnerships.instanceId, instanceIds));
  await tx
    .delete(executionInstances)
    .where(inArray(executionInstances.id, instanceIds));
}

/**
 * PLU-135 (1a) code-review fix (Ayush): launchCampaign()'s precondition
 * failures are real, actionable, user-facing states (fix your campaign, then
 * retry) — not internal errors. Typed so routes/campaigns.ts can map them to
 * a real 4xx instead of every failure path collapsing into a generic 500.
 */
export class CampaignNotFoundError extends Error {
  constructor(id: string) {
    super(`Campaign ${id} not found`);
    this.name = "CampaignNotFoundError";
  }
}

export class CampaignDetailsMissingError extends Error {
  constructor(id: string) {
    super(`Campaign ${id} has no CampaignDetails to snapshot`);
    this.name = "CampaignDetailsMissingError";
  }
}

export class NegotiationPolicyMissingError extends Error {
  constructor(id: string) {
    super(
      `Campaign ${id} has no NegotiationPolicy — cannot launch without negotiation bounds`,
    );
    this.name = "NegotiationPolicyMissingError";
  }
}

/**
 * PLU-135 (1a): THE launch transition — Draft → Active. Creates the ONE
 * immutable CampaignTermsSnapshot and NegotiationPolicySnapshot this campaign
 * will ever have (Calvin review, 2026-08-08: never at enrollment, which could
 * already be too late — conversations may already be in flight against live
 * data by then). After this call, campaignDetails/negotiationPolicies are
 * locked read-only (enforced in their own upsert functions, not here) — a
 * material change means duplicating into a new campaign, never editing this
 * one. Idempotent: launching an already-ACTIVE campaign is a no-op that
 * returns the existing snapshot rather than erroring or duplicating.
 */
export async function launchCampaign(
  id: string,
  client: Db | DbTx = db,
): Promise<CampaignTermsSnapshot> {
  return await client.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);
    if (!campaign) {
      throw new CampaignNotFoundError(id);
    }

    if (campaign.status === "ACTIVE") {
      const [existing] = await tx
        .select()
        .from(campaignTermsSnapshots)
        .where(eq(campaignTermsSnapshots.campaignId, id))
        .limit(1);
      if (!existing) {
        // Should be unreachable — status flips to ACTIVE only inside this same
        // transaction, alongside the snapshot insert below. Fail loud rather
        // than silently re-launching if it ever happens.
        throw new Error(`Campaign ${id} is ACTIVE but has no CampaignTermsSnapshot`);
      }
      return existing;
    }

    const [details] = await tx
      .select()
      .from(campaignDetails)
      .where(eq(campaignDetails.campaignId, id))
      .limit(1);
    // detailsSnapshot always has a row to copy — every campaign gets a
    // CampaignDetails row at creation (routes/campaigns.ts) or via the 1a
    // migration's backfill. An absent row is a data-integrity bug, not a
    // valid empty-draft state, so this fails loud instead of snapshotting {}.
    if (!details) {
      throw new CampaignDetailsMissingError(id);
    }

    // Schema review §2.3 (Calvin, 2026-08-08): refuse to launch without a
    // NegotiationPolicy row, checked BEFORE any write below. Without this, a
    // campaign could go permanently Active with no fee bounds at all — and
    // because launch is one-way, campaign duplication would be the only fix.
    // Failing here instead leaves the campaign in Draft, still fixable.
    //
    // Code review note (Ayush, 2026-08-09): this is unconditional — EVERY
    // campaign must have a NegotiationPolicy to launch, no exceptions. That's
    // correct for today's product, where every workflow template has a
    // negotiation node and every campaign negotiates; there's no "fixed /
    // non-negotiated" campaign type yet for this to wrongly block. Both the
    // 1a and 1b tickets do mention that type as future work, though — once it
    // exists, this check will need to become type-aware (skip the guard for a
    // campaign that was never meant to negotiate) rather than staying a blanket
    // requirement. Not a problem today; just don't read this as permanent.
    //
    // Also worth naming: this guard cannot currently be satisfied by ANY
    // campaign, because nothing populates NegotiationPolicy yet.
    // upsertNegotiationPolicy (negotiationPolicy.ts) has zero callers — no
    // DRAFT-time policy editor exists — while the negotiation bounds actually
    // in live use today (floor/ceiling/rounds) still live in the workflow
    // node's config and are read via resolveBand() by negotiation.ts, the
    // output guard, providers.ts, and the accept-path executors. Bridging that
    // old (node-config) source into this new (campaign-level) one is Issue
    // 1c/1d's job, not this one — this guard is correct as written, it just
    // has nothing to satisfy it until that bridge is built.
    const [policy] = await tx
      .select()
      .from(negotiationPolicies)
      .where(eq(negotiationPolicies.campaignId, id))
      .limit(1);
    if (!policy) {
      throw new NegotiationPolicyMissingError(id);
    }

    // Schema review §2.1: the snapshot's fallback pointer is whichever
    // extraction these details were actually CONFIRMED from (set by whoever
    // reviewed the AI's parse), never "the newest extraction for the
    // campaign" — a brief re-uploaded after confirmation but before launch
    // must not silently swap the fallback source underneath the confirmed
    // terms. Nullable: a campaign typed by hand with no PDF is normal, and a
    // confirmedFromExtractionId left unset behaves the same way — no fallback
    // pointer, not an error.
    const {
      id: _detailsId,
      campaignId: _detailsCampaignId,
      confirmedFromExtractionId,
      confirmedAt: _detailsConfirmedAt,
      createdAt: _dc,
      updatedAt: _du,
      ...detailsSnapshot
    } = details;

    const [snapshot] = await tx
      .insert(campaignTermsSnapshots)
      .values({
        campaignId: id,
        detailsSnapshot,
        briefExtractionId: confirmedFromExtractionId,
      })
      .returning();

    await tx.insert(negotiationPolicySnapshots).values({
      campaignId: id,
      floorCents: policy.floorCents,
      ceilingCents: policy.ceilingCents,
      preferredFeeCents: policy.preferredFeeCents,
      commissionRate: policy.commissionRate,
      maxRounds: policy.maxRounds,
      openingOfferPosition: policy.openingOfferPosition,
      overCeilingTolerance: policy.overCeilingTolerance,
      negotiationGuidance: policy.negotiationGuidance,
      negotiableTerms: policy.negotiableTerms,
      nonNegotiableTerms: policy.nonNegotiableTerms,
    });

    await tx.update(campaigns).set({ status: "ACTIVE" }).where(eq(campaigns.id, id));
    await tx.insert(campaignAuditEvents).values({
      campaignId: id,
      eventType: "LAUNCHED",
    });
    await tx.insert(campaignAuditEvents).values({
      campaignId: id,
      eventType: "SNAPSHOT_CREATED",
      payload: { campaignTermsSnapshotId: snapshot!.id },
    });

    return snapshot!;
  });
}

/**
 * PLU-135 (1a): a launched campaign (Campaign.status === "ACTIVE") is never
 * hard-deleted — its CampaignTermsSnapshot, and everything RESTRICT-tied to
 * it (briefs, audit events, pinned executions), is retained for historical
 * recordkeeping per this project's "never lose the snapshot" invariant. This
 * archives instead: `archivedAt` is stamped, nothing underneath is touched,
 * and listCampaigns() stops surfacing it. A DRAFT campaign has no history
 * worth protecting, so it still hard-deletes exactly as before.
 */
export async function deleteCampaign(id: string): Promise<void> {
  const campaign = await findCampaignById(id);
  if (!campaign) {
    throw new Error(`Campaign ${id} not found`);
  }

  if (campaign.status === "ACTIVE") {
    await db.transaction(async (tx) => {
      await tx
        .update(campaigns)
        .set({ archivedAt: new Date() })
        .where(and(eq(campaigns.id, id), isNull(campaigns.archivedAt)));
      await tx.insert(campaignAuditEvents).values({
        campaignId: id,
        eventType: "ARCHIVED",
      });
    });
    return;
  }

  // W-7: the whole cascade runs in ONE transaction. Previously each DELETE was a
  // separate statement, so a crash partway through left orphaned rows (e.g.
  // instances deleted but their workflow/campaign still present, or events
  // deleted while the instances they belonged to survived) — an inconsistent
  // graph that no later delete would clean up. Wrapping it means the campaign and
  // every dependent row disappear together or not at all.
  await db.transaction(async (tx) => {
    // Delete all dependent records first (cascade order).
    const wfRows = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.campaignId, id));
    const workflowIds = wfRows.map((w) => w.id);

    if (workflowIds.length > 0) {
      const versionRows = await tx
        .select({ id: workflowVersions.id })
        .from(workflowVersions)
        .where(inArray(workflowVersions.workflowId, workflowIds));
      const versionIds = versionRows.map((v) => v.id);

      const instanceRows =
        versionIds.length > 0
          ? await tx
              .select({ id: executionInstances.id })
              .from(executionInstances)
              .where(inArray(executionInstances.workflowVersionId, versionIds))
          : [];
      const instanceIds = instanceRows.map((i) => i.id);

      await deleteInstanceCascade(tx, instanceIds);

      if (versionIds.length > 0) {
        await tx
          .delete(workflowVersions)
          .where(inArray(workflowVersions.workflowId, workflowIds));
      }
      await tx.delete(workflows).where(inArray(workflows.id, workflowIds));
    }

    // CampaignDetails/NegotiationPolicy/BrandIdentity/CreatorRequirement all
    // cascade-delete with Campaign at the database level (they're draft state,
    // not history) — no explicit cleanup needed here.
    await tx.delete(campaigns).where(eq(campaigns.id, id));
  });
}

export async function getCampaignWithWorkflows(id: string): Promise<
  | (Campaign & {
      workflows: Array<{
        id: string;
        name: string;
        status: WorkflowStatus;
        createdAt: Date;
        updatedAt: Date;
        _count: { versions: number };
      }>;
    })
  | null
> {
  const campaign = await findCampaignById(id);
  if (!campaign) return null;

  const wfRows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      status: workflows.status,
      createdAt: workflows.createdAt,
      updatedAt: workflows.updatedAt,
      versionCount: count(workflowVersions.id),
    })
    .from(workflows)
    .leftJoin(workflowVersions, eq(workflowVersions.workflowId, workflows.id))
    .where(eq(workflows.campaignId, id))
    .groupBy(workflows.id)
    .orderBy(desc(workflows.createdAt));

  return {
    ...campaign,
    workflows: wfRows.map(({ versionCount, ...w }) => ({
      ...w,
      _count: { versions: versionCount },
    })),
  };
}
