import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { isUniqueViolation } from "./errors.js";
import {
  brandApprovals,
  brandIdentities,
  brandNotifications,
  campaignAuditEvents,
  campaignDetails,
  campaignTermsSnapshots,
  campaigns,
  clicks,
  conversationObligations,
  conversions,
  creatorRequirements,
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
  type CampaignDetails,
  type CampaignInsert,
  type CampaignTermsSnapshot,
  type NegotiationPolicy,
  type WorkflowStatus,
} from "./schema.js";

export async function findCampaignById(
  id: string,
  client: Db | DbTx = db,
): Promise<Campaign | null> {
  const rows = await client.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
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
 * PLU-136: every campaign predating the compensation-contract migration has
 * compensationReviewStatus NEEDS_REVIEW only because that's the column
 * default on backfill, never because anyone verified the classification —
 * see CompensationReviewStatus's doc comment in schema.prisma. The actual
 * review UI/queue is PLU-144's job; this is only the launch gate.
 */
export class CompensationReviewPendingError extends Error {
  constructor(id: string) {
    super(
      `Campaign ${id} compensation structure needs operator review (compensationReviewStatus=NEEDS_REVIEW) before it can launch`,
    );
    this.name = "CompensationReviewPendingError";
  }
}

export class CompensationIncompleteError extends Error {
  readonly missing: string[];
  constructor(id: string, missing: string[]) {
    super(`Campaign ${id} compensation terms incomplete for launch: ${missing.join(", ")}`);
    this.name = "CompensationIncompleteError";
    this.missing = missing;
  }
}

/**
 * PLU-136: a policy category is only "handled" if there's either private
 * flexibility bounds set for it, OR it's explicitly marked non-negotiable —
 * "a campaign whose public terms are intended to remain fixed still has a
 * policy explicitly marking the relevant categories non-negotiable," per the
 * compensation-contract spec. `nonNegotiableTerms` had no established shape
 * before this (its own doc comment says nothing in the codebase reads it
 * yet) — this is the first reader, and establishes the convention: an array
 * of category strings ("fee" | "commission" | "gift").
 */
function isMarkedNonNegotiable(
  nonNegotiableTerms: unknown,
  category: "fee" | "commission" | "gift",
): boolean {
  if (!Array.isArray(nonNegotiableTerms)) return false;
  return nonNegotiableTerms.some((t) => typeof t === "string" && t.toLowerCase() === category);
}

/**
 * PLU-136: structure-specific launch-readiness rules. launchCampaign() only
 * checked that CampaignDetails/NegotiationPolicy rows EXIST before this —
 * nothing validated their fields were actually complete for the chosen
 * campaignType. Returns the list of missing requirements (empty = ready).
 *
 *   PAID:      priceStrategy set; publicStartingFeeCents set when
 *              PROPOSE_STARTING_FEE; private fee authority present.
 *   AFFILIATE: publicCommissionRate set; private commission authority
 *              present. Fee fields are NOT required (PLU-129's existing
 *              0/0-is-valid convention for commission-only campaigns).
 *   HYBRID:    both PAID and AFFILIATE rules apply.
 *   GIFT_ONLY: productOrOffer + giftDisposition=KEEP set; private gift
 *              authority present. No fee or commission required.
 *              giftDisposition MUST be KEEP for GIFT_ONLY specifically — the
 *              product IS the entire compensation, so LOAN/RETURN would mean
 *              the creator gets nothing for their work. LOAN/RETURN are only
 *              valid on a structure that also has a fee/commission
 *              component (PAID/AFFILIATE/HYBRID + includesGifting), where
 *              the gift is a bonus on top of real payment, not the payment
 *              itself.
 *   Any structure with includesGifting: also requires productOrOffer +
 *   giftDisposition + private gift authority, on top of its primary rules.
 */
export function validateCompensationReadiness(
  details: CampaignDetails,
  policy: NegotiationPolicy,
): string[] {
  const missing: string[] = [];

  const needsFee = details.campaignType === "PAID" || details.campaignType === "HYBRID";
  const needsCommission =
    details.campaignType === "AFFILIATE" || details.campaignType === "HYBRID";
  const needsGift = details.campaignType === "GIFT_ONLY" || details.includesGifting;

  if (needsFee) {
    if (!details.priceStrategy) missing.push("CampaignDetails.priceStrategy");
    if (details.priceStrategy === "PROPOSE_STARTING_FEE" && details.publicStartingFeeCents == null) {
      missing.push("CampaignDetails.publicStartingFeeCents (required when priceStrategy is PROPOSE_STARTING_FEE)");
    }
    const hasFeeAuthority =
      policy.floorCents != null ||
      policy.ceilingCents != null ||
      isMarkedNonNegotiable(policy.nonNegotiableTerms, "fee");
    if (!hasFeeAuthority) {
      missing.push("NegotiationPolicy fee bounds (floorCents/ceilingCents) or an explicit non-negotiable fee marker");
    }
  }

  if (needsCommission) {
    if (details.publicCommissionRate == null) missing.push("CampaignDetails.publicCommissionRate");
    const hasCommissionAuthority =
      policy.commissionFloorRate != null ||
      policy.commissionCeilingRate != null ||
      isMarkedNonNegotiable(policy.nonNegotiableTerms, "commission");
    if (!hasCommissionAuthority) {
      missing.push("NegotiationPolicy commission bounds (commissionFloorRate/commissionCeilingRate) or an explicit non-negotiable commission marker");
    }
  }

  if (needsGift) {
    if (!details.productOrOffer) missing.push("CampaignDetails.productOrOffer");
    if (!details.giftDisposition) missing.push("CampaignDetails.giftDisposition");
    if (details.campaignType === "GIFT_ONLY" && details.giftDisposition != null && details.giftDisposition !== "KEEP") {
      missing.push(
        "CampaignDetails.giftDisposition must be KEEP for GIFT_ONLY — the product is the entire compensation, so a loaned or returned product would mean no payment at all",
      );
    }
    const hasGiftAuthority =
      policy.giftSubstitutionAllowed != null ||
      policy.giftValueFlexibilityCents != null ||
      isMarkedNonNegotiable(policy.nonNegotiableTerms, "gift");
    if (!hasGiftAuthority) {
      missing.push("NegotiationPolicy gift flexibility fields or an explicit non-negotiable gift marker");
    }
  }

  return missing;
}

/**
 * PLU-140 (2b): the read-only readiness projection GET /campaigns/:id/readiness
 * returns. Deliberately mirrors launchCampaign()'s preconditions EXACTLY, in the
 * same order and with the same semantics, so the review page can never report
 * `ready: true` while POST /launch would 409/422:
 *   - CampaignDetails row must exist   (launch → CampaignDetailsMissingError, 422)
 *   - NegotiationPolicy row must exist (launch → NegotiationPolicyMissingError, 422)
 *   - compensationReviewStatus CONFIRMED (launch → CompensationReviewPendingError, 409)
 *   - validateCompensationReadiness empty (launch → CompensationIncompleteError, 422)
 * Missing rows / unconfirmed review surface as BLOCKERS here rather than throwing
 * — the whole point is to show them up front. Pure: no DB, no throw. `ready` is
 * exactly "POST /launch would succeed".
 */
export interface CampaignReadiness {
  ready: boolean;
  blockers: string[];
  reviewConfirmed: boolean;
  hasPolicy: boolean;
  hasDetails: boolean;
}

export function computeReadiness(
  details: CampaignDetails | null,
  policy: NegotiationPolicy | null,
): CampaignReadiness {
  const hasDetails = details != null;
  const hasPolicy = policy != null;
  const reviewConfirmed = details?.compensationReviewStatus === "CONFIRMED";

  const blockers: string[] = [];
  if (!hasDetails) blockers.push("CampaignDetails row is missing");
  if (!hasPolicy) blockers.push("NegotiationPolicy is missing");
  if (!reviewConfirmed) blockers.push("Compensation review is not confirmed");
  // Field-completeness only makes sense once both rows exist.
  if (hasDetails && hasPolicy) {
    blockers.push(...validateCompensationReadiness(details, policy));
  }

  return { ready: blockers.length === 0, blockers, reviewConfirmed, hasPolicy, hasDetails };
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
    // PLU-136 (1b) step 2: lock the Campaign row FIRST, before reading status.
    // Two near-simultaneous launch calls would otherwise both read DRAFT, both
    // pass every guard below, and both reach the snapshot insert — one wins,
    // one hits a raw 23505 nothing here used to catch. Locking makes the
    // SECOND caller block until the first commits, then re-read ACTIVE and
    // take the idempotent branch below — same pattern as payouts.ts /
    // outboundPacing.ts (`SELECT … FOR UPDATE` via a raw sql fragment,
    // version-independent of the Drizzle client).
    await tx.execute(sql`SELECT "id" FROM "Campaign" WHERE "id" = ${id} FOR UPDATE`);

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
    // Code review note (Ayush, 2026-08-09), reaffirmed by the PLU-136
    // compensation-contract revision: this is unconditional — EVERY campaign
    // must have a NegotiationPolicy to launch, no exceptions, regardless of
    // campaignType. That's correct on purpose, not a placeholder waiting for
    // campaignType to exist (it now does, on CampaignDetails): every
    // structure negotiates SOMETHING (fee, commission, gift terms, or at
    // minimum deliverables/timeline/rights), so a policy row — even one that
    // marks everything explicitly non-negotiable — is always required.
    // validateCompensationReadiness() below is what became "type-aware":
    // it checks the RIGHT fields for the chosen campaignType, not whether a
    // policy exists at all.
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

    // PLU-136: no unverified compensation structure ever reaches ACTIVE — a
    // campaign backfilled by the compensation-contract migration (or any
    // future ambiguous-mapping case) starts NEEDS_REVIEW and stays blocked
    // until an operator confirms it. Checked before field-completeness below
    // since it's a blanket "not yet verified" gate independent of whether
    // the fields happen to already look complete.
    if (details.compensationReviewStatus !== "CONFIRMED") {
      throw new CompensationReviewPendingError(id);
    }

    // PLU-136: structure-specific field completeness — see
    // validateCompensationReadiness's doc comment for the exact rules per
    // campaignType.
    const missingCompensationFields = validateCompensationReadiness(details, policy);
    if (missingCompensationFields.length > 0) {
      throw new CompensationIncompleteError(id, missingCompensationFields);
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

    // Second layer behind the FOR UPDATE lock above (belt and suspenders,
    // same posture as payouts.ts): run the writes in a nested transaction
    // (real SAVEPOINT) so a unique violation here — some other process
    // winning a race the lock should have prevented — can be swallowed
    // without aborting the outer transaction, and we fall through to the
    // same idempotent "return the existing snapshot" behavior as above.
    try {
      const [snapshot] = await tx.transaction(async (tx2) => {
        const [inserted] = await tx2
          .insert(campaignTermsSnapshots)
          .values({
            campaignId: id,
            detailsSnapshot,
            briefExtractionId: confirmedFromExtractionId,
          })
          .returning();

        await tx2.insert(negotiationPolicySnapshots).values({
          campaignId: id,
          floorCents: policy.floorCents,
          ceilingCents: policy.ceilingCents,
          preferredFeeCents: policy.preferredFeeCents,
          commissionFloorRate: policy.commissionFloorRate,
          commissionCeilingRate: policy.commissionCeilingRate,
          preferredCommissionRate: policy.preferredCommissionRate,
          maxRounds: policy.maxRounds,
          openingOfferPosition: policy.openingOfferPosition,
          overCeilingTolerance: policy.overCeilingTolerance,
          negotiationGuidance: policy.negotiationGuidance,
          giftSubstitutionAllowed: policy.giftSubstitutionAllowed,
          giftValueFlexibilityCents: policy.giftValueFlexibilityCents,
          negotiableTerms: policy.negotiableTerms,
          nonNegotiableTerms: policy.nonNegotiableTerms,
        });

        await tx2.update(campaigns).set({ status: "ACTIVE" }).where(eq(campaigns.id, id));
        await tx2.insert(campaignAuditEvents).values({
          campaignId: id,
          eventType: "LAUNCHED",
        });
        await tx2.insert(campaignAuditEvents).values({
          campaignId: id,
          eventType: "SNAPSHOT_CREATED",
          payload: { campaignTermsSnapshotId: inserted!.id },
        });

        return [inserted!];
      });
      return snapshot;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [existing] = await tx
        .select()
        .from(campaignTermsSnapshots)
        .where(eq(campaignTermsSnapshots.campaignId, id))
        .limit(1);
      if (!existing) throw err;
      return existing;
    }
  });
}

