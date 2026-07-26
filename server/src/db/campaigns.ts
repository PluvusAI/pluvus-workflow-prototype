import { count, desc, eq, inArray } from "drizzle-orm";
import { db, type DbTx } from "./drizzle.js";
import {
  brandApprovals,
  brandNotifications,
  campaigns,
  clicks,
  conversationObligations,
  conversions,
  dealHandoffs,
  events,
  executionInstances,
  llmCalls,
  messages,
  obligations,
  outboxJobs,
  partnerships,
  paymentInfo,
  payouts,
  workflows,
  workflowVersions,
  type Campaign,
  type CampaignInsert,
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
  const rows = await db
    .select({ campaign: campaigns, workflowCount: count(workflows.id) })
    .from(campaigns)
    .leftJoin(workflows, eq(workflows.campaignId, campaigns.id))
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

export async function deleteCampaign(id: string): Promise<void> {
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
