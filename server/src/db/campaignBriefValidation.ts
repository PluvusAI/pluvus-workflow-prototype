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
import {
  findCampaignById,
  resolveCampaignLaunchContext,
  CampaignNotFoundError,
  CampaignNotActiveError,
  CampaignSnapshotMissingError,
} from "./campaigns.js";
import { findInstanceById } from "./instances.js";
import {
  createOrGetCampaignBriefRenderRequest,
  getCurrentReadyCampaignBrief,
  getLatestCampaignBriefForCampaign,
  CampaignBriefRenderRequestConflictError,
} from "./campaignBriefRender.js";
import { enqueueCampaignBriefRender } from "../workers/queues.js";
import { storedFileExists } from "../storage/localFileStorage.js";
import { logTrace } from "../observability/logger.js";
import { workflowVersions, workflows, type CampaignBrief } from "./schema.js";

/**
 * Review fix: a Redis/DB hiccup while attempting regeneration is not a
 * campaign data problem — it must not be reported as BLOCKED
 * (`operator_review_required`), which tells an operator "this campaign
 * needs a human to fix something about it" when nothing is actually wrong
 * with the campaign. Thrown by resolveAgainstExpectedSnapshot for any
 * failure that ISN'T one of the three known domain errors (campaign not
 * launchable, or a renderRequestId collision); route layers catch this
 * specifically and respond 503 (retry), distinct from their generic
 * unexpected-error 500.
 */
export class CampaignBriefRegenerationUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `campaign brief regeneration temporarily unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "CampaignBriefRegenerationUnavailableError";
    this.cause = cause;
  }
}

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

function buildCurrentResult(
  campaignId: string,
  expectedSnapshotId: string,
  brief: CampaignBrief,
): CampaignBriefValidationResult {
  return {
    status: "CURRENT",
    brief,
    expected: { campaignId, campaignTermsSnapshotId: expectedSnapshotId },
    stored: { campaignId: brief.campaignId, campaignTermsSnapshotId: brief.campaignTermsSnapshotId },
    mismatchCategory: null,
    regenerationAllowed: false,
    nextAction: "serve_current",
    diagnostic: "the current READY brief matches the expected snapshot",
  };
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
 * (3) has a renderedAssetRef, AND (4) that referenced asset is actually
 * still retrievable (review fix: a DB row is not proof the file survived a
 * restart). Anything else is "not current" — this function categorizes WHY,
 * then tries to fix it via regeneration (never by falling back to a
 * different snapshot/row/table), and returns one of the three outcomes
 * CURRENT/REGENERATING/BLOCKED this function alone owns.
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
    candidate.renderedAssetRef &&
    (await storedFileExists(candidate.renderedAssetRef))
  ) {
    const result = buildCurrentResult(campaignId, expectedSnapshotId, candidate);
    emitValidationResult(campaignId, expectedSnapshotId, candidate.id, result);
    return result;
  }

  // Not current — categorize, then try to fix it via regeneration.
  let category: CampaignBriefMismatchCategory;
  let stored: { campaignId: string | null; campaignTermsSnapshotId: string | null };
  let candidateBriefId: string | null = null;

  if (candidate && candidate.campaignId === campaignId && candidate.campaignTermsSnapshotId === expectedSnapshotId) {
    // Matched on identity but still failed the CURRENT check above — the
    // only thing left that could have failed is the file-existence check
    // (review fix): the DB says READY with an asset ref, but the bytes are
    // gone. Distinct from a real identity mismatch below — this campaign's
    // document IS the right one, it's just not currently retrievable.
    category = "ASSET_UNAVAILABLE";
    stored = { campaignId: candidate.campaignId, campaignTermsSnapshotId: candidate.campaignTermsSnapshotId };
    candidateBriefId = candidate.id;
  } else if (candidate) {
    // A READY, un-superseded row exists for this campaign but its identity
    // didn't match — since getCurrentReadyCampaignBrief() itself filters
    // WHERE campaignId = campaignId, candidate.campaignId !== campaignId is
    // structurally impossible through this query; checked explicitly
    // anyway (the ticket's own "do not assume" posture), so this branch is
    // really always SNAPSHOT_MISMATCH in practice for the campaign-scoped
    // caller — but IS reachable for the instance-scoped caller, whose
    // expectedSnapshotId can legitimately differ from this campaign's own.
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
  let campaignBrief: CampaignBrief;
  try {
    ({ campaignBrief } = await createOrGetCampaignBriefRenderRequest(campaignId, renderRequestId, client));
  } catch (err) {
    // Review fix: only these three are genuine domain/data problems — the
    // campaign isn't launchable, or a renderRequestId collided (itself only
    // possible via a real bug). Anything else (a transient DB error inside
    // the transaction) is NOT a campaign problem and must not be reported
    // as one — rethrown as a distinct, retryable error type instead of
    // being folded into the same BLOCKED bucket the old bare `catch` used.
    if (
      err instanceof CampaignNotActiveError ||
      err instanceof CampaignSnapshotMissingError ||
      err instanceof CampaignBriefRenderRequestConflictError
    ) {
      const diagnostic = err.message;
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
    throw new CampaignBriefRegenerationUnavailableError(err);
  }

  // Review fix: createOrGetCampaignBriefRenderRequest() ALWAYS creates/
  // resolves a row against the CAMPAIGN's own permanent snapshot (via
  // resolveCampaignLaunchContext), never `expectedSnapshotId` directly. For
  // the campaign-scoped entry point these are always the same value
  // (resolveCurrentCampaignBriefForCampaign derives expectedSnapshotId the
  // identical way, so this is a no-op check there). For the instance-scoped
  // entry point, expectedSnapshotId is the INSTANCE's own pin, which can
  // legitimately differ (an anomalous cross-campaign pin — see
  // resolveCurrentCampaignBriefForInstance's doc comment). In that case
  // regeneration would run forever and never produce a match, since it can
  // only ever render THIS campaign's own snapshot — detected here, once,
  // for both callers: BLOCKED, not an endless REGENERATING.
  if (campaignBrief.campaignTermsSnapshotId !== expectedSnapshotId) {
    const diagnostic =
      `expected snapshot ${expectedSnapshotId} does not belong to campaign ${campaignId} ` +
      `(its own current snapshot is ${campaignBrief.campaignTermsSnapshotId}) — regeneration ` +
      "can never produce a matching document";
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
    emitValidationResult(campaignId, expectedSnapshotId, campaignBrief.id, result);
    return result;
  }

  if (campaignBrief.status === "GENERATING") {
    // Same status-gated re-enqueue as the POST route (Calvin review #4):
    // safe to call unconditionally for a row that already has a job running
    // — enqueueCampaignBriefRender()'s jobId is deterministic
    // (`brief-render|${campaignBriefId}`) and BullMQ dedupes on it. If THIS
    // throws (e.g. Redis unavailable), it propagates out of the try/catch
    // above having already returned — never reported as REGENERATING.
    try {
      await enqueueCampaignBriefRender({ campaignBriefId: campaignBrief.id });
    } catch (err) {
      throw new CampaignBriefRegenerationUnavailableError(err);
    }
    const result: CampaignBriefValidationResult = {
      status: "REGENERATING",
      brief: null,
      expected,
      stored,
      mismatchCategory: category,
      regenerationAllowed: true,
      nextAction: "poll_for_ready",
      diagnostic: `no current brief matches the expected snapshot (${category}); regeneration enqueued`,
    };
    logTrace("campaign_brief_regeneration_requested", {
      campaignId,
      expectedSnapshotId,
      campaignBriefId: campaignBrief.id,
      mismatchCategory: category,
    });
    emitValidationResult(campaignId, expectedSnapshotId, candidateBriefId, result);
    return result;
  }

  if (campaignBrief.status === "READY") {
    // Race: something else (a concurrent validator, or a real client POST)
    // already finished this exact render between the `candidate` read above
    // and this point. Re-check fresh (including the file) rather than
    // assume — cheap, and correct.
    const settled = await getCurrentReadyCampaignBrief(campaignId, client);
    if (
      settled &&
      settled.campaignTermsSnapshotId === expectedSnapshotId &&
      settled.renderedAssetRef &&
      (await storedFileExists(settled.renderedAssetRef))
    ) {
      const result = buildCurrentResult(campaignId, expectedSnapshotId, settled);
      emitValidationResult(campaignId, expectedSnapshotId, campaignBrief.id, result);
      return result;
    }
    // Defensive — should not happen (the row just resolved as READY with a
    // matching snapshot); if it does, don't claim a status this can't back up.
    const result: CampaignBriefValidationResult = {
      status: "BLOCKED",
      brief: null,
      expected,
      stored: { campaignId: campaignBrief.campaignId, campaignTermsSnapshotId: campaignBrief.campaignTermsSnapshotId },
      mismatchCategory: category,
      regenerationAllowed: false,
      nextAction: "operator_review_required",
      diagnostic: "regeneration completed but the result could not be confirmed current — retry",
    };
    emitValidationResult(campaignId, expectedSnapshotId, campaignBrief.id, result);
    return result;
  }

  // FAILED — this exact deterministic renderRequestId already failed once.
  // Because renderRequestId is unique, createOrGetCampaignBriefRenderRequest
  // will keep returning this SAME dead row forever; auto-regen can never
  // create a fresh attempt for this snapshot on its own. Review fix: the old
  // code reported REGENERATING/poll_for_ready here, telling callers to keep
  // polling a job that will never run. BLOCKED instead — an operator (or a
  // real client) must trigger a fresh attempt via POST /campaigns/:id/brief
  // with a NEW, client-supplied renderRequestId (the existing PLU-141 §6a
  // retry mechanism); this auto-path deliberately does not mint one itself
  // (unbounded, unattended retries on every poll would be its own failure
  // mode).
  const diagnostic =
    `a prior regeneration attempt for this exact snapshot already failed ` +
    `(errorCategory: ${campaignBrief.errorCategory ?? "unknown"}); a fresh render request is required`;
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
  emitValidationResult(campaignId, expectedSnapshotId, campaignBrief.id, result);
  return result;
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

  let campaignTermsSnapshotId: string;
  try {
    ({ campaignTermsSnapshotId } = await resolveCampaignLaunchContext(campaignId, client));
  } catch (err) {
    // Review fix: only these are genuine domain problems — the campaign
    // truly isn't launchable, or (a narrow TOCTOU) it was deleted between
    // the findCampaignById check above and this call. Reused as the
    // NO_CAMPAIGN category (closest fit: "nothing to validate"). Anything
    // else — a transient DB error on either of resolveCampaignLaunchContext's
    // own two selects — is NOT a campaign problem and must not be reported
    // as one; same reasoning, and same fix, as resolveAgainstExpectedSnapshot's
    // own classification (review round 2, fix #4).
    if (
      err instanceof CampaignNotFoundError ||
      err instanceof CampaignNotActiveError ||
      err instanceof CampaignSnapshotMissingError
    ) {
      const diagnostic = err.message;
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
    throw new CampaignBriefRegenerationUnavailableError(err);
  }

  // Review fix: deliberately OUTSIDE the try above.
  // resolveAgainstExpectedSnapshot() has its own complete error handling and
  // throws CampaignBriefRegenerationUnavailableError for transient failures
  // — that must propagate to the caller (routes map it to 503/retry), not
  // be silently reclassified as this function's own "campaign isn't
  // launchable" NO_CAMPAIGN case. The try above used to wrap this call too,
  // so ANY throw from resolveAgainstExpectedSnapshot — including the very
  // error type fix #4 introduced specifically to signal "retry me" — was
  // caught here and converted into a permanent BLOCKED result before ever
  // reaching a route's dedicated 503 handler, defeating that fix entirely.
  return resolveAgainstExpectedSnapshot(campaignId, campaignTermsSnapshotId, client);
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
