/**
 * PLU-176 — unit tests for the deterministic rights, exclusivity, and
 * script-submission evaluator. Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/rightsPolicyEvaluator.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRightsTerm,
  evaluateRightsPackage,
  type RightsPolicySnapshot,
} from "./rightsPolicyEvaluator.js";
import type { CounterDelta } from "./policyDecision.js";
import type { RightsPolicyRule } from "./rightsPolicyRules.js";

// A fully-specified, deliberately conservative baseline (every duration
// term active but KEEP_REQUESTED, script required but KEEP_SUBMISSION_REQUIRED)
// every test starts from and overrides only the fields it cares about.
const BASE_SNAPSHOT: RightsPolicySnapshot = {
  adAuthorization: "6 months",
  postRetention: "12 months",
  contentRepurposeRights: "1 year",
  exclusivity: "3 months exclusive",
  scriptSubmission: "require",
  rightsPolicyRules: [],
  scriptWaiverMode: "KEEP_SUBMISSION_REQUIRED",
  outOfPolicyAction: "ASK_FOR_APPROVAL",
};

function snap(overrides: Partial<RightsPolicySnapshot>): RightsPolicySnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

function delta(overrides: Partial<CounterDelta> & Pick<CounterDelta, "category">): CounterDelta {
  return { normalization: "EXACT", ...overrides };
}

function rule(overrides: Partial<RightsPolicyRule> & Pick<RightsPolicyRule, "term" | "mode">): RightsPolicyRule {
  return overrides;
}

const DURATION_TERMS = ["adAuthorization", "postRetention", "contentRepurposeRights", "exclusivity"] as const;

// ===========================================================================
// Determinism
// ===========================================================================

test("determinism: the same typed input returns the identical decision on repeated calls", () => {
  const s = snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 90, minimumUnit: "DAYS" })] });
  const d = delta({ category: "postRetention", proposedValue: 120, proposedUnit: "DAYS" });
  assert.deepEqual(evaluateRightsTerm(d, s), evaluateRightsTerm(d, s));
});

// ===========================================================================
// KEEP_REQUESTED / ALLOW_TO_MINIMUM / ASK_FOR_APPROVAL — one triplet per
// duration-bearing term (adAuthorization, postRetention,
// contentRepurposeRights, exclusivity)
// ===========================================================================

for (const term of DURATION_TERMS) {
  test(`${term}: KEEP_REQUESTED (absent rule, conservative default) never auto-approves — "exact public duration" case included`, () => {
    // Even a proposal that LOOKS identical to what's already publicly
    // offered is non-autonomous: the evaluator never parses the free-text
    // public value to check for a match (plan doc §4.3).
    const d = evaluateRightsTerm(
      delta({ category: term, proposedValue: 180, proposedUnit: "DAYS" }),
      snap({ rightsPolicyRules: [] }),
    );
    assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
    assert.equal(d.reasonCode, "explicitly_fixed");
  });

  test(`${term}: KEEP_REQUESTED is REJECTED when outOfPolicyAction is REJECT_REQUEST`, () => {
    const d = evaluateRightsTerm(
      delta({ category: term, proposedValue: 30, proposedUnit: "DAYS" }),
      snap({ rightsPolicyRules: [], outOfPolicyAction: "REJECT_REQUEST" }),
    );
    assert.equal(d.outcome, "REJECTED");
    assert.equal(d.reasonCode, "out_of_policy_reject");
  });

  test(`${term}: ALLOW_TO_MINIMUM boundary — at/above the minimum auto-approves ("allowed minimum")`, () => {
    const atMinimum = evaluateRightsTerm(
      delta({ category: term, proposedValue: 90, proposedUnit: "DAYS" }),
      snap({ rightsPolicyRules: [rule({ term, mode: "ALLOW_TO_MINIMUM", minimumValue: 90, minimumUnit: "DAYS" })] }),
    );
    assert.equal(atMinimum.outcome, "AUTO_APPROVED");
    assert.equal(atMinimum.reasonCode, "within_limit");
    assert.equal(atMinimum.appliedValue, 90);

    const aboveMinimum = evaluateRightsTerm(
      delta({ category: term, proposedValue: 120, proposedUnit: "DAYS" }),
      snap({ rightsPolicyRules: [rule({ term, mode: "ALLOW_TO_MINIMUM", minimumValue: 90, minimumUnit: "DAYS" })] }),
    );
    assert.equal(aboveMinimum.outcome, "AUTO_APPROVED");
  });

  test(`${term}: ALLOW_TO_MINIMUM boundary — below the minimum is non-autonomous ("outside-minimum")`, () => {
    const d = evaluateRightsTerm(
      delta({ category: term, proposedValue: 89, proposedUnit: "DAYS" }),
      snap({ rightsPolicyRules: [rule({ term, mode: "ALLOW_TO_MINIMUM", minimumValue: 90, minimumUnit: "DAYS" })] }),
    );
    assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
    assert.equal(d.reasonCode, "exceeds_limit");
  });

  test(`${term}: ASK_FOR_APPROVAL always requires brand approval, regardless of value`, () => {
    const d = evaluateRightsTerm(
      delta({ category: term, proposedValue: 1, proposedUnit: "DAYS" }),
      snap({ rightsPolicyRules: [rule({ term, mode: "ASK_FOR_APPROVAL" })] }),
    );
    assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
    assert.equal(d.reasonCode, "mode_requires_approval");
  });

  test(`${term}: ALLOW_TO_MINIMUM with no minimum configured fails closed, never AUTO_APPROVED`, () => {
    const d = evaluateRightsTerm(
      delta({ category: term, proposedValue: 1, proposedUnit: "DAYS" }),
      snap({ rightsPolicyRules: [rule({ term, mode: "ALLOW_TO_MINIMUM" })] }),
    );
    assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
    assert.equal(d.reasonCode, "no_limit_configured");
  });

  // Review fix (C1): the unit check used to run unconditionally BEFORE the
  // mode was looked up, so a malformed/missing unit on a KEEP_REQUESTED or
  // ASK_FOR_APPROVAL term incorrectly produced UNSUPPORTED/missing_unit
  // instead of that mode's own outcome — contradicting "KEEP_REQUESTED
  // treats any proposal as a relax request, full stop" and silently
  // downgrading what should be REJECTED (under outOfPolicyAction:
  // REJECT_REQUEST) to UNSUPPORTED, a materially different outcome in
  // buildAggregatePolicyDecision's precedence.
  test(`${term}: KEEP_REQUESTED still produces its own non-autonomous outcome even with NO unit on the proposal at all`, () => {
    const d = evaluateRightsTerm(
      delta({ category: term, proposedValue: "some duration" }), // no proposedUnit
      snap({ rightsPolicyRules: [] }),
    );
    assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
    assert.equal(d.reasonCode, "explicitly_fixed");
  });

  test(`${term}: KEEP_REQUESTED with no unit is REJECTED (not UNSUPPORTED) when outOfPolicyAction is REJECT_REQUEST`, () => {
    const d = evaluateRightsTerm(
      delta({ category: term, proposedValue: "some duration" }),
      snap({ rightsPolicyRules: [], outOfPolicyAction: "REJECT_REQUEST" }),
    );
    assert.equal(d.outcome, "REJECTED");
    assert.equal(d.reasonCode, "out_of_policy_reject");
  });

  test(`${term}: ASK_FOR_APPROVAL still requires approval even with a malformed unit on the proposal`, () => {
    const d = evaluateRightsTerm(
      // @ts-expect-error deliberately malformed unit — ASK_FOR_APPROVAL
      // never inspects it at all.
      delta({ category: term, proposedValue: 1, proposedUnit: "WEEKS" }),
      snap({ rightsPolicyRules: [rule({ term, mode: "ASK_FOR_APPROVAL" })] }),
    );
    assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
    assert.equal(d.reasonCode, "mode_requires_approval");
  });
}

// ===========================================================================
// COUNT semantics + LIFETIME-as-floor
// ===========================================================================

test("postRetention: COUNT semantics — boundary at/above/below the minimum", () => {
  const s = snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 3, minimumUnit: "COUNT" })] });

  const at = evaluateRightsTerm(delta({ category: "postRetention", proposedValue: 3, proposedUnit: "COUNT" }), s);
  assert.equal(at.outcome, "AUTO_APPROVED");

  const below = evaluateRightsTerm(delta({ category: "postRetention", proposedValue: 2, proposedUnit: "COUNT" }), s);
  assert.equal(below.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(below.reasonCode, "exceeds_limit");
});

test("adAuthorization: a LIFETIME minimum auto-approves a matching LIFETIME proposal (floor equality, no numeric compare)", () => {
  const d = evaluateRightsTerm(
    delta({ category: "adAuthorization", proposedValue: "forever", proposedUnit: "LIFETIME" }),
    snap({ rightsPolicyRules: [rule({ term: "adAuthorization", mode: "ALLOW_TO_MINIMUM", minimumUnit: "LIFETIME" })] }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "within_limit");
});

// Review fix (B2): the LIFETIME branch used to pass delta.proposedValue
// straight into appliedValue with no validation — the only numeric path in
// the file that skipped asNonNegativeFiniteNumber. A malformed, negative,
// or absent proposedValue still auto-approves (the unit match alone is the
// grant — plan doc §4.4), but the unvalidated value must never be recorded
// in the decision.
const LIFETIME_LEAK_CASES: readonly [string, number | string][] = [
  ["negative", -500],
  ["non-numeric string", "whatever"],
];
for (const [label, proposedValue] of LIFETIME_LEAK_CASES) {
  test(`adAuthorization: a LIFETIME minimum auto-approves regardless of a ${label} proposedValue, but never records it`, () => {
    const d = evaluateRightsTerm(
      delta({ category: "adAuthorization", proposedValue, proposedUnit: "LIFETIME" }),
      snap({ rightsPolicyRules: [rule({ term: "adAuthorization", mode: "ALLOW_TO_MINIMUM", minimumUnit: "LIFETIME" })] }),
    );
    assert.equal(d.outcome, "AUTO_APPROVED");
    assert.equal(d.appliedValue, undefined, "an unvalidated proposedValue must never leak into appliedValue");
  });
}

test("adAuthorization: a LIFETIME minimum auto-approves with NO proposedValue at all, and records nothing", () => {
  const d = evaluateRightsTerm(
    delta({ category: "adAuthorization", proposedUnit: "LIFETIME" }),
    snap({ rightsPolicyRules: [rule({ term: "adAuthorization", mode: "ALLOW_TO_MINIMUM", minimumUnit: "LIFETIME" })] }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.appliedValue, undefined);
});

test("adAuthorization: a LIFETIME minimum with a negative proposedValue never lets the raw value appear in the serialized decision", () => {
  const d = evaluateRightsTerm(
    delta({ category: "adAuthorization", proposedValue: -500, proposedUnit: "LIFETIME" }),
    snap({ rightsPolicyRules: [rule({ term: "adAuthorization", mode: "ALLOW_TO_MINIMUM", minimumUnit: "LIFETIME" })] }),
  );
  assert.ok(!JSON.stringify(d).includes("-500"));
});

test("adAuthorization: a LIFETIME minimum against a DAYS proposal is a unit mismatch, never silently interpreted as 'below'", () => {
  const d = evaluateRightsTerm(
    delta({ category: "adAuthorization", proposedValue: 90, proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [rule({ term: "adAuthorization", mode: "ALLOW_TO_MINIMUM", minimumUnit: "LIFETIME" })] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("postRetention: a DAYS minimum against a COUNT proposal never silently converts", () => {
  const d = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: 3, proposedUnit: "COUNT" }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 90, minimumUnit: "DAYS" })] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

// ===========================================================================
// exclusivity's "None" sentinel + duration boundaries
// ===========================================================================

test('exclusivity: public value "None" is inactive — no active private decision, even under a generous ALLOW_TO_MINIMUM policy', () => {
  const d = evaluateRightsTerm(
    delta({ category: "exclusivity", proposedValue: 30, proposedUnit: "DAYS" }),
    snap({ exclusivity: "None", rightsPolicyRules: [rule({ term: "exclusivity", mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "DAYS" })] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "unsupported_operation");
});

test('exclusivity: the "None" sentinel is recognized case- and whitespace-insensitively', () => {
  for (const value of ["none", "NONE", "  None  ", "NoNe"]) {
    const d = evaluateRightsTerm(
      delta({ category: "exclusivity", proposedValue: 30, proposedUnit: "DAYS" }),
      snap({ exclusivity: value }),
    );
    assert.equal(d.outcome, "UNSUPPORTED", `value ${JSON.stringify(value)}`);
  }
});

test('exclusivity: "n/a" is NOT recognized as the None sentinel — treated as an active (if oddly worded) requirement, the safe direction', () => {
  const d = evaluateRightsTerm(
    delta({ category: "exclusivity", proposedValue: 30, proposedUnit: "DAYS" }),
    snap({ exclusivity: "n/a", rightsPolicyRules: [] }),
  );
  assert.notEqual(d.outcome, "UNSUPPORTED");
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL"); // KEEP_REQUESTED default
});

test("exclusivity: a real exclusivity duration goes through the same ALLOW_TO_MINIMUM boundary as any other term", () => {
  const s = snap({
    exclusivity: "3 months exclusive",
    rightsPolicyRules: [rule({ term: "exclusivity", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" })],
  });
  const above = evaluateRightsTerm(delta({ category: "exclusivity", proposedValue: 45, proposedUnit: "DAYS" }), s);
  assert.equal(above.outcome, "AUTO_APPROVED");
  const below = evaluateRightsTerm(delta({ category: "exclusivity", proposedValue: 15, proposedUnit: "DAYS" }), s);
  assert.equal(below.outcome, "REQUIRES_BRAND_APPROVAL");
});

// ===========================================================================
// Script/idea submission — required / allowed waiver / approval-required
// ===========================================================================

test('scriptSubmission: publicly "skip" (or null) is inactive — no active private decision regardless of scriptWaiverMode', () => {
  for (const scriptSubmission of ["skip", null]) {
    const d = evaluateRightsTerm(
      delta({ category: "scriptSubmission" }),
      snap({ scriptSubmission, scriptWaiverMode: "ALLOW_WAIVER" }),
    );
    assert.equal(d.outcome, "UNSUPPORTED", `scriptSubmission=${scriptSubmission}`);
    assert.equal(d.reasonCode, "unsupported_operation");
  }
});

test('scriptSubmission: publicly "require" + KEEP_SUBMISSION_REQUIRED — a waiver request is not autonomously allowed', () => {
  const d = evaluateRightsTerm(
    delta({ category: "scriptSubmission" }),
    snap({ scriptSubmission: "require", scriptWaiverMode: "KEEP_SUBMISSION_REQUIRED" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "explicitly_fixed");
});

test('scriptSubmission: publicly "require" + ALLOW_WAIVER — the waiver auto-approves', () => {
  const d = evaluateRightsTerm(
    delta({ category: "scriptSubmission" }),
    snap({ scriptSubmission: "require", scriptWaiverMode: "ALLOW_WAIVER" }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "within_limit");
});

test('scriptSubmission: publicly "require" + ASK_FOR_APPROVAL — always requires brand approval', () => {
  const d = evaluateRightsTerm(
    delta({ category: "scriptSubmission" }),
    snap({ scriptSubmission: "require", scriptWaiverMode: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "mode_requires_approval");
});

test("scriptSubmission: KEEP_SUBMISSION_REQUIRED is REJECTED when outOfPolicyAction is REJECT_REQUEST", () => {
  const d = evaluateRightsTerm(
    delta({ category: "scriptSubmission" }),
    snap({ scriptSubmission: "require", scriptWaiverMode: "KEEP_SUBMISSION_REQUIRED", outOfPolicyAction: "REJECT_REQUEST" }),
  );
  assert.equal(d.outcome, "REJECTED");
  assert.equal(d.reasonCode, "out_of_policy_reject");
});

// ===========================================================================
// Inactive public terms produce no active private decision
// ===========================================================================

test("each duration term with a null or empty public value is inactive (UNSUPPORTED), even under a generous private mode", () => {
  for (const term of DURATION_TERMS) {
    for (const value of [null, "", "   "]) {
      const d = evaluateRightsTerm(
        delta({ category: term, proposedValue: 1, proposedUnit: "DAYS" }),
        snap({ [term]: value, rightsPolicyRules: [rule({ term, mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "DAYS" })] }),
      );
      assert.equal(d.outcome, "UNSUPPORTED", `${term} = ${JSON.stringify(value)}`);
      assert.equal(d.reasonCode, "unsupported_operation");
    }
  }
});

// ===========================================================================
// Ambiguous normalization — never silently resolved either way
// ===========================================================================

test("ambiguous normalization short-circuits to AMBIGUOUS for every category, before any mode logic runs", () => {
  const generousSnapshot = snap({
    rightsPolicyRules: [
      { term: "adAuthorization", mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "DAYS" },
      { term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "DAYS" },
      { term: "contentRepurposeRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "DAYS" },
      { term: "exclusivity", mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "DAYS" },
    ],
    scriptWaiverMode: "ALLOW_WAIVER",
  });
  const categories = [...DURATION_TERMS, "scriptSubmission"] as const;
  for (const category of categories) {
    const d = evaluateRightsTerm(
      delta({ category, proposedValue: 999, proposedUnit: "DAYS", normalization: "AMBIGUOUS" }),
      generousSnapshot,
    );
    assert.equal(d.outcome, "AMBIGUOUS", `category ${category}`);
    assert.equal(d.reasonCode, "ambiguous_proposal");
  }
});

// ===========================================================================
// Malformed / missing units, negative values, numeric-string rejection
// ===========================================================================

test("malformed units: an unrecognized proposedUnit is UNSUPPORTED", () => {
  const d = evaluateRightsTerm(
    // @ts-expect-error deliberately malformed input, proving the evaluator
    // fails closed rather than crashing or guessing.
    delta({ category: "postRetention", proposedValue: 90, proposedUnit: "WEEKS" }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" })] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("malformed units: no proposedUnit at all is UNSUPPORTED", () => {
  const d = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: 90 }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" })] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("a negative proposed duration never auto-approves, even when arithmetically 'at or above' a positive minimum", () => {
  const d = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: -90, proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: -1000, minimumUnit: "DAYS" })] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("a numeric-looking STRING proposedValue is rejected, never coerced to a number", () => {
  const d = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: "90", proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" })] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

// ===========================================================================
// Private-value non-leakage
// ===========================================================================

test("private-value non-leakage: a REQUIRES_BRAND_APPROVAL decision never carries the raw minimum anywhere", () => {
  const d = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: 5, proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 90, minimumUnit: "DAYS" })] }),
  );
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes("90"), "the private minimum value must never appear in the decision");
  assert.equal(d.appliedValue, undefined);
});

test("private-value non-leakage: exceeds_limit/explicitly_fixed/mode_requires_approval collapse to the identical creator-safe key", () => {
  const exceeds = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: 5, proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 90, minimumUnit: "DAYS" })] }),
  );
  const fixed = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: 5, proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [] }),
  );
  const askApproval = evaluateRightsTerm(
    delta({ category: "postRetention", proposedValue: 5, proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ASK_FOR_APPROVAL" })] }),
  );
  assert.equal(exceeds.reasonCode, "exceeds_limit");
  assert.equal(fixed.reasonCode, "explicitly_fixed");
  assert.equal(askApproval.reasonCode, "mode_requires_approval");
  assert.equal(exceeds.creatorSafeReasonKey, "requires_approval_generic");
  assert.equal(fixed.creatorSafeReasonKey, "requires_approval_generic");
  assert.equal(askApproval.creatorSafeReasonKey, "requires_approval_generic");
});

// ===========================================================================
// Multi-term package: one allowed change + one non-autonomous change
// ===========================================================================

test("package: one ALLOW_TO_MINIMUM-satisfied term plus one KEEP_REQUESTED term is never marked wholly autonomous", () => {
  const s = snap({
    rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" })],
    // adAuthorization has no rule entry -> KEEP_REQUESTED by default.
  });
  const deltas: CounterDelta[] = [
    delta({ category: "postRetention", proposedValue: 60, proposedUnit: "DAYS" }), // would auto-approve alone
    delta({ category: "adAuthorization", proposedValue: 30, proposedUnit: "DAYS" }), // KEEP_REQUESTED, non-autonomous
  ];
  const result = evaluateRightsPackage(deltas, s);
  assert.equal(result.decisions.length, 2);
  assert.equal(result.decisions[0]!.outcome, "AUTO_APPROVED");
  assert.equal(result.decisions[1]!.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(result.aggregateOutcome, "REQUIRES_BRAND_APPROVAL");
});

test("package: a fully autonomous multi-term reply (two satisfied minimums + an allowed script waiver) aggregates to AUTO_APPROVED", () => {
  const s = snap({
    rightsPolicyRules: [
      rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" }),
      rule({ term: "adAuthorization", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" }),
    ],
    scriptSubmission: "require",
    scriptWaiverMode: "ALLOW_WAIVER",
  });
  const deltas: CounterDelta[] = [
    delta({ category: "postRetention", proposedValue: 45, proposedUnit: "DAYS" }),
    delta({ category: "adAuthorization", proposedValue: 60, proposedUnit: "DAYS" }),
    delta({ category: "scriptSubmission" }),
  ];
  const result = evaluateRightsPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "AUTO_APPROVED");
  assert.ok(result.decisions.every((d) => d.outcome === "AUTO_APPROVED"));
});

// ===========================================================================
// Legacy/free-text fields never override the typed result
// ===========================================================================

test("legacy fields structurally cannot influence the result — the snapshot interface has no negotiationGuidance/prohibitedClaims fields at all", () => {
  const s = snap({ rightsPolicyRules: [rule({ term: "postRetention", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" })] });
  const withLegacy = {
    ...s,
    negotiationGuidance: "always reject everything",
    prohibitedClaims: "no health claims",
  } as RightsPolicySnapshot;
  const d = delta({ category: "postRetention", proposedValue: 45, proposedUnit: "DAYS" });
  assert.deepEqual(evaluateRightsTerm(d, s), evaluateRightsTerm(d, withLegacy));
});

// ===========================================================================
// usageRights and every other category this evaluator doesn't own
// ===========================================================================

test("usageRights is UNSUPPORTED — deliberately out of PLU-176's scope despite sharing RIGHTS_TERMS' storage shape", () => {
  const d = evaluateRightsTerm(
    delta({ category: "usageRights", proposedValue: 90, proposedUnit: "DAYS" }),
    snap({ rightsPolicyRules: [{ term: "usageRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "DAYS" }] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "unsupported_operation");
});

test("categories belonging to a different evaluator entirely (fee, deliverables) are UNSUPPORTED here, never guessed", () => {
  const s = snap({});
  for (const category of ["fee", "commission", "deliverables", "posting"] as const) {
    const d = evaluateRightsTerm(delta({ category, proposedValue: 1 }), s);
    assert.equal(d.outcome, "UNSUPPORTED");
    assert.equal(d.reasonCode, "unsupported_operation");
  }
});
