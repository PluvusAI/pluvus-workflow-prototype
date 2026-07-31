import {
  listStaleProcessingApprovals,
  revertBrandApprovalToAwaiting,
  findInstanceById,
} from "../db/index.js";
import type { BrandApproval } from "../db/schema.js";
import { logTrace } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Brand-approval stale-claim recovery sweep (PLU-118, Calvin review §1)
// ---------------------------------------------------------------------------
// A brand decision is a two-phase claim: claimBrandApprovalForProcessing moves the
// row AWAITING_APPROVAL → PROCESSING (the idempotency lock), and the route writes
// the terminal decision (finalize) or undoes the claim (revert) once
// handleBrandApproval returns. PROCESSING is meant to be held only for that brief
// window.
//
// THE STRANDING (blocker): reversion of a failed claim lives ONLY in the route's
// catch block. If the process dies AFTER the claim but BEFORE finalize/revert, the
// row stays PROCESSING forever — and the operator resend refuses it (it only
// accepts AWAITING_APPROVAL), so the brand's link is dead with no exit. This sweep
// is the durable recovery: it reverts a long-held PROCESSING claim back to
// AWAITING_APPROVAL so the same magic link works again.
//
// SAFETY — never resurrect a decision that DID take effect. We revert ONLY when the
// owning instance is STILL parked in AWAITING_BRAND_APPROVAL. If the instance has
// advanced (PAYMENT_PENDING on approve, MANUAL_REVIEW on reject), the workflow
// action succeeded and only the finalize write was lost — reverting to
// AWAITING_APPROVAL would wrongly re-open a decided deal. Those rows are left for
// the operator (their state already reflects the true outcome); the sweep logs and
// skips them.
//
// BOUNDS (mirrors sendDelaySweep): a grace window so we never race a still-in-
// flight route (a claim younger than the grace is legitimately mid-decision), a
// per-tick limit, and best-effort per-row error isolation. Runs under the poller's
// leader lease, so no extra leader guard is needed.

// A PROCESSING claim younger than this is presumed still mid-decision (the route is
// actively driving handleBrandApproval) and is left alone. handleBrandApproval does
// one OCC transition (+ a reserve/enqueue on reject); minutes is a generous ceiling
// on that, so a claim older than this window has almost certainly been abandoned by
// a crashed route. Env-overridable for operational tuning.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const brandApprovalStaleClaimGraceMs = envInt(
  "BRAND_APPROVAL_STALE_CLAIM_GRACE_MS",
  5 * 60_000, // 5 minutes
);

export interface BrandApprovalSweepDeps {
  listStaleProcessingApprovals(args: {
    olderThan: Date;
    limit?: number;
  }): Promise<BrandApproval[]>;
  /** Reverts PROCESSING → AWAITING_APPROVAL (predicate-guarded on PROCESSING).
   *  Returns the reverted row, or null when it was no longer PROCESSING (a racing
   *  finalize/revert won). */
  revertBrandApprovalToAwaiting(id: string): Promise<BrandApproval | null>;
  /** Reads the owning instance's current state so the sweep can refuse to revert a
   *  claim whose decision actually took effect. */
  findInstanceById(id: string): Promise<{ currentState: string } | null>;
  now(): Date;
}

const defaultDeps: BrandApprovalSweepDeps = {
  listStaleProcessingApprovals,
  revertBrandApprovalToAwaiting,
  findInstanceById: (id) =>
    findInstanceById(id).then((i) => (i ? { currentState: i.currentState } : null)),
  // Date.now() is fine in app code (only Workflow scripts forbid it); wrapped so
  // tests can inject a fixed clock.
  now: () => new Date(),
};

export interface BrandApprovalSweepResult {
  /** Stale claims reverted back to AWAITING_APPROVAL (link re-clickable). */
  recovered: number;
  /** Stale claims left alone because the instance had ALREADY advanced (the
   *  decision took effect; only the finalize write was lost). */
  advancedSkipped: number;
}

export async function sweepStaleBrandApprovalClaims(
  deps: BrandApprovalSweepDeps = defaultDeps,
): Promise<BrandApprovalSweepResult> {
  const now = deps.now();
  const olderThan = new Date(now.getTime() - brandApprovalStaleClaimGraceMs);

  let stale: BrandApproval[];
  try {
    stale = await deps.listStaleProcessingApprovals({ olderThan, limit: 100 });
  } catch (err) {
    console.error(
      "[scheduler/brand-approval-sweep] DB query failed:",
      err instanceof Error ? err.message : err,
    );
    return { recovered: 0, advancedSkipped: 0 };
  }

  if (stale.length === 0) return { recovered: 0, advancedSkipped: 0 };

  console.log(
    `[scheduler/brand-approval-sweep] ${stale.length} stale PROCESSING claim(s) to inspect`,
  );

  let recovered = 0;
  let advancedSkipped = 0;

  for (const row of stale) {
    // Only revert a claim whose decision NEVER took effect — the instance must
    // still be parked in the gate. A read failure fails safe (skip, don't revert).
    let instState: string | null;
    try {
      const inst = await deps.findInstanceById(row.instanceId);
      instState = inst?.currentState ?? null;
    } catch (err) {
      console.error(
        `[scheduler/brand-approval-sweep] instance read failed for ${row.id} (instance ${row.instanceId}):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    if (instState !== "AWAITING_BRAND_APPROVAL") {
      // The decision took effect (instance advanced) — reverting would re-open a
      // decided deal. Leave it for the operator; its state reflects the truth.
      advancedSkipped++;
      console.warn(
        `[scheduler/brand-approval-sweep] ${row.id} PROCESSING but instance ` +
          `${row.instanceId} is ${instState ?? "missing"} (not parked) — the decision ` +
          `took effect; skipping (operator can inspect the lost finalize)`,
      );
      continue;
    }

    try {
      const reverted = await deps.revertBrandApprovalToAwaiting(row.id);
      if (reverted) {
        recovered++;
        console.log(
          `[scheduler/brand-approval-sweep] recovered stale claim ${row.id} → AWAITING_APPROVAL (link re-clickable)`,
        );
        logTrace("brand_approval_stale_claim_recovered", {
          source: "scheduler",
          instanceId: row.instanceId,
          approvalId: row.id,
        });
      }
      // reverted === null → a racing finalize/revert already resolved it; no-op.
    } catch (err) {
      console.error(
        `[scheduler/brand-approval-sweep] revert failed for ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (recovered || advancedSkipped) {
    console.log(
      `[scheduler/brand-approval-sweep] recovered ${recovered}, skipped ${advancedSkipped} advanced`,
    );
  }
  return { recovered, advancedSkipped };
}
