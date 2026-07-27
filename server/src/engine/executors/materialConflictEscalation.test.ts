/**
 * PLU-82 §4.5 — material-conflict escalation gate + helper tests.
 * Pure logic; run with:
 *   npx tsx src/engine/executors/materialConflictEscalation.test.ts
 *
 * Covers the three required cases (§8):
 *   1. POSITIVE — a material conflict on a field the creator asked about → the
 *      gate matches and escalateMaterialConflict routes to MANUAL_REVIEW.
 *   2. FALSE-POSITIVE PREVENTED — a conflict exists but the creator did NOT ask
 *      about it (the round-0 "yes I'm interested" case) → the gate returns [] and
 *      nothing escalates. This is the highest-risk invariant (#7 / §8-b).
 *   3. NO-LOOP — the escalation is a TERMINAL MANUAL_REVIEW carrying
 *      escalateAfterWrite (the open obligation moves to ESCALATED), so the same
 *      stale obligation can never re-trigger (§8-g).
 */

import assert from "node:assert/strict";
import {
  conflictAffectsCreatorCommitment,
  escalateMaterialConflict,
} from "./negotiation.js";
import type { BriefFieldConflict } from "./briefKnowledge.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const paymentConflict: BriefFieldConflict = {
  section: "paymentTerms",
  campaignField: "paymentTerms",
  campaignValue: "Net 30",
  briefExcerpt: "payment is Net 60 after delivery",
  pageStart: 2,
  reason: "net-days mismatch (30 vs 60)",
};
const usageConflict: BriefFieldConflict = {
  section: "usageRights",
  campaignField: "usageRights",
  campaignValue: "90 days",
  briefExcerpt: "180 days of usage",
  reason: "duration mismatch (90 vs 180 days)",
};

console.log("\nconflictAffectsCreatorCommitment — the false-positive gate (invariant #7)\n");

test("POSITIVE: paymentTerms conflict + a payment question → matched", () => {
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    ["when do I get paid?"], // detectObligationCategory → "payment"
    undefined,
    [],
  );
  assert.deepEqual(matched, ["paymentTerms"]);
});

test("POSITIVE: usageRights conflict + a usage question → matched", () => {
  const matched = conflictAffectsCreatorCommitment(
    [usageConflict],
    ["what are the usage rights / licensing terms?"],
    undefined,
    [],
  );
  assert.deepEqual(matched, ["usageRights"]);
});

test("FALSE-POSITIVE PREVENTED: a conflict exists but the creator asked NOTHING relevant → []", () => {
  // The catastrophic case: a Net 60 brief vs Net 30 campaign conflict exists on
  // EVERY turn, but the creator only said "yes I'm interested". No escalation.
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    ["yes I'm interested, sounds great"],
    undefined,
    [],
  );
  assert.deepEqual(matched, []);
});

test("FALSE-POSITIVE PREVENTED: no creator questions at all → []", () => {
  assert.deepEqual(
    conflictAffectsCreatorCommitment([paymentConflict], undefined, undefined, []),
    [],
  );
});

test("FALSE-POSITIVE PREVENTED: creator asked about a DIFFERENT field (deliverables) → []", () => {
  // A payment conflict + a deliverables question do not match — the ask must be on
  // the SAME field's category.
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    ["how many reels do you need?"], // category "deliverables"
    undefined,
    [],
  );
  assert.deepEqual(matched, []);
});

test("open obligation (silent this turn) still matches — the round-2 clause (§8-g)", () => {
  // The creator asked about payment in round 0 (an open obligation with category
  // "payment") but is silent this turn; the conflict still matches via the open
  // obligation, so it escalates ONCE.
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    [], // silent this turn
    undefined,
    [{ category: "payment" }],
  );
  assert.deepEqual(matched, ["paymentTerms"]);
});

test("pushedFixedTerms also surface a category", () => {
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    undefined,
    ["insists on net 15 payment"], // "payment" via detectObligationCategory
    [],
  );
  assert.deepEqual(matched, ["paymentTerms"]);
});

test("attributionWindow conflict never matches (no keyword category — conservative §8)", () => {
  const attrConflict: BriefFieldConflict = {
    section: "attributionWindow",
    campaignField: "attributionWindow",
    campaignValue: "30 days",
    briefExcerpt: "60 day attribution",
    reason: "duration mismatch",
  };
  // Even with a payment-ish question, attributionWindow has no category mapping.
  const matched = conflictAffectsCreatorCommitment(
    [attrConflict],
    ["when do I get paid and what's the attribution?"],
    undefined,
    [],
  );
  assert.deepEqual(matched, []);
});

test("empty conflicts → [] (fast path)", () => {
  assert.deepEqual(
    conflictAffectsCreatorCommitment([], ["when do I get paid?"], undefined, []),
    [],
  );
});

test("multiple conflicting fields, both asked-about (distinct questions) → both matched, deduped", () => {
  // creatorQuestions arrives as an array of DISTINCT questions; detectObligationCategory
  // categorizes each one, so two separate asks surface two categories.
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict, usageConflict, paymentConflict],
    ["when do I get paid?", "what are the usage rights?"],
    undefined,
    [],
  );
  assert.deepEqual(matched.sort(), ["paymentTerms", "usageRights"]);
});

console.log("\nescalateMaterialConflict — the MANUAL_REVIEW NodeResult (§4.5)\n");

test("routes to MANUAL_REVIEW (terminal) with the right reason + fields", () => {
  const r = escalateMaterialConflict({
    round: 1,
    message: "when do I get paid?",
    conflictFields: ["paymentTerms"],
    conflicts: [paymentConflict],
  });
  assert.equal(r.nextState, "MANUAL_REVIEW");
  assert.equal(r.nextNodeId, null);
  assert.ok(r.completedAt instanceof Date, "terminal → completedAt stamped");
  assert.equal(r.eventType, "NEGOTIATION_TURN");
  const p = r.eventPayload as Record<string, unknown>;
  assert.equal(p["outcome"], "ESCALATE");
  assert.equal(p["reason"], "material_knowledge_conflict");
  assert.equal(p["round"], 1);
  assert.deepEqual(p["conflictFields"], ["paymentTerms"]);
  // The conflict rows ride the payload so the operator-gated inspector shows both
  // disagreeing sources.
  const conflicts = p["conflicts"] as BriefFieldConflict[];
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.campaignValue, "Net 30");
  assert.equal(conflicts[0]!.briefExcerpt, "payment is Net 60 after delivery");
});

console.log(`\n${n} passed\n`);