export class CampaignNotActiveError extends Error {
  constructor(id: string) {
    super(`Campaign ${id} is not ACTIVE — enroll only after launching it`);
    this.name = "CampaignNotActiveError";
  }
}

export class CampaignSnapshotMissingError extends Error {
  constructor(id: string) {
    super(`Campaign ${id} is ACTIVE but has no CampaignTermsSnapshot — data integrity error`);
    this.name = "CampaignSnapshotMissingError";
  }
}

/**
 * PLU-136 (1b) step 3: the single place enrollment resolves which immutable
 * snapshots a new ExecutionInstance pins to. Every enrollment call site must
 * go through this — not just the one caller today — so a future path (bulk
 * import, API-driven enrollment) can't accidentally skip the ACTIVE check.
 * `negotiationPolicySnapshotId` is typed nullable because the DB column is,
 * but in practice it's always present for a campaign that reached ACTIVE —
 * launchCampaign()'s guard requires NegotiationPolicy unconditionally.
 */
export async function resolveCampaignLaunchContext(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<{
  campaignTermsSnapshotId: string;
  negotiationPolicySnapshotId: string | null;
}> {
  const [campaign] = await client
    .select()
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  if (!campaign) {
    throw new CampaignNotFoundError(campaignId);
  }
  if (campaign.status !== "ACTIVE") {
    throw new CampaignNotActiveError(campaignId);
  }

  const [termsSnapshot] = await client
    .select()
    .from(campaignTermsSnapshots)
    .where(eq(campaignTermsSnapshots.campaignId, campaignId))
    .limit(1);
  if (!termsSnapshot) {
    throw new CampaignSnapshotMissingError(campaignId);
  }

  const [policySnapshot] = await client
    .select()
    .from(negotiationPolicySnapshots)
    .where(eq(negotiationPolicySnapshots.campaignId, campaignId))
    .limit(1);

  return {
    campaignTermsSnapshotId: termsSnapshot.id,
    negotiationPolicySnapshotId: policySnapshot?.id ?? null,
  };
}

/**
 * PLU-136 (1b) step 5: the only way to change material terms on an already-
 * launched (ACTIVE) campaign — the spec's own answer to "brand wants to
 * change the offer after launch" is duplicate into a new DRAFT, never edit
 * the frozen one. Copies the source's execution settings, CampaignDetails
 * (which now includes campaignType and every compensation field — no
 * special-casing needed, they copy along with everything else on that
 * table, except compensationReviewStatus, explicitly reset to NEEDS_REVIEW),
 * NegotiationPolicy, BrandIdentity, and CreatorRequirement (whichever of the
 * latter three actually exist — none are required on a draft). Deliberately
 * copies NOTHING history-shaped: no CampaignTermsSnapshot,
 * NegotiationPolicySnapshot, CampaignBriefExtraction, CampaignBrief,
 * ExecutionInstance, Partnership, or prior audit trail — the new campaign
 * starts genuinely clean and must launch on its own to get its own snapshot.
 */
export async function duplicateCampaign(
  sourceCampaignId: string,
  client: Db | DbTx = db,
): Promise<Campaign> {
  return await client.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, sourceCampaignId))
      .limit(1);
    if (!source) {
      throw new CampaignNotFoundError(sourceCampaignId);
    }

    const [created] = await tx
      .insert(campaigns)
      .values({
        name: source.name,
        brand: source.brand,
        notifyEmail: source.notifyEmail,
        notes: source.notes,
        targetUrl: source.targetUrl,
        hiddenParamKey: source.hiddenParamKey,
        postAcceptanceMode: source.postAcceptanceMode,
        dailyInitialOutreachLimit: source.dailyInitialOutreachLimit,
        outreachPacingMinMinutes: source.outreachPacingMinMinutes,
        outreachPacingMaxMinutes: source.outreachPacingMaxMinutes,
        negotiationReplyPacingMinMinutes: source.negotiationReplyPacingMinMinutes,
        negotiationReplyPacingMaxMinutes: source.negotiationReplyPacingMaxMinutes,
        emailAccountId: source.emailAccountId,
        // status omitted → column default DRAFT. Every duplicate starts as a
        // fresh draft, never inheriting the source's ACTIVE state.
        duplicatedFromCampaignId: sourceCampaignId,
      })
      .returning();
    const duplicate = created!;

    const [sourceDetails] = await tx
      .select()
      .from(campaignDetails)
      .where(eq(campaignDetails.campaignId, sourceCampaignId))
      .limit(1);
    if (sourceDetails) {
      // confirmedFromExtractionId/confirmedAt reset to null — this draft
      // hasn't been confirmed against any extraction of its own yet.
      const { id: _id, campaignId: _cid, confirmedFromExtractionId: _cfei, confirmedAt: _ca, createdAt: _c, updatedAt: _u, ...copyable } =
        sourceDetails;
      await tx.insert(campaignDetails).values({
        campaignId: duplicate.id,
        ...copyable,
        // PLU-136: a duplicate is a new draft with its own terms to
        // re-verify, never an inherited confirmation — reset even if the
        // source was already CONFIRMED.
        compensationReviewStatus: "NEEDS_REVIEW",
      });
    }

    const [sourcePolicy] = await tx
      .select()
      .from(negotiationPolicies)
      .where(eq(negotiationPolicies.campaignId, sourceCampaignId))
      .limit(1);
    if (sourcePolicy) {
      const { id: _id, campaignId: _cid, createdAt: _c, updatedAt: _u, ...copyable } = sourcePolicy;
      await tx.insert(negotiationPolicies).values({ campaignId: duplicate.id, ...copyable });
    }

    const [sourceIdentity] = await tx
      .select()
      .from(brandIdentities)
      .where(eq(brandIdentities.campaignId, sourceCampaignId))
      .limit(1);
    if (sourceIdentity) {
      const { id: _id, campaignId: _cid, createdAt: _c, updatedAt: _u, ...copyable } = sourceIdentity;
      await tx.insert(brandIdentities).values({ campaignId: duplicate.id, ...copyable });
    }

    const [sourceRequirement] = await tx
      .select()
      .from(creatorRequirements)
      .where(eq(creatorRequirements.campaignId, sourceCampaignId))
      .limit(1);
    if (sourceRequirement) {
      const { id: _id, campaignId: _cid, createdAt: _c, updatedAt: _u, ...copyable } = sourceRequirement;
      await tx.insert(creatorRequirements).values({ campaignId: duplicate.id, ...copyable });
    }

    await tx.insert(campaignAuditEvents).values({
      campaignId: sourceCampaignId,
      eventType: "DUPLICATED",
      payload: { newCampaignId: duplicate.id },
    });

    return duplicate;
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
