// PLU-142 [3b] — Snapshot Mismatch Protection & Safe Fallback.
//
// The single authoritative service that sits in front of CampaignBrief
// retrieval and decides CURRENT / REGENERATING / BLOCKED — the thing PLU-141
// explicitly left out of scope. Before this file, retrieval just asked "what's
// the current READY row for this campaignId," full stop: no explicit
// snapshot-identity check, no mismatch categorization, no auto-regeneration
// trigger, and no creator-journey (instance) awareness.
//
// This file NEVER reads CampaignDetails, NegotiationPolicy, or
// WorkflowVersion.nodeGraph as a DATA source, and never falls back to an
// older brief as one either — an older/stale row is only ever a FACT
// ("something existed before"), never a value source. See
// docs/plu-142-snapshot-mismatch-protection-plan.md §1/§2 for the full
// reasoning this module implements.
import { eq } from "drizzle-orm";
import { db, type Db, type DbTx } from "./drizzle.js";
import { findCampaignById, resolveCampaignLaunchContext } from "./campaigns.js";
import { findInstanceById } from "./instances.js";
import {
  createOrGetCampaignBriefRenderRequest,
  getCurrentReadyCampaignBrief,
  getLatestCampaignBriefForCampaign,
} from "./campaignBriefRender.js";
import { enqueueCampaignBriefRender } from "../workers/queues.js";
import { logTrace } from "../observability/logger.js";
import { workflowVersions, workflows, type CampaignBrief } from "./schema.js";

export type CampaignBriefMismatchCategory =
  | "NO_CAMPAIGN" // expected campaign no longer exists (or isn't resolvable — see below)
  | "NO_PINNED_SNAPSHOT" // instance path only: no campaignTermsSnapshotId pinned
  | "NO_CURRENT_BRIEF" // nothing has ever rendered for this campaign
  | "CROSS_CAMPAIGN" // candidate.campaignId !== expected (should be unreachable)
  | "SNAPSHOT_MISMATCH" // candidate.campaignTermsSnapshotId !== expected (should be unreachable today, §0)
  | "ASSET_UNAVAILABLE" // candidate exists but FAILED, or READY with no renderedAssetRef
  | "DATA_INCOMPLETE"; // the worker's own classification for a blocked regeneration render — this module never sets it itself (see resolveAgainstExpectedSnapshot's catch), kept in the union so a caller can pattern-match the FULL space a CampaignBrief.errorCategory can reach.

export interface CampaignBriefValidationResult {
  /** "current asset" — `brief` is set only when status === "CURRENT". */
  status: "CURRENT" | "REGENERATING" | "BLOCKED";
  brief: CampaignBrief | null;
  expected: { campaignId: string; campaignTermsSnapshotId: string | null };
  stored: { campaignId: string | null; campaignTermsSnapshotId: string | null };
  mismatchCategory: CampaignBriefMismatchCategory | null;
  regenerationAllowed: boolean;
  /** Short, stable, machine-checkable: "serve_current" | "poll_for_ready" | "operator_review_required". */
  nextAction: string;
  /** Operator-safe human-readable detail — no NegotiationPolicy values, no raw creator-access token, ever. */
  diagnostic: string;
}

function emitValidationResult(
  campaignId: string,
  expectedSnapshotId: string | null,
  candidateBriefId: string | null,
  result: CampaignBriefValidationResult,
): void {
  logTrace("campaign_brief_validation_result", {
    campaignId,
    expectedSnapshotId,
    candidateBriefId,
    storedSnapshotId: result.stored.campaignTermsSnapshotId,
    status: result.status,
    mismatchCategory: result.mismatchCategory,
  });
}

/**
 * The shared comparison + regeneration-trigger core. Not exported —
 * campaign-scoped and instance-scoped callers both funnel through this so
 * there is exactly ONE place the current-document rule is implemented, per
 * the ticket's own "do not repeat the comparison independently" line.
 *
 * The current-document rule (plan §1): a CampaignBrief row is CURRENT for
 * `expectedSnapshotId` when the campaign-scoped current-READY row (1) has
 * the SAME campaignId (structurally guaranteed by the query below — checked
 * explicitly anyway, not assumed), (2) has the SAME campaignTermsSnapshotId,
 * and (3) has a renderedAssetRef. Anything else is "not current" — this
 * function categorizes WHY, then tries to fix it via regeneration (never by
 * falling back to a different snapshot/row/table), and returns one of the
 * three outcomes CURRENT/REGENERATING/BLOCKED this function alone owns.
 */
