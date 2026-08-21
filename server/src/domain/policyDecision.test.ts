/**
 * PLU-172 — unit tests for the frozen CounterDelta -> PolicyDecision types
 * and the creator-safety reason-code rule. Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/policyDecision.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATOR_SAFE_REASON_KEYS,
  creatorSafeReasonKeyFor,
  POLICY_DECISION_REASON_CODES,
} from "./policyDecision.js";

console.log("\nthe creator-safety collapsing rule (review item 18)\n");

test("exceeds_limit, explicitly_fixed, and mode_requires_approval all resolve to the IDENTICAL creator-facing key", () => {
  const exceedsLimitKey = creatorSafeReasonKeyFor("exceeds_limit");
  const explicitlyFixedKey = creatorSafeReasonKeyFor("explicitly_fixed");
  const modeRequiresApprovalKey = creatorSafeReasonKeyFor("mode_requires_approval");
  assert.ok(exceedsLimitKey, "exceeds_limit must map to SOME creator-safe key");
  assert.equal(
    exceedsLimitKey,
    explicitlyFixedKey,
    "a creator must not be able to distinguish 'over my limit' from 'this term is fixed' from the response alone",
  );
  assert.equal(
    exceedsLimitKey,
    modeRequiresApprovalKey,
    "a creator must not be able to distinguish 'over my limit' from 'I don't auto-decide this' from the response alone — this is exactly what prevents a round-over-round binary search of the brand's real ceiling",
  );
});

test("out_of_policy_reject has its own distinct key (a genuine rejection is a different fact than 'needs approval')", () => {
  assert.notEqual(creatorSafeReasonKeyFor("out_of_policy_reject"), creatorSafeReasonKeyFor("exceeds_limit"));
});

test("within_limit and matches_public_offer both resolve to an 'approved' key", () => {
  assert.equal(creatorSafeReasonKeyFor("within_limit"), creatorSafeReasonKeyFor("matches_public_offer"));
});

test("a reasonCode with no mapped creator-safe key returns undefined, never falls back to the raw code", () => {
  // Every code the map deliberately omits (internal/audit-only, e.g. an
  // ambiguous or malformed-input signal) must render NOTHING creator-facing
  // rather than leak the internal code string itself.
  const unmapped = POLICY_DECISION_REASON_CODES.filter((c) => !(c in CREATOR_SAFE_REASON_KEYS));
  assert.ok(unmapped.length > 0, "sanity: this test needs at least one deliberately-unmapped code to exist");
  for (const code of unmapped) {
    assert.equal(creatorSafeReasonKeyFor(code), undefined);
  }
});

test("every reasonCode in the map resolves to a non-empty string key", () => {
  for (const [code, key] of Object.entries(CREATOR_SAFE_REASON_KEYS)) {
    assert.equal(typeof key, "string", `${code}'s mapped key must be a string`);
    assert.ok((key as string).length > 0);
  }
});
