/**
 * PLU-81 §6.1 (Calvin review #3) — the withContextRecord fold contract.
 *
 * Proves the two sanitized observability records (PLU-82 `knowledge`, PLU-81
 * `context`) are stamped onto EVERY post-build NodeResult, including the
 * failure/escalation outcomes that previously got no record — the exact turns an
 * operator most needs the panels. Pure over foldObservabilityRecords (the helper
 * the executor's per-turn `withContextRecord` closure delegates to), so no DB.
 *
 * Run:  cd server && node --import tsx --test src/engine/executors/withContextRecord.test.ts
 */

import assert from "node:assert/strict";
import type { NodeResult } from "../types.js";
import {
  foldObservabilityRecords,
  escalateMaterialConflict,
  escalateOverCeiling,
} from "./negotiation.js";
import type { BriefFieldConflict } from "./briefKnowledge.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Representative records the executor builds each turn (labels/keys/counts only —
// §7.2 shapes; the exact values don't matter to the fold contract, only that both
// keys land and existing payload keys survive).
const KNOWLEDGE = {
  knowledge: {
    briefAvailability: { status: "PARTIAL" as const },
    conflicts: [{ section: "paymentTerms" }],
  },
};
const CONTEXT = {
  context: {
    purpose: "NEGOTIATION_DECISION",
    messageIdsIncluded: ["m1", "m2"],
    eventCount: 2,
    campaignFieldsSelected: ["usageRights"],
    briefSectionsUsed: [],
    openObligationIds: [],
    estimatedTokens: 128,
    sourcesUsed: ["campaign:usageRights", "band:present"],
    bandPresent: true,
    briefAvailability: { status: "PARTIAL" as const },
  },
};

console.log("\nfoldObservabilityRecords — §6.1 fold contract\n");

test("stamps BOTH knowledge and context onto a draft-failure MANUAL_REVIEW result", () => {
  // A draft-generation failure result (the shape draftUnavailable produces).
  const draftFail: NodeResult = {
    nextState: "MANUAL_REVIEW",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: { outcome: "ESCALATE", reason: "draft_generation_failed", purpose: "counter_offer", round: 2 },
  };
  const folded = foldObservabilityRecords(draftFail, KNOWLEDGE, CONTEXT);
  const p = folded.eventPayload as Record<string, unknown>;
  // The exact turns an operator needs the panels — now populated.
  assert.ok(p["context"], "context record present on a draft-failure result");
  assert.ok(p["knowledge"], "knowledge record present on a draft-failure result");
  // Original payload keys survive untouched.
  assert.equal(p["outcome"], "ESCALATE");
  assert.equal(p["reason"], "draft_generation_failed");
  assert.equal(p["round"], 2);
});

test("stamps BOTH records onto a material-conflict escalation result", () => {
  const conflict: BriefFieldConflict = {
    section: "paymentTerms",
    campaignField: "paymentTerms",
    campaignValue: "Net 30",
    briefExcerpt: "Net 60",
    reason: "net-days mismatch",
  };
  const escalation = escalateMaterialConflict({
    round: 1,
    message: "when do I get paid?",
    conflictFields: ["paymentTerms"],
    conflicts: [conflict],
  });
  const folded = foldObservabilityRecords(escalation, KNOWLEDGE, CONTEXT);
  const p = folded.eventPayload as Record<string, unknown>;
  assert.ok(p["context"], "context record present on a material-conflict escalation");
  assert.ok(p["knowledge"], "knowledge record present on a material-conflict escalation");
  // The escalation's own audit keys are preserved.
  assert.equal(p["outcome"], "ESCALATE");
  assert.equal(p["reason"], "material_knowledge_conflict");
  assert.deepEqual(p["conflictFields"], ["paymentTerms"]);
});

test("stamps BOTH records onto an over-ceiling escalate result", () => {
  const escalate = escalateOverCeiling({ round: 3, message: "above budget", creatorRate: 5000 });
  const folded = foldObservabilityRecords(escalate, KNOWLEDGE, CONTEXT);
  const p = folded.eventPayload as Record<string, unknown>;
  assert.ok(p["context"], "context present on over-ceiling escalate");
  assert.ok(p["knowledge"], "knowledge present on over-ceiling escalate");
  assert.equal(p["creatorRate"], 5000, "audit field survives the fold");
});

test("an empty knowledgeRecord ({}) folds only context — no stray knowledge key", () => {
  // AVAILABLE + no conflicts ⇒ knowledgeRecord is {} (the byte-identical-when-nothing-
  // to-say contract). The fold must then add ONLY context.
  const result: NodeResult = {
    nextState: "REJECTED",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: { outcome: "REJECT", round: 1 },
  };
  const folded = foldObservabilityRecords(result, {}, CONTEXT);
  const p = folded.eventPayload as Record<string, unknown>;
  assert.ok(p["context"], "context present");
  assert.ok(!("knowledge" in p), "no knowledge key when the record is empty");
});

test("never overwrites an already-present record (defensive) and never drops the rest of the payload", () => {
  const preStamped: NodeResult = {
    nextState: "ACCEPTED",
    nextNodeId: null,
    completedAt: new Date(),
    eventType: "NEGOTIATION_TURN",
    eventPayload: { outcome: "ACCEPT", round: 4, rate: 350, context: { sentinel: true } },
  };
  const folded = foldObservabilityRecords(preStamped, KNOWLEDGE, CONTEXT);
  const p = folded.eventPayload as Record<string, unknown>;
  // Existing context wins (payload spread last), knowledge is added, money keys stay.
  assert.deepEqual(p["context"], { sentinel: true }, "an already-present context is not clobbered");
  assert.ok(p["knowledge"], "knowledge still added");
  assert.equal(p["rate"], 350, "money key preserved");
  assert.equal(p["outcome"], "ACCEPT");
});

test("a result with no eventPayload is returned untouched", () => {
  // Defensive branch — no post-build path lacks an eventPayload today, but the fold
  // must be a no-op if one ever does (never fabricate a payload just to hold a record).
  const noPayload: NodeResult = {
    nextState: "AWAITING_REPLY",
    nextNodeId: "n1",
    eventType: "NEGOTIATION_TURN",
  };
  const folded = foldObservabilityRecords(noPayload, KNOWLEDGE, CONTEXT);
  assert.equal(folded.eventPayload, undefined, "no eventPayload → nothing folded");
  assert.equal(folded.nextState, "AWAITING_REPLY");
});

console.log(`\n${n} passed\n`);
