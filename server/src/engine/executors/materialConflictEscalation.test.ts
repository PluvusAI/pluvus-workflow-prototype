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
  attachKnowledgeRecord,
  buildKnowledgeRecord,
  conflictAffectsCreatorCommitment,
  escalateMaterialConflict,
  formatBriefConflictWarning,
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

test("raw creator reply is the fallback when comprehension metadata is absent", () => {
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    undefined,
    undefined,
    [],
    "Could you confirm when I get paid?",
  );
  assert.deepEqual(matched, ["paymentTerms"]);
});

test("raw-reply fallback still ignores an unrelated interested response", () => {
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    undefined,
    undefined,
    [],
    "Yes, I'm interested — sounds great.",
  );
  assert.deepEqual(matched, []);
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

const attrConflict: BriefFieldConflict = {
  section: "attributionWindow",
  campaignField: "attributionWindow",
  campaignValue: "30 days",
  briefExcerpt: "60 day attribution",
  reason: "duration mismatch",
};
const exclusivityConflict: BriefFieldConflict = {
  section: "exclusivity",
  campaignField: "exclusivity",
  campaignValue: "none",
  briefExcerpt: "no competing brands for 90 days",
  reason: "exclusivity mismatch",
};

test("review §5: attributionWindow conflict + an attribution question → matched (was unreachable before)", () => {
  const matched = conflictAffectsCreatorCommitment(
    [attrConflict],
    ["what's the attribution window on the referral link?"],
    undefined,
    [],
  );
  assert.deepEqual(matched, ["attributionWindow"]);
});

test("attributionWindow conflict + an UNRELATED question → [] (still gated on the ask)", () => {
  const matched = conflictAffectsCreatorCommitment(
    [attrConflict],
    ["how many reels do you need?"],
    undefined,
    [],
  );
  assert.deepEqual(matched, []);
});

test("review §5: a USAGE-RIGHTS ask does NOT match an EXCLUSIVITY-only conflict (no cross-trigger)", () => {
  // The exact scenario Calvin flagged: creator asks about usage rights, only
  // exclusivity is conflicted. The old shared `usage_rights` bucket cross-fired;
  // field-specific matching must NOT escalate here.
  const matched = conflictAffectsCreatorCommitment(
    [exclusivityConflict],
    ["what are the usage rights / licensing terms?"],
    undefined,
    [],
  );
  assert.deepEqual(matched, []);
});

test("review §5: an EXCLUSIVITY ask matches an exclusivity conflict (and not a usage-only one)", () => {
  const matchedExcl = conflictAffectsCreatorCommitment(
    [exclusivityConflict],
    ["am I allowed to work with competing brands?"],
    undefined,
    [],
  );
  assert.deepEqual(matchedExcl, ["exclusivity"]);

  // The mirror: a usage-rights ask matches usageRights, not exclusivity.
  const matchedUsage = conflictAffectsCreatorCommitment(
    [usageConflict, exclusivityConflict],
    ["what are the usage rights?"],
    undefined,
    [],
  );
  assert.deepEqual(matchedUsage, ["usageRights"]);
});

test("review §5: a coarse-only open obligation in the SHARED usage_rights bucket does NOT back-fill (ambiguous)", () => {
  // An old open obligation carries only the coarse category "usage_rights" — it
  // can't tell usageRights from exclusivity — so with NO this-turn ask, neither
  // sibling escalates (conservative fallback).
  const matched = conflictAffectsCreatorCommitment(
    [usageConflict, exclusivityConflict],
    [], // silent this turn
    undefined,
    [{ category: "usage_rights" }],
  );
  assert.deepEqual(matched, []);
});

test("payment open obligation (unshared category) STILL back-fills — the round-2 clause survives §5", () => {
  // payment maps to exactly one field, so a coarse open obligation is unambiguous
  // and the prior-round re-surfacing behavior is preserved.
  const matched = conflictAffectsCreatorCommitment(
    [paymentConflict],
    [],
    undefined,
    [{ category: "payment" }],
  );
  assert.deepEqual(matched, ["paymentTerms"]);
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

console.log("\nknowledge snapshots — recovery and terminal-path persistence\n");

test("AVAILABLE with no conflicts is still an explicit clearing snapshot", () => {
  const record = buildKnowledgeRecord(
    { status: "AVAILABLE", text: "Campaign terms" },
    [],
  );
  assert.deepEqual(record, {
    knowledge: {
      briefAvailability: { status: "AVAILABLE" },
      conflicts: [],
    },
  });
});

test("knowledge snapshots never persist the full extracted brief text", () => {
  const record = buildKnowledgeRecord(
    {
      status: "PARTIAL",
      text: "sensitive full PDF extraction",
      fileReference: "briefs/campaign.pdf",
      missingSections: ["paymentTerms"],
    },
    [],
  );
  const knowledge = record["knowledge"] as Record<string, unknown>;
  assert.deepEqual(knowledge["briefAvailability"], {
    status: "PARTIAL",
    fileReference: "briefs/campaign.pdf",
    missingSections: ["paymentTerms"],
  });
  assert.equal(JSON.stringify(record).includes("sensitive full PDF extraction"), false);
});

test("knowledge snapshots retain the brief reference for operator provenance", () => {
  const record = buildKnowledgeRecord(
    { status: "AVAILABLE", fileReference: "briefs/campaign.pdf" },
    [],
  );
  const knowledge = record["knowledge"] as Record<string, unknown>;
  assert.deepEqual(knowledge["briefAvailability"], {
    status: "AVAILABLE",
    fileReference: "briefs/campaign.pdf",
  });
});

test("stdout conflict summaries never expose reasons or source values", () => {
  const summary = formatBriefConflictWarning([paymentConflict, usageConflict]);
  assert.equal(summary, "paymentTerms (p2); usageRights");
  assert.equal(summary.includes("Net 30"), false);
  assert.equal(summary.includes("Net 60"), false);
  assert.equal(summary.includes("90"), false);
  assert.equal(summary.includes("180"), false);
  assert.equal(summary.includes("mismatch"), false);
});

test("attaching a snapshot preserves escalation audit fields and nests conflicts", () => {
  const escalation = escalateMaterialConflict({
    round: 1,
    message: "when do I get paid?",
    conflictFields: ["paymentTerms"],
    conflicts: [paymentConflict],
  });
  const result = attachKnowledgeRecord(
    escalation,
    buildKnowledgeRecord(
      { status: "PARTIAL", missingSections: ["paymentTerms"] },
      [paymentConflict],
    ),
  );
  const payload = result.eventPayload as Record<string, unknown>;
  assert.equal(payload["reason"], "material_knowledge_conflict");
  assert.deepEqual(payload["conflictFields"], ["paymentTerms"]);
  assert.deepEqual(payload["knowledge"], {
    briefAvailability: { status: "PARTIAL", missingSections: ["paymentTerms"] },
    conflicts: [paymentConflict],
  });
});

console.log(`\n${n} passed\n`);