async function resolveAgainstExpectedSnapshot(
  campaignId: string,
  expectedSnapshotId: string,
  client: Db | DbTx,
): Promise<CampaignBriefValidationResult> {
  const expected = { campaignId, campaignTermsSnapshotId: expectedSnapshotId };

  const candidate = await getCurrentReadyCampaignBrief(campaignId, client);
  if (
    candidate &&
    candidate.campaignId === campaignId &&
    candidate.campaignTermsSnapshotId === expectedSnapshotId &&
    candidate.renderedAssetRef
  ) {
    const result: CampaignBriefValidationResult = {
      status: "CURRENT",
      brief: candidate,
      expected,
      stored: {
        campaignId: candidate.campaignId,
        campaignTermsSnapshotId: candidate.campaignTermsSnapshotId,
      },
      mismatchCategory: null,
      regenerationAllowed: false,
      nextAction: "serve_current",
      diagnostic: "the current READY brief matches the expected snapshot",
    };
    emitValidationResult(campaignId, expectedSnapshotId, candidate.id, result);
    return result;
  }

  // Not current — categorize, then try to fix it via regeneration.
  let category: CampaignBriefMismatchCategory;
  let stored: { campaignId: string | null; campaignTermsSnapshotId: string | null };
  let candidateBriefId: string | null = null;

  if (candidate) {
    // A READY, un-superseded row exists for this campaign but failed the
    // CURRENT check above — since getCurrentReadyCampaignBrief() itself
    // filters WHERE campaignId = campaignId, candidate.campaignId !==
    // campaignId is structurally impossible through this query; checked
    // explicitly anyway (the ticket's own "do not assume" posture), so this
    // branch is really always SNAPSHOT_MISMATCH in practice.
    category = candidate.campaignId !== campaignId ? "CROSS_CAMPAIGN" : "SNAPSHOT_MISMATCH";
    stored = {
      campaignId: candidate.campaignId,
      campaignTermsSnapshotId: candidate.campaignTermsSnapshotId,
    };
    candidateBriefId = candidate.id;
  } else {
    // No current READY row. A secondary read distinguishes "nothing has
    // ever rendered" from "something exists but isn't currently servable"
    // (FAILED, still GENERATING, or a stray READY row missing its asset
    // ref) so the diagnostic can say WHY, not just "nothing."
    const latest = await getLatestCampaignBriefForCampaign(campaignId, client);
    if (!latest) {
      category = "NO_CURRENT_BRIEF";
      stored = { campaignId: null, campaignTermsSnapshotId: null };
    } else {
      category = "ASSET_UNAVAILABLE";
      stored = { campaignId: latest.campaignId, campaignTermsSnapshotId: latest.campaignTermsSnapshotId };
      candidateBriefId = latest.id;
    }
  }

  // Regeneration — deterministic renderRequestId so concurrent validators
  // (including one that lands while a matching regeneration is already
  // GENERATING) collapse into ONE row/job, reusing
  // createOrGetCampaignBriefRenderRequest's own idempotency — no new
  // locking needed.
  const renderRequestId = `auto-regen|${campaignId}|${expectedSnapshotId}`;
  try {
    const { campaignBrief } = await createOrGetCampaignBriefRenderRequest(
      campaignId,
      renderRequestId,
      client,
    );
    // Same status-gated re-enqueue as the POST route (Calvin review #4):
    // safe to call unconditionally for a row that already has a job running
    // — enqueueCampaignBriefRender()'s jobId is deterministic
    // (`brief-render|${campaignBriefId}`) and BullMQ dedupes on it.
    if (campaignBrief.status === "GENERATING") {
      await enqueueCampaignBriefRender({ campaignBriefId: campaignBrief.id });
    }
    const result: CampaignBriefValidationResult = {
      status: "REGENERATING",
      brief: null,
      expected,
      stored,
      mismatchCategory: category,
      regenerationAllowed: true,
      nextAction: "poll_for_ready",
      diagnostic: `no current brief matches the expected snapshot (${category}); regeneration ${
        campaignBrief.status === "GENERATING" ? "enqueued" : `already ${campaignBrief.status.toLowerCase()}`
      }`,
    };
    logTrace("campaign_brief_regeneration_requested", {
      campaignId,
      expectedSnapshotId,
      campaignBriefId: campaignBrief.id,
      mismatchCategory: category,
    });
    emitValidationResult(campaignId, expectedSnapshotId, candidateBriefId, result);
    return result;
  } catch (err) {
    // Only reachable if createOrGetCampaignBriefRenderRequest's OWN
    // launch-context check fails (CampaignNotActiveError /
    // CampaignSnapshotMissingError) or its renderRequestId collides across
    // campaigns (CampaignBriefRenderRequestConflictError) — i.e. material
    // data genuinely isn't launchable, not a transient issue. This is a
    // synchronous check only; the DATA_INCOMPLETE category (a snapshot that
    // IS launchable but missing a required field) is the render WORKER's
    // own classification, discovered later inside the actual async render —
    // never something this function can observe, so it is never fabricated
    // here. `category` (the pre-regeneration mismatch reason) is preserved
    // as-is; `diagnostic` carries the real thrown reason.
    const diagnostic = err instanceof Error ? err.message : String(err);
    const result: CampaignBriefValidationResult = {
      status: "BLOCKED",
      brief: null,
      expected,
      stored,
      mismatchCategory: category,
      regenerationAllowed: false,
      nextAction: "operator_review_required",
      diagnostic,
    };
    logTrace("campaign_brief_regeneration_blocked", {
      campaignId,
      expectedSnapshotId,
      mismatchCategory: category,
      reason: diagnostic,
    });
    emitValidationResult(campaignId, expectedSnapshotId, candidateBriefId, result);
    return result;
  }
}

