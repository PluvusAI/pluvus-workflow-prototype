/**
 * PLU-111 — pure unit tests for the obligation plan builder + normalization +
 * the AI-context read (buildOpenObligations) + the empty-table fallback.
 *
 * Pure functions over already-fetched rows — no DB, no network. Run with:
 *   npx tsx --test src/engine/executors/obligationPlan.test.ts
 */

import assert from "node:assert/strict";
import type { ConversationObligation } from "../../db/schema.js";
import {
  normalizeObligationKey,
  buildQuestionObligationPlan,
  buildOpenObligations,
  buildStructuredObligations,
  computeOpenQuestions,
} from "./negotiationHistory.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Minimal ConversationObligation factory — only the fields the pure fns read.
function ob(over: Partial<ConversationObligation>): ConversationObligation {
  return {
    id: over.id ?? "ob1",
    instanceId: over.instanceId ?? "i1",
    type: over.type ?? "CREATOR_QUESTION",
    status: over.status ?? "OPEN",
    originalText: over.originalText ?? "what's the fee?",
    normalizedKey: over.normalizedKey ?? normalizeObligationKey(over.originalText ?? "what's the fee?"),
    category: over.category ?? null,
    resolution: over.resolution ?? null,
    resolutionSource: over.resolutionSource ?? null,
    sourceMessageId: over.sourceMessageId ?? null,
    resolutionMessageId: over.resolutionMessageId ?? null,
    createdAt: over.createdAt ?? new Date(0),
    updatedAt: over.updatedAt ?? new Date(0),
    resolvedAt: over.resolvedAt ?? null,
  };
}

console.log("\nPLU-111 normalizeObligationKey\n");

test("collapses case, punctuation, and whitespace", () => {
  assert.equal(normalizeObligationKey("What's the FEE?"), "what s the fee");
  assert.equal(normalizeObligationKey("  usage   rights??  "), "usage rights");
  assert.equal(
    normalizeObligationKey("When do I get PAID?!"),
    normalizeObligationKey("when do i get paid"),
  );
});

test("keeps DISTINCT wording distinct (no fuzzy/semantic merge)", () => {
  // Adversarial pairs that MUST stay distinct — a semantic merge would drop a
  // real ask (invariant #3). Only exact-normalized matches collapse.
  const pairs: [string, string][] = [
    ["what's the deadline?", "when is this due?"],
    ["do I keep the product?", "is the product a gift?"],
    ["how many reels?", "how many stories?"],
    ["is 10% on top of the fee?", "is 10% instead of the fee?"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(
      normalizeObligationKey(a),
      normalizeObligationKey(b),
      `"${a}" and "${b}" must not collapse to the same key`,
    );
  }
});

console.log("\nPLU-111 buildQuestionObligationPlan\n");

test("a brand-new question → insert", () => {
  const plan = buildQuestionObligationPlan(["what's the fee?"], []);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.op, "insert");
  assert.equal(plan[0]!.originalText, "what's the fee?");
});

test("a re-ask matching an OPEN row's normalizedKey → touch, no insert", () => {
  const existing = [ob({ id: "q1", originalText: "What are the usage rights?" })];
  // Rephrased punctuation/case only — same normalized key ("what are the usage
  // rights"). A genuine cross-turn re-ask must UPDATE, not mint a duplicate.
  const plan = buildQuestionObligationPlan(["what are the usage rights"], existing);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.op, "touch");
  assert.equal(plan[0]!.existingId, "q1");
});

test("two DISTINCT questions → two inserts", () => {
  const plan = buildQuestionObligationPlan(
    ["what's the fee?", "when do I get paid?"],
    [],
  );
  assert.equal(plan.length, 2);
  assert.ok(plan.every((p) => p.op === "insert"));
});

test("a re-ask matching only a TERMINAL row → insert (a new open thread)", () => {
  // The executor only passes NON-TERMINAL existing rows to the builder, so an
  // ANSWERED row is not in existingOpenRows → the re-ask correctly inserts.
  const answered = [ob({ id: "q1", status: "ANSWERED", originalText: "what's the fee?" })];
  const openOnly = answered.filter((r) => r.status === "OPEN"); // == []
  const plan = buildQuestionObligationPlan(["what's the fee?"], openOnly);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.op, "insert");
});

test("intra-turn duplicates collapse to a single plan item (first wording wins)", () => {
  const plan = buildQuestionObligationPlan(
    ["Usage rights??", "usage rights"],
    [],
  );
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.originalText, "Usage rights??");
});

test("blank / whitespace-only questions are skipped", () => {
  const plan = buildQuestionObligationPlan(["   ", "", "real one"], []);
  assert.equal(plan.length, 1);
  assert.equal(plan[0]!.originalText, "real one");
});

