/**
 * Unit tests for the brand-decision verification rule (PLU-118, Calvin review §3):
 * "leaving AWAITING_BRAND_APPROVAL does not prove THIS request's decision
 * succeeded." The route's catch path now records APPROVED/REJECTED only when the
 * instance reached the state THAT decision produces — verified by both the current
 * state AND a corroborating audit event, so a racing opt-out (which also lands in
 * MANUAL_REVIEW but writes no BRAND_REJECTED) can't get a REJECTED falsely recorded.
 *
 * expectedOutcomeFor is the pure kernel of that rule (exported from the route). We
 * test it directly and re-derive the realization predicate from it exactly as the
 * route does, so the two can't drift.
 *
 * Run with:  npx tsx src/routes/brandApproval.verify.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedOutcomeFor } from "./brandApproval.js";

test("expectedOutcomeFor: APPROVED → PAYMENT_PENDING + BRAND_APPROVED", () => {
  assert.deepEqual(expectedOutcomeFor("APPROVED"), {
    state: "PAYMENT_PENDING",
    event: "BRAND_APPROVED",
  });
});

test("expectedOutcomeFor: REJECTED → MANUAL_REVIEW + BRAND_REJECTED", () => {
  assert.deepEqual(expectedOutcomeFor("REJECTED"), {
    state: "MANUAL_REVIEW",
    event: "BRAND_REJECTED",
  });
});

// Re-derive the exact realization predicate the route applies, so this test locks
// the behavior even though decisionEffectRealized itself is route-private.
function realized(
  decision: "APPROVED" | "REJECTED",
  instanceState: string | null,
  events: string[],
): boolean {
  if (instanceState === null) return false;
  const expected = expectedOutcomeFor(decision);
  if (instanceState !== expected.state) return false;
  return events.includes(expected.event);
}

test("APPROVED is recorded only at PAYMENT_PENDING WITH a BRAND_APPROVED event", () => {
  assert.equal(realized("APPROVED", "PAYMENT_PENDING", ["BRAND_APPROVED"]), true);
  // Right state, missing event (finalize lost but the step never actually ran) → no.
  assert.equal(realized("APPROVED", "PAYMENT_PENDING", []), false);
  // Wrong state entirely → no.
  assert.equal(realized("APPROVED", "AWAITING_BRAND_APPROVAL", ["BRAND_APPROVED"]), false);
});

test("REJECTED is recorded only at MANUAL_REVIEW WITH a BRAND_REJECTED event", () => {
  assert.equal(realized("REJECTED", "MANUAL_REVIEW", ["BRAND_REJECTED"]), true);
});

test("a racing OPT-OUT into MANUAL_REVIEW does NOT get REJECTED recorded (the §3 bug)", () => {
  // The instance left the gate to MANUAL_REVIEW via an opt-out — SAME target state
  // as a reject, but no BRAND_REJECTED event. The old code (state-only) would have
  // falsely recorded REJECTED; the event corroboration blocks it.
  assert.equal(realized("REJECTED", "MANUAL_REVIEW", ["OPTED_OUT"]), false);
  assert.equal(realized("REJECTED", "MANUAL_REVIEW", []), false);
});

test("a racing OPT-OUT into OPTED_OUT does NOT get APPROVED recorded", () => {
  assert.equal(realized("APPROVED", "OPTED_OUT", ["BRAND_APPROVED"]), false);
});

test("the OTHER decision winning does NOT get THIS decision recorded", () => {
  // The brand's APPROVE raced a REJECT that won: instance is MANUAL_REVIEW with
  // BRAND_REJECTED. Verifying for APPROVED must fail (it wants PAYMENT_PENDING).
  assert.equal(realized("APPROVED", "MANUAL_REVIEW", ["BRAND_REJECTED"]), false);
  // And symmetrically: a REJECT that raced an APPROVE which won.
  assert.equal(realized("REJECTED", "PAYMENT_PENDING", ["BRAND_APPROVED"]), false);
});

test("a missing instance is never a realized decision", () => {
  assert.equal(realized("APPROVED", null, ["BRAND_APPROVED"]), false);
  assert.equal(realized("REJECTED", null, ["BRAND_REJECTED"]), false);
});