/**
 * Campaign-scoped — no specific creator in view. Used by the operator
 * preview/send-review route (`GET /campaigns/:id/brief/pdf`) and — scoped
 * down, see the module-level note on `resolveCurrentCampaignBriefForInstance`
 * — the creator-facing token route, whose row already carries campaignId.
 *
 * The "expected" snapshot for a campaign is simply the campaign's own
 * (permanent — §0: a campaign can only ever have ONE CampaignTermsSnapshot,
 * for its whole life) snapshot, resolved the same way every other
 * snapshot-reading call site in this codebase already does
 * (`resolveCampaignLaunchContext`, reused not reinvented).
 */
export async function resolveCurrentCampaignBriefForCampaign(
  campaignId: string,
  client: Db | DbTx = db,
): Promise<CampaignBriefValidationResult> {
  const campaign = await findCampaignById(campaignId, client);
  if (!campaign) {
    const result: CampaignBriefValidationResult = {
      status: "BLOCKED",
      brief: null,
      expected: { campaignId, campaignTermsSnapshotId: null },
      stored: { campaignId: null, campaignTermsSnapshotId: null },
      mismatchCategory: "NO_CAMPAIGN",
      regenerationAllowed: false,
      nextAction: "operator_review_required",
      diagnostic: `campaign ${campaignId} does not exist`,
    };
    emitValidationResult(campaignId, null, null, result);
    return result;
  }

  try {
    const { campaignTermsSnapshotId } = await resolveCampaignLaunchContext(campaignId, client);
    return await resolveAgainstExpectedSnapshot(campaignId, campaignTermsSnapshotId, client);
  } catch (err) {
    // The campaign exists but isn't ACTIVE, or is ACTIVE with no resolvable
    // snapshot (a data-integrity gap) — there is no snapshot to validate a
    // brief against. Reuses the NO_CAMPAIGN category (closest fit: "nothing
    // to validate") with the real reason carried in `diagnostic`.
    const diagnostic = err instanceof Error ? err.message : String(err);
    const result: CampaignBriefValidationResult = {
      status: "BLOCKED",
      brief: null,
      expected: { campaignId, campaignTermsSnapshotId: null },
      stored: { campaignId: null, campaignTermsSnapshotId: null },
      mismatchCategory: "NO_CAMPAIGN",
      regenerationAllowed: false,
      nextAction: "operator_review_required",
      diagnostic,
    };
    emitValidationResult(campaignId, null, null, result);
    return result;
  }
}

