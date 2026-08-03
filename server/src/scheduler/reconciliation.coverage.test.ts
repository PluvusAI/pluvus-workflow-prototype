/**
 * H8 — stranded-instance sweep COVERAGE (the review flagged this as unverified).
 *
 * The existing reconciliation.test.ts proves the sweep re-enqueues whatever the
 * (injected) listStuckInstances hands it. What it does NOT prove is that the real
 * selection set — RECONCILE_STATES, the WHERE clause of listStuckInstances —
 * actually INCLUDES the two states a crash-between-commit-and-enqueue is most
 * likely to strand mid-deal: NEGOTIATING and REPLY_RECEIVED. If either silently
 * dropped out of that list, a stranded negotiation would sit invisible forever
 * and no behavioral test would catch it. This file locks the selection set.
 *
 * Two layers:
 *   1. Assert RECONCILE_STATES itself — NEGOTIATING + REPLY_RECEIVED are in it,
 *      the WAITING states and every TERMINAL state are NOT.
 *   2. Drive reconcileStuckInstances end-to-end (injected seam, no DB/Redis) for
 *      both states and assert each is re-enqueued keyed on its own state.
 *
 * Run: npx tsx --test src/scheduler/reconciliation.coverage.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { RECONCILE_STATES } from "../db/instances.js";
import { instanceStateEnum, type ExecutionInstance, type InstanceState } from "../db/schema.js";
import { isTerminal } from "../engine/stateMachine.js";
import { reconcileStuckInstances, type ReconciliationDeps } from "./reconciliation.js";
import type { NodeExecutionJobData } from "../workers/jobs.js";

// The genuinely-WAITING states are deliberately excluded from the sweep (the due
// poller covers AWAITING_REPLY; REWARD_PENDING/PAYMENT_PENDING/CONTENT_LINKS_PENDING
// are parked on an external reply/form). Re-enqueuing those would spam, not recover.
//
// W-2: FOLLOWED_UP is NOT in this list anymore — it is transient (committed with
// dueAt=null and auto-chained back to AWAITING_REPLY), so the due poller cannot
// recover a lost auto-chain enqueue and the sweep must. See RECONCILE_STATES.
//
// PLU-70: NEEDS_DEAL_FINALIZATION is a waiting state too — it is parked on an
// OPERATOR finishing the deal by hand, exactly as PAYMENT_PENDING is parked on
// the creator submitting a form. There is no queued work to recover, so sweeping
// it would re-enqueue a step that has nothing to do, every tick, forever.
// ACCEPTED (already swept) covers the real strand risk: a crash between the
// accept commit and the handoff enqueue.
const WAITING_STATES: InstanceState[] = [
  "AWAITING_REPLY",
  // PLU-122: this state is owned by the delayed-send outbox, not the
  // node-execution worker. Its dedicated sweep recovers a lost or overdue
  // delayed-send job; re-enqueuing the instance here would run the follow-up
  // node before the initial email has actually been sent.
  "OUTREACH_QUEUED",
  "REWARD_PENDING",
  "PAYMENT_PENDING",
  // CONTENT_LINKS_PENDING parks on the creator's content-links reply, just like
  // PAYMENT_PENDING parks on the payout form — a genuine waiting state that must
  // NOT be swept (re-enqueuing has no reply to process → spam, not recovery).
  "CONTENT_LINKS_PENDING",
  "NEEDS_DEAL_FINALIZATION",
  // Brand-approval gate: AWAITING_BRAND_APPROVAL is parked on the BRAND clicking an
  // approve/reject magic link, exactly as PAYMENT_PENDING parks on the payout form.
  // There is no queued work to recover, so sweeping it would re-run
  // executeBrandApproval every tick forever. ACCEPTED (already swept) covers the
  // real strand risk: a crash between the accept commit and the gate enqueue.
  "AWAITING_BRAND_APPROVAL",
];

test("H8: RECONCILE_STATES includes NEGOTIATING and REPLY_RECEIVED (the flagged pair)", () => {
  assert.ok(
    RECONCILE_STATES.includes("NEGOTIATING"),
    "a negotiation stranded between commit and enqueue must be recoverable",
  );
  assert.ok(
    RECONCILE_STATES.includes("REPLY_RECEIVED"),
    "a reply-received instance stranded (CRITICAL-6 path) must be recoverable",
  );
});

test("W-2: RECONCILE_STATES includes FOLLOWED_UP (transient, dueAt=null, no other recovery)", () => {
  assert.ok(
    RECONCILE_STATES.includes("FOLLOWED_UP"),
    "FOLLOWED_UP is committed with dueAt=null and auto-chained; a lost enqueue " +
      "can't be recovered by the due poller (needs dueAt<=now), so the sweep must",
  );
});

test("H8: the sweep excludes every WAITING state (would spam, not recover)", () => {
  for (const s of WAITING_STATES) {
    assert.ok(!RECONCILE_STATES.includes(s), `${s} must NOT be swept (it is a waiting state)`);
  }
});

test("H8: the sweep excludes every TERMINAL state (nothing to advance)", () => {
  for (const s of instanceStateEnum.enumValues) {
    if (isTerminal(s)) {
      assert.ok(!RECONCILE_STATES.includes(s), `terminal ${s} must NOT be swept`);
    }
  }
});

test("H8: the sweep covers exactly the transient non-waiting non-terminal states", () => {
  // Belt-and-braces: the selection set equals (all states) minus (terminal ∪
  // waiting). If a new transient state is added and forgotten here, this fails.
  const expected = instanceStateEnum.enumValues
    .filter((s) => !isTerminal(s) && !WAITING_STATES.includes(s))
    .sort();
  assert.deepEqual([...RECONCILE_STATES].sort(), expected);
});

// ---------------------------------------------------------------------------
// Behavioral: both flagged states actually flow through the sweep.
// ---------------------------------------------------------------------------

function inst(id: string, state: InstanceState, updatedAt: Date): ExecutionInstance {
  return {
    id,
    workflowVersionId: "wv-1",
    creatorId: `creator-${id}`,
    currentState: state,
    currentNodeId: "node-x",
    followUpCount: 0,
    negotiationRound: 0,
    dueAt: null,
    enrolledAt: updatedAt,
    completedAt: null,
    createdAt: updatedAt,
    updatedAt,
  } as unknown as ExecutionInstance;
}

test("H8: reconcileStuckInstances re-enqueues NEGOTIATING and REPLY_RECEIVED keyed on state", async () => {
  const NOW = new Date("2026-07-14T12:00:00.000Z");
  const OLD = new Date("2026-07-14T11:00:00.000Z"); // 1h ago — past the stale window
  const enqueued: NodeExecutionJobData[] = [];
  const deps: ReconciliationDeps = {
    async listStuckInstances() {
      return [inst("neg", "NEGOTIATING", OLD), inst("reply", "REPLY_RECEIVED", OLD)];
    },
    async enqueueNodeExecution(data) {
      enqueued.push(data);
    },
  };

  const count = await reconcileStuckInstances(NOW, deps);

  assert.equal(count, 2, "both stranded instances are re-enqueued");
  const byId = new Map(enqueued.map((e) => [e.instanceId, e]));
  assert.equal(byId.get("neg")?.expectedState, "NEGOTIATING");
  assert.equal(byId.get("reply")?.expectedState, "REPLY_RECEIVED");
});
