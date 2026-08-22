/**
 * PLU-172 — unit tests for the backend capability map. Pure logic — no DB.
 * Run with: npx tsx --test src/domain/policyCapabilities.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { POLICY_CAPABILITIES, getPolicyCapability, isExecutable } from "./policyCapabilities.js";

// PLU-172 review item 20: an explicit snapshot list, not a loose "some are
// true" assertion — a category flipping to executable is a deliberate act
// by whichever of PLU-175/176/178 lands its evaluator, never an accident.
const EXPECTED_CATEGORIES = [
  "fee",
  "commission",
  "commissionDuration",
  "giftSubstitution",
  "giftCashReplacement",
  "deliverables",
  "posting",
  "usageRights",
  "exclusivity",
  "adAuthorization",
  "postRetention",
  "contentRepurposeRights",
  "scriptSubmission",
];

test("every expected category is present, exactly once, with persisted+snapshotted true", () => {
  assert.equal(POLICY_CAPABILITIES.length, EXPECTED_CATEGORIES.length);
  for (const category of EXPECTED_CATEGORIES) {
    const matches = POLICY_CAPABILITIES.filter((c) => c.category === category);
    assert.equal(matches.length, 1, `"${category}" must appear exactly once`);
    assert.equal(matches[0]!.persisted, true, `"${category}" must be persisted at PLU-172 ship time`);
    assert.equal(matches[0]!.snapshotted, true, `"${category}" must be snapshotted at PLU-172 ship time`);
  }
});

// PLU-175 (domain/compensationPolicyEvaluator.ts) is the first evaluator to
// land — it flips exactly these five categories. Every other category still
// waits on PLU-176/178.
const PLU_175_EVALUATED_CATEGORIES = [
  "fee",
  "commission",
  "commissionDuration",
  "giftSubstitution",
  "giftCashReplacement",
];

test("only PLU-175's five compensation categories report evaluated: true; everything else still waits on PLU-176/178", () => {
  for (const cap of POLICY_CAPABILITIES) {
    const expected = PLU_175_EVALUATED_CATEGORIES.includes(cap.category);
    assert.equal(
      cap.evaluated,
      expected,
      expected
        ? `"${cap.category}" must claim its PLU-175 evaluator`
        : `"${cap.category}" must not claim an evaluator this ticket didn't ship`,
    );
  }
});

test("commission's supportedUnits is narrowed to percent only — flat/two-level are explicitly out of PLU-175's scope", () => {
  const commission = getPolicyCapability("commission" as never);
  assert.deepEqual(commission?.supportedUnits, ["percent"]);
});

test("isExecutable matches evaluated exactly for every category (persisted && snapshotted are true for all of them)", () => {
  for (const category of EXPECTED_CATEGORIES) {
    const expected = PLU_175_EVALUATED_CATEGORIES.includes(category);
    assert.equal(isExecutable(category as never), expected);
  }
});

test("isExecutable is false for an unknown category (no matching capability record)", () => {
  assert.equal(isExecutable("not_a_real_category" as never), false);
});

test("getPolicyCapability returns undefined for an unknown category", () => {
  assert.equal(getPolicyCapability("not_a_real_category" as never), undefined);
});

test("persisted/snapshotted/evaluated are real booleans, not the literal type `true` (review item 20)", () => {
  // A structural check: PolicyCapability's TYPE allows false — verified by
  // actually constructing one with false values and confirming it type-checks
  // (this file itself compiling with the assignment below IS the assertion;
  // if the interface still pinned `persisted: true` as a literal, this
  // would be a compile error, not a runtime one).
  const hypothetical: (typeof POLICY_CAPABILITIES)[number] = {
    category: "fee",
    persisted: false,
    snapshotted: false,
    evaluated: false,
  };
  assert.equal(hypothetical.persisted, false);
});