test("category detector is applied when provided", () => {
  const plan = buildQuestionObligationPlan(
    ["what are the usage rights?"],
    [],
    (q) => (q.includes("usage rights") ? "usage_rights" : undefined),
  );
  assert.equal(plan[0]!.category, "usage_rights");
});

console.log("\nPLU-111 buildOpenObligations (AI-context read)\n");

test("splits non-terminal rows into questions vs commitments", () => {
  const rows = [
    ob({ id: "q1", type: "CREATOR_QUESTION", originalText: "what's the fee?" }),
    ob({ id: "c1", type: "PLUVUS_COMMITMENT", originalText: "confirm usage rights" }),
    ob({ id: "q2", type: "CREATOR_QUESTION", originalText: "when do I get paid?" }),
  ];
  const split = buildOpenObligations(rows);
  assert.deepEqual(split.openQuestions, ["what's the fee?", "when do I get paid?"]);
  assert.deepEqual(split.openCommitments, ["confirm usage rights"]);
});

test("de-duplicates case-insensitively within each type", () => {
  const rows = [
    ob({ id: "q1", type: "CREATOR_QUESTION", originalText: "Usage rights?" }),
    ob({ id: "q2", type: "CREATOR_QUESTION", originalText: "usage rights?" }),
  ];
  const split = buildOpenObligations(rows);
  assert.deepEqual(split.openQuestions, ["Usage rights?"]);
});

test("empty rows → empty split (caller then falls back to computeOpenQuestions)", () => {
  const split = buildOpenObligations([]);
  assert.deepEqual(split.openQuestions, []);
  assert.deepEqual(split.openCommitments, []);
});

console.log("\nPLU-111 fallback parity with computeOpenQuestions\n");

test("empty ledger → the executor's fallback yields today's diff output", () => {
  // The executor uses buildOpenObligations only when the ledger has rows; with an
  // empty ledger it calls computeOpenQuestions. This asserts the two are wired to
  // the SAME event-diff so behavior is byte-identical when the table is empty.
  const events = [
    {
      id: "e1",
      instanceId: "i1",
      type: "NEGOTIATION_TURN" as const,
      nodeId: null,
      payload: { outcome: "counter", round: 1, creatorQuestions: ["when do I get paid?"] } as never,
      occurredAt: new Date(10),
    },
  ];
  const fallback = computeOpenQuestions(events, ["what's the fee?"]);
  assert.deepEqual(fallback, ["when do I get paid?"]);
  // And an empty ledger split contributes nothing on top.
  assert.deepEqual(buildOpenObligations([]).openQuestions, []);
});

// ---------------------------------------------------------------------------
// PLU-114: buildStructuredObligations — {id, originalText, category} projection
// ---------------------------------------------------------------------------
console.log("\nPLU-114 buildStructuredObligations\n");

test("projects id + originalText + category for each row", () => {
  const out = buildStructuredObligations([
    ob({ id: "a", originalText: "when does it ship?", category: "shipping" }),
    ob({ id: "b", originalText: "how long can you use my content?", category: "usage_rights" }),
  ]);
  assert.deepEqual(out, [
    { id: "a", originalText: "when does it ship?", category: "shipping" },
    { id: "b", originalText: "how long can you use my content?", category: "usage_rights" },
  ]);
});

test("omits category when null (router falls back to originalText routing)", () => {
  const out = buildStructuredObligations([ob({ id: "a", originalText: "any update?", category: null })]);
  assert.deepEqual(out, [{ id: "a", originalText: "any update?" }]);
  assert.ok(!("category" in out[0]!));
});

test("includes BOTH creator questions and Pluvus commitments", () => {
  const out = buildStructuredObligations([
    ob({ id: "q", type: "CREATOR_QUESTION", originalText: "when do I get paid?" }),
    ob({ id: "c", type: "PLUVUS_COMMITMENT", originalText: "I'll confirm the shipping timeline", category: "shipping" }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((o) => o.id), ["q", "c"]);
});

test("dedups by originalText case-insensitively, preserving order", () => {
  const out = buildStructuredObligations([
    ob({ id: "a", originalText: "When does it ship?" }),
    ob({ id: "b", originalText: "when does it SHIP?" }),
    ob({ id: "c", originalText: "how long can you use it?" }),
  ]);
  assert.deepEqual(out.map((o) => o.id), ["a", "c"]);
});

test("skips blank originalText", () => {
  const out = buildStructuredObligations([ob({ id: "a", originalText: "   " })]);
  assert.deepEqual(out, []);
});

test("empty in → empty out (no wire field attached)", () => {
  assert.deepEqual(buildStructuredObligations([]), []);
});

console.log(`\n✓ obligationPlan: all ${n} tests passed\n`);
