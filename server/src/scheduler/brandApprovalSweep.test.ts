/**
 * Unit tests for the brand-approval stale-claim recovery sweep (PLU-118, Calvin
 * review §1) — fully injected deps, no live DB.
 *
 * Covers:
 *   - a PROCESSING claim older than the grace window whose instance is STILL parked
 *     in AWAITING_BRAND_APPROVAL is reverted to AWAITING_APPROVAL (the crash-strand
 *     recovery: reversion no longer lives ONLY in the route catch).
 *   - a PROCESSING claim whose instance has ADVANCED (decision took effect, only the
 *     finalize write was lost) is NOT reverted — reverting would re-open a decided
 *     deal.
 *   - a racing finalize/revert (revert returns null) is a clean no-op.
 *   - an instance-read failure fails safe (skip, don't revert).
 *   - an empty stale set is a clean no-op.
 *
 * Run with:  npx tsx src/scheduler/brandApprovalSweep.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sweepStaleBrandApprovalClaims,
  brandApprovalStaleClaimGraceMs,
  type BrandApprovalSweepDeps,
} from "./brandApprovalSweep.js";
import type { BrandApproval } from "../db/schema.js";

const NOW = new Date("2026-07-27T12:00:00.000Z");
// Older than the grace window → a genuinely stale claim.
const STALE_AT = new Date(NOW.getTime() - brandApprovalStaleClaimGraceMs - 60_000);

function claim(over: Partial<BrandApproval> = {}): BrandApproval {
  return {
    id: "ba1",
    instanceId: "i1",
    status: "PROCESSING",
    updatedAt: STALE_AT,
    ...over,
  } as unknown as BrandApproval;
}

function makeDeps(
  over: {
    stale?: BrandApproval[];
    instanceState?: string | null;
    revertResult?: BrandApproval | null;
    revertThrows?: boolean;
    instanceThrows?: boolean;
  } = {},
) {
  const reverted: string[] = [];
  const deps: BrandApprovalSweepDeps = {
    async listStaleProcessingApprovals() {
      return over.stale ?? [];
    },
    async revertBrandApprovalToAwaiting(id: string) {
      if (over.revertThrows) throw new Error("revert db blip");
      reverted.push(id);
      // Default: revert succeeds and returns the reverted row.
      return over.revertResult !== undefined
        ? over.revertResult
        : ({ id, status: "AWAITING_APPROVAL" } as unknown as BrandApproval);
    },
    async findInstanceById(_id: string) {
      if (over.instanceThrows) throw new Error("instance read blip");
      const state = over.instanceState ?? "AWAITING_BRAND_APPROVAL";
      return state === null ? null : { currentState: state };
    },
    now: () => NOW,
  };
  return { deps, reverted };
}

test("recovers a stale PROCESSING claim whose instance is still parked", async () => {
  const { deps, reverted } = makeDeps({
    stale: [claim({ id: "baA" })],
    instanceState: "AWAITING_BRAND_APPROVAL",
  });
  const res = await sweepStaleBrandApprovalClaims(deps);
  assert.equal(res.recovered, 1);
  assert.equal(res.advancedSkipped, 0);
  assert.deepEqual(reverted, ["baA"], "the stale claim was reverted");
});

test("does NOT revert a claim whose instance already advanced (decision took effect)", async () => {
  // The instance reached PAYMENT_PENDING (approve landed) — only the finalize write
  // was lost. Reverting to AWAITING_APPROVAL would re-open a decided deal.
  const { deps, reverted } = makeDeps({
    stale: [claim({ id: "baB" })],
    instanceState: "PAYMENT_PENDING",
  });
  const res = await sweepStaleBrandApprovalClaims(deps);
  assert.equal(res.recovered, 0);
  assert.equal(res.advancedSkipped, 1, "advanced instance skipped, not reverted");
  assert.equal(reverted.length, 0, "no revert attempted on a decided deal");
});

test("does NOT revert when the instance moved to MANUAL_REVIEW (reject landed)", async () => {
  const { deps, reverted } = makeDeps({
    stale: [claim({ id: "baC" })],
    instanceState: "MANUAL_REVIEW",
  });
  const res = await sweepStaleBrandApprovalClaims(deps);
  assert.equal(res.recovered, 0);
  assert.equal(res.advancedSkipped, 1);
  assert.equal(reverted.length, 0);
});

test("a racing finalize/revert (revert → null) is a clean no-op", async () => {
  // The row left PROCESSING between the list and the revert — revert matches 0 rows.
  const { deps } = makeDeps({
    stale: [claim({ id: "baD" })],
    instanceState: "AWAITING_BRAND_APPROVAL",
    revertResult: null,
  });
  const res = await sweepStaleBrandApprovalClaims(deps);
  assert.equal(res.recovered, 0, "a no-op revert is not counted as a recovery");
  assert.equal(res.advancedSkipped, 0);
});

test("an instance-read failure fails safe (skip, never revert)", async () => {
  const { deps, reverted } = makeDeps({
    stale: [claim({ id: "baE" })],
    instanceThrows: true,
  });
  const res = await sweepStaleBrandApprovalClaims(deps);
  assert.equal(res.recovered, 0);
  assert.equal(reverted.length, 0, "an uncertain instance read never triggers a revert");
});

test("a revert DB failure is isolated (best-effort, sweep continues)", async () => {
  const { deps } = makeDeps({
    stale: [claim({ id: "baF" })],
    instanceState: "AWAITING_BRAND_APPROVAL",
    revertThrows: true,
  });
  const res = await sweepStaleBrandApprovalClaims(deps);
  assert.equal(res.recovered, 0, "a failed revert is not counted");
  // The sweep returned cleanly rather than throwing.
});

test("an empty stale set is a clean no-op", async () => {
  const { deps } = makeDeps({ stale: [] });
  const res = await sweepStaleBrandApprovalClaims(deps);
  assert.deepEqual(res, { recovered: 0, advancedSkipped: 0 });
});
