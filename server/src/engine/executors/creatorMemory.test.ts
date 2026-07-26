/**
 * PLU-113 — pure unit tests for the creator-memory write-plan builder,
 * normalization, and the AI-context read payload (buildCreatorMemoryBlock).
 *
 * Pure functions over already-fetched rows / extracted facts — no DB, no network.
 *   npx tsx --test src/engine/executors/creatorMemory.test.ts
 */

import assert from "node:assert/strict";
import type { CampaignCreatorMemory } from "../../db/schema.js";
import {
  normalizeMemoryValue,
  buildMemoryWritePlan,
  buildCreatorMemoryBlock,
  isSingletonMemoryKey,
  memoryDedupKey,
  singletonSentinel,
  DEFAULT_MEMORY_MIN_CONFIDENCE,
} from "./creatorMemory.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// Minimal CampaignCreatorMemory factory — only the fields the pure fns read.
function fact(over: Partial<CampaignCreatorMemory>): CampaignCreatorMemory {
  return {
    id: over.id ?? "f1",
    instanceId: over.instanceId ?? "i1",
    key: over.key ?? "OBJECTION",
    status: over.status ?? "ACTIVE",
    value: over.value ?? "no exclusivity",
    valueNumber: over.valueNumber ?? null,
    normalizedValue: over.normalizedValue ?? "no exclusivity",
    category: over.category ?? null,
    sourceMessageId: over.sourceMessageId ?? null,
    source: over.source ?? "ai",
    confidence: over.confidence ?? 0.9,
    priorValue: over.priorValue ?? null,
    priorSourceMessageId: over.priorSourceMessageId ?? null,
    note: over.note ?? null,
    createdAt: over.createdAt ?? new Date(0),
    updatedAt: over.updatedAt ?? new Date(0),
  };
}

console.log("\nPLU-113 normalizeMemoryValue\n");

test("collapses case, punctuation, and whitespace", () => {
  assert.equal(normalizeMemoryValue("No  Exclusivity!!"), "no exclusivity");
  assert.equal(normalizeMemoryValue("  US   shipping,  only "), "us shipping only");
  assert.equal(
    normalizeMemoryValue("Reels ONLY — no static"),
    normalizeMemoryValue("reels only no static"),
  );
});

test("keeps DISTINCT values distinct (no fuzzy merge, §4.6/O3)", () => {
  // June 1 vs the first of June must NOT collapse — surfaced as change, not merged.
  assert.notEqual(
    normalizeMemoryValue("June 1st"),
    normalizeMemoryValue("the first of June"),
  );
  assert.notEqual(
    normalizeMemoryValue("no perpetual usage rights"),
    normalizeMemoryValue("no exclusivity"),
  );
});

console.log("\nPLU-113 key classification\n");

test("singleton vs list keys (§4.1)", () => {
  for (const k of ["REQUESTED_RATE", "MINIMUM_RATE", "AVAILABILITY", "MANAGER_INVOLVED", "MANAGER_CONTACT"] as const) {
    assert.equal(isSingletonMemoryKey(k), true, `${k} should be singleton`);
  }
  for (const k of ["OBJECTION", "LOGISTICS_CONSTRAINT", "DELIVERABLE_PREFERENCE", "COMPENSATION_PREFERENCE"] as const) {
    assert.equal(isSingletonMemoryKey(k), false, `${k} should be a list key`);
  }
});

test("dedup key: sentinel for singleton, normalize(value) for list", () => {
  assert.equal(memoryDedupKey("AVAILABILITY", "abc"), singletonSentinel("AVAILABILITY"));
  assert.equal(memoryDedupKey("OBJECTION", "no exclusivity"), "no exclusivity");
});

console.log("\nPLU-113 buildMemoryWritePlan\n");

test("REQUESTED_RATE derives from creatorRequestedRate, not model facts (§4.4)", () => {
  const plan = buildMemoryWritePlan({
    creatorRequestedRate: 600,
    // A model-emitted REQUESTED_RATE must be IGNORED in favor of the validated ask.
    creatorFacts: [{ key: "REQUESTED_RATE", value: "999", confidence: 1 }],
  });
  const rate = plan.filter((p) => p.key === "REQUESTED_RATE");
  assert.equal(rate.length, 1);
  assert.equal(rate[0]!.value, "600");
  assert.equal(rate[0]!.valueNumber, 600);
  assert.equal(rate[0]!.singleton, true);
  assert.equal(rate[0]!.normalizedValue, singletonSentinel("REQUESTED_RATE"));
});