/**
 * Instance-scoped — resolves the creator's ExecutionInstance, loads ITS
 * pinned campaignTermsSnapshotId (not just "the campaign's current one" —
 * the ticket's own distinction), then delegates to the same core. Built as
 * a ready seam for PLU-143 (Content Brief convergence) — nothing in THIS
 * ticket's routes call it yet, since nothing in this codebase currently
 * attaches a rendered CampaignBrief to a creator-facing send at all. Tested
 * directly (see db/campaignBriefValidation.db.test.ts).
 *
 * Steps 1–2 (the ticket's "resolve the creator Partnership/Execution; load
 * its pinned snapshot"): findInstanceById() (reused, already exists) →
 * instance.campaignTermsSnapshotId (the pin — null means NO_PINNED_SNAPSHOT,
 * a real BLOCKED result, not a crash) → campaignId resolved via the same
 * executionInstances → workflowVersions → workflows join paymentInfo.ts
 * already establishes as this codebase's canonical instance-to-campaign path
 * (reused, not reinvented).
 */
export async function resolveCurrentCampaignBriefForInstance(
  instanceId: string,
  client: Db | DbTx = db,
): Promise<CampaignBriefValidationResult> {
  const instance = await findInstanceById(instanceId, client);
  if (!instance) {
    // No campaign is resolvable at all. `expected.campaignId` has no real
    // campaign id to report — the instance id is carried there instead
    // (the type requires a string) with the diagnostic spelling out exactly
    // what it actually is, so this never reads as a real campaign id to a
    // caller. Should be unreachable in practice: every caller of this
    // instance-scoped entry point already has its own instanceId from an
    // instance it just loaded.
    const result: CampaignBriefValidationResult = {
      status: "BLOCKED",
      brief: null,
      expected: { campaignId: instanceId, campaignTermsSnapshotId: null },
      stored: { campaignId: null, campaignTermsSnapshotId: null },
      mismatchCategory: "NO_CAMPAIGN",
      regenerationAllowed: false,
      nextAction: "operator_review_required",
      diagnostic: `execution instance ${instanceId} does not exist (expected.campaignId above is actually the instance id — no campaign was resolvable)`,
    };
    emitValidationResult(instanceId, null, null, result);
    return result;
  }

  if (!instance.campaignTermsSnapshotId) {
    // A real, structurally-possible BLOCKED case — instances enrolled before
    // this column existed have none pinned. Not a crash.
    const [row] = await client
      .select({ campaignId: workflows.campaignId })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(eq(workflowVersions.id, instance.workflowVersionId))
      .limit(1);
    const campaignId = row?.campaignId ?? instanceId;
    const result: CampaignBriefValidationResult = {
      status: "BLOCKED",
      brief: null,
      expected: { campaignId, campaignTermsSnapshotId: null },
      stored: { campaignId: null, campaignTermsSnapshotId: null },
      mismatchCategory: "NO_PINNED_SNAPSHOT",
      regenerationAllowed: false,
      nextAction: "operator_review_required",
      diagnostic: `execution instance ${instanceId} has no campaignTermsSnapshotId pinned (enrolled before this column existed)`,
    };
    emitValidationResult(campaignId, null, null, result);
    return result;
  }

  const [row] = await client
    .select({ campaignId: workflows.campaignId })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
    .where(eq(workflowVersions.id, instance.workflowVersionId))
    .limit(1);

  if (!row || !row.campaignId) {
    // Structurally shouldn't happen — every Workflow in this codebase is
    // created with a campaignId. Defensive, not expected to be exercised
    // outside a hand-built fixture.
    const result: CampaignBriefValidationResult = {
      status: "BLOCKED",
      brief: null,
      expected: { campaignId: instanceId, campaignTermsSnapshotId: instance.campaignTermsSnapshotId },
      stored: { campaignId: null, campaignTermsSnapshotId: null },
      mismatchCategory: "NO_CAMPAIGN",
      regenerationAllowed: false,
      nextAction: "operator_review_required",
      diagnostic: `execution instance ${instanceId}'s workflow has no campaignId (expected.campaignId above is actually the instance id — no campaign was resolvable)`,
    };
    emitValidationResult(instanceId, instance.campaignTermsSnapshotId, null, result);
    return result;
  }

  return resolveAgainstExpectedSnapshot(row.campaignId, instance.campaignTermsSnapshotId, client);
}