test("drops facts below the confidence floor (§4.5, invariant #4)", () => {
  const plan = buildMemoryWritePlan({
    creatorFacts: [
      { key: "OBJECTION", value: "no exclusivity", confidence: 0.9 },
      { key: "AVAILABILITY", value: "free after Aug", confidence: 0.2 },
      { key: "OBJECTION", value: "no usage rights" }, // no confidence → 0 → dropped
    ],
    minConfidence: DEFAULT_MEMORY_MIN_CONFIDENCE,
  });
  const values = plan.map((p) => p.value);
  assert.deepEqual(values, ["no exclusivity"]);
});

test("a new list fact → one plan item; intra-turn duplicates collapse", () => {
  const plan = buildMemoryWritePlan({
    creatorFacts: [
      { key: "OBJECTION", value: "no exclusivity", confidence: 1 },
      { key: "OBJECTION", value: "No  Exclusivity!", confidence: 1 }, // same normalized
      { key: "OBJECTION", value: "no usage rights", confidence: 1 }, // distinct
    ],
  });
  const objections = plan.filter((p) => p.key === "OBJECTION");
  assert.equal(objections.length, 2);
});

test("singleton fact gets the sentinel index key; list fact gets normalize(value)", () => {
  const plan = buildMemoryWritePlan({
    creatorFacts: [
      { key: "AVAILABILITY", value: "unavailable until Aug 15", confidence: 1 },
      { key: "LOGISTICS_CONSTRAINT", value: "US shipping only", confidence: 1 },
    ],
  });
  const avail = plan.find((p) => p.key === "AVAILABILITY")!;
  const logi = plan.find((p) => p.key === "LOGISTICS_CONSTRAINT")!;
  assert.equal(avail.normalizedValue, singletonSentinel("AVAILABILITY"));
  assert.equal(logi.normalizedValue, "us shipping only");
});

test("drops unknown keys + empty values", () => {
  const plan = buildMemoryWritePlan({
    creatorFacts: [
      { key: "NOT_A_KEY" as unknown as "OBJECTION", value: "x", confidence: 1 },
      { key: "OBJECTION", value: "   ", confidence: 1 },
    ],
  });
  assert.equal(plan.length, 0);
});

test("MINIMUM_RATE carries a numeric mirror", () => {
  const plan = buildMemoryWritePlan({
    creatorFacts: [{ key: "MINIMUM_RATE", value: "$450", confidence: 1 }],
  });
  const min = plan.find((p) => p.key === "MINIMUM_RATE")!;
  assert.equal(min.valueNumber, 450);
  assert.equal(min.singleton, true);
});

test("no facts + no rate → empty plan (flag-off / rules mode)", () => {
  assert.deepEqual(buildMemoryWritePlan({}), []);
  assert.deepEqual(buildMemoryWritePlan({ creatorFacts: [] }), []);
});

console.log("\nPLU-113 buildCreatorMemoryBlock\n");

test("returns null when there are no live rows (invariant #8)", () => {
  assert.equal(buildCreatorMemoryBlock([]), null);
  assert.equal(
    buildCreatorMemoryBlock([fact({ status: "REMOVED" }), fact({ status: "SUPERSEDED" })]),
    null,
  );
});

test("groups live facts by key; excludes SUPERSEDED/REMOVED", () => {
  const block = buildCreatorMemoryBlock([
    fact({ key: "REQUESTED_RATE", value: "600", status: "ACTIVE" }),
    fact({ key: "OBJECTION", value: "no exclusivity", status: "ACTIVE" }),
    fact({ key: "OBJECTION", value: "no usage rights", status: "ACTIVE" }),
    fact({ key: "MANAGER_INVOLVED", value: "true", status: "ACTIVE" }),
    fact({ key: "AVAILABILITY", value: "gone until Aug", status: "REMOVED" }),
  ]);
  assert.ok(block);
  assert.equal(block!.requestedRate, "600");
  assert.deepEqual(block!.objections, ["no exclusivity", "no usage rights"]);
  assert.equal(block!.managerInvolved, true);
  assert.equal(block!.availability, undefined); // REMOVED excluded
});

test("surfaces CONFLICTED with both values (invariant #5)", () => {
  const block = buildCreatorMemoryBlock([
    fact({
      key: "REQUESTED_RATE",
      value: "600",
      status: "CONFLICTED",
      priorValue: "400",
    }),
  ]);
  assert.ok(block);
  assert.equal(block!.requestedRate, "600"); // current value used
  assert.equal(block!.conflicts.length, 1);
  assert.deepEqual(block!.conflicts[0], {
    key: "REQUESTED_RATE",
    current: "600",
    prior: "400",
  });
});

console.log(`\nPLU-113 creatorMemory: ${n} passed\n`);
