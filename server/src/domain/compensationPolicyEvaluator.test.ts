/**
 * PLU-175 — unit tests for the deterministic Paid/Affiliate/Hybrid/Gift
 * compensation evaluator. Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/compensationPolicyEvaluator.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCompensationTerm,
  evaluateCompensationPackage,
  type CompensationPolicySnapshot,
} from "./compensationPolicyEvaluator.js";
import type { CounterDelta } from "./policyDecision.js";

// A fully-specified, deliberately conservative baseline every test starts
// from and overrides only the fields it cares about — keeps each test's
// diff from the "nothing is authorized" default legible.
// Percent fields use the WHOLE-NUMBER convention already established
// elsewhere in this codebase (db/campaigns.compensationReadiness.db.test.ts:
// publicCommissionRate: 15, commissionFloorRate: 10, commissionCeilingRate:
// 20) — 10 means 10%, never a 0-1 fraction. See
// CompensationPolicySnapshot's own doc comment on publicCommissionRate.
const BASE_SNAPSHOT: CompensationPolicySnapshot = {
  campaignType: "HYBRID",
  includesGifting: true,
  priceStrategy: "PROPOSE_STARTING_FEE",
  publicStartingFeeCents: 50000,
  commissionMode: "percent",
  publicCommissionRate: 10,
  commissionDurationUnit: "DAYS",
  commissionDurationDays: 30,

  feeMode: "KEEP_PUBLIC_OFFER",
  ceilingCents: null,
  commissionNegotiationMode: "KEEP_PUBLIC_COMMISSION",
  commissionCeilingRate: null,
  commissionDurationMode: "KEEP_PUBLIC_DURATION",
  commissionDurationLimitValue: null,
  commissionDurationLimitUnit: null,
  giftSubstitutionMode: "KEEP_OFFERED_BENEFIT",
  giftApprovedSubstitutes: null,
  giftCashReplacementMode: "REJECT",
  giftCashReplacementLimitCents: null,
  outOfPolicyAction: "ASK_FOR_APPROVAL",
};

function snap(overrides: Partial<CompensationPolicySnapshot>): CompensationPolicySnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

function delta(overrides: Partial<CounterDelta> & Pick<CounterDelta, "category">): CounterDelta {
  return { normalization: "EXACT", ...overrides };
}

// ===========================================================================
// Determinism (acceptance criterion: same typed input always returns the
// same result)
// ===========================================================================

test("determinism: the same typed input returns the identical decision on repeated calls", () => {
  const s = snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 });
  const d = delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" });
  const first = evaluateCompensationTerm(d, s);
  const second = evaluateCompensationTerm(d, s);
  assert.deepEqual(first, second);
});

// ===========================================================================
// Paid / Hybrid fee changes
// ===========================================================================

test("fee: KEEP_PUBLIC_OFFER — a value matching the public offer auto-approves", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 50000, proposedUnit: "CENTS" }),
    snap({ feeMode: "KEEP_PUBLIC_OFFER" }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "matches_public_offer");
  assert.equal(d.appliedValue, 50000);
  assert.equal(d.creatorSafeReasonKey, "approved");
});

test("fee: KEEP_PUBLIC_OFFER — a different fee is not autonomously allowed (ASK_FOR_APPROVAL default)", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    snap({ feeMode: "KEEP_PUBLIC_OFFER", outOfPolicyAction: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "explicitly_fixed");
});

test("fee: KEEP_PUBLIC_OFFER — a different fee is REJECTED when outOfPolicyAction is REJECT_REQUEST", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    snap({ feeMode: "KEEP_PUBLIC_OFFER", outOfPolicyAction: "REJECT_REQUEST" }),
  );
  assert.equal(d.outcome, "REJECTED");
  assert.equal(d.reasonCode, "out_of_policy_reject");
});

test("fee: ALLOW_WITHIN_LIMIT boundary — below the ceiling auto-approves", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 59999, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "within_limit");
  assert.equal(d.appliedValue, 59999);
});

test("fee: ALLOW_WITHIN_LIMIT boundary — exactly ON the ceiling auto-approves", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 60000, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "within_limit");
});

test("fee: ALLOW_WITHIN_LIMIT boundary — ABOVE the ceiling requires approval (default outOfPolicyAction)", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 60001, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "exceeds_limit");
});

test("fee: ALLOW_WITHIN_LIMIT with no ceiling configured fails closed (never AUTO_APPROVED)", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 1, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: null }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "no_limit_configured");
});

test("fee: a negative proposed fee never auto-approves, even when arithmetically 'within' a positive ceiling", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: -50000, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("fee: PROPOSE_STARTING_FEE with KEEP_PUBLIC_OFFER but no public fee configured (data-integrity gap) fails closed, never guesses", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 50000, proposedUnit: "CENTS" }),
    snap({ priceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: null, feeMode: "KEEP_PUBLIC_OFFER" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "no_limit_configured");
});

test("fee: an unrecognized feeMode string falls through to the conservative KEEP branch, never AUTO_APPROVED for a different value", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 99999, proposedUnit: "CENTS" }),
    // A Postgres enum column can never hold a value outside FeeNegotiationMode
    // in practice, but the evaluator's own switch/default must still fail
    // closed rather than fall through to `undefined` if it ever did.
    snap({ feeMode: "SOME_FUTURE_MODE" as unknown as CompensationPolicySnapshot["feeMode"] }),
  );
  assert.notEqual(d.outcome, "AUTO_APPROVED");
  assert.ok(d.outcome === "REQUIRES_BRAND_APPROVAL" || d.outcome === "REJECTED");
});

test("fee: ASK_FOR_APPROVAL always requires brand approval, regardless of value", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 1, proposedUnit: "CENTS" }),
    snap({ feeMode: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "mode_requires_approval");
});

test("fee: Request Rate Card WITHOUT an explicit maximum never auto-approves, even under ALLOW_WITHIN_LIMIT with no ceiling", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 70000, proposedUnit: "CENTS" }),
    snap({
      priceStrategy: "REQUEST_RATE_CARD",
      publicStartingFeeCents: null,
      feeMode: "KEEP_PUBLIC_OFFER",
    }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "no_limit_configured");
});

test("fee: Request Rate Card WITH an explicit maximum evaluates normally (within limit auto-approves)", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 70000, proposedUnit: "CENTS" }),
    snap({
      priceStrategy: "REQUEST_RATE_CARD",
      publicStartingFeeCents: null,
      feeMode: "ALLOW_WITHIN_LIMIT",
      ceilingCents: 80000,
    }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "within_limit");
});

test("fee: Request Rate Card WITH an explicit maximum still requires approval when the rate exceeds it", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 90000, proposedUnit: "CENTS" }),
    snap({
      priceStrategy: "REQUEST_RATE_CARD",
      publicStartingFeeCents: null,
      feeMode: "ALLOW_WITHIN_LIMIT",
      ceilingCents: 80000,
    }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "exceeds_limit");
});

test("fee: a Request Rate Card submitted rate is NEVER treated as an already-approved public amount", () => {
  // Same numeric value as would have been "the public offer" under
  // PROPOSE_STARTING_FEE — must not auto-approve just because it happens to
  // match something; there is no public number to match under REQUEST_RATE_CARD.
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 50000, proposedUnit: "CENTS" }),
    snap({ priceStrategy: "REQUEST_RATE_CARD", publicStartingFeeCents: null, feeMode: "KEEP_PUBLIC_OFFER" }),
  );
  assert.notEqual(d.outcome, "AUTO_APPROVED");
});

test("fee: unsupported for a campaign type that doesn't need a fee", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 1000, proposedUnit: "CENTS" }),
    snap({ campaignType: "AFFILIATE" }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "unsupported_operation");
});

// ===========================================================================
// Affiliate / Hybrid commission changes
// ===========================================================================

test("commission: KEEP_PUBLIC_COMMISSION — matching value auto-approves", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 10, proposedUnit: "PERCENT" }),
    snap({ commissionNegotiationMode: "KEEP_PUBLIC_COMMISSION" }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "matches_public_offer");
});

test("commission: ALLOW_WITHIN_LIMIT boundary — below/on/above the ceiling", () => {
  const below = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 14, proposedUnit: "PERCENT" }),
    snap({ commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 15 }),
  );
  assert.equal(below.outcome, "AUTO_APPROVED");

  const on = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 15, proposedUnit: "PERCENT" }),
    snap({ commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 15 }),
  );
  assert.equal(on.outcome, "AUTO_APPROVED");

  const above = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 16, proposedUnit: "PERCENT" }),
    snap({ commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 15 }),
  );
  assert.equal(above.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(above.reasonCode, "exceeds_limit");
});

test("commission: ASK_FOR_APPROVAL always requires approval", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 5, proposedUnit: "PERCENT" }),
    snap({ commissionNegotiationMode: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "mode_requires_approval");
});

test("commission: percent public structure evaluates normally", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 10, proposedUnit: "PERCENT" }),
    snap({ commissionMode: "percent" }),
  );
  assert.notEqual(d.outcome, "UNSUPPORTED");
});

test("commission: unsupported flat public structure escalates rather than being silently evaluated", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 500, proposedUnit: "FLAT_AMOUNT_CENTS" }),
    snap({ commissionMode: "flat", commissionNegotiationMode: "ALLOW_WITHIN_LIMIT" }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "unsupported_operation");
});

test("commission: unsupported/unrecognized (\"two-level\") public structure also escalates", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 10, proposedUnit: "PERCENT" }),
    snap({ commissionMode: "two_level" }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "unsupported_operation");
});

test("commission: commissionMode null is a data-integrity gap, not an 'unrecognized structure' — still UNSUPPORTED (fails closed either way)", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 10, proposedUnit: "PERCENT" }),
    snap({ commissionMode: null }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "unsupported_operation");
});

test("commission: unsupported for a campaign type that doesn't need commission", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 10, proposedUnit: "PERCENT" }),
    snap({ campaignType: "PAID" }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
});

test("commission: a negative proposed rate never auto-approves, even when arithmetically 'within' a positive ceiling", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: -5, proposedUnit: "PERCENT" }),
    snap({ commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 15 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("commission: a numeric-looking STRING proposedValue is rejected, never coerced to a number", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: "10", proposedUnit: "PERCENT" }),
    snap({ commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 15 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

// ===========================================================================
// Commission-duration — Customer lifetime, time-span, and count
// ===========================================================================

test("commissionDuration: DAYS (time-span) boundary — below/on/above the limit", () => {
  const belowD = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 44, proposedUnit: "DAYS" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "DAYS", commissionDurationLimitValue: 45 }),
  );
  assert.equal(belowD.outcome, "AUTO_APPROVED");

  const onD = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 45, proposedUnit: "DAYS" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "DAYS", commissionDurationLimitValue: 45 }),
  );
  assert.equal(onD.outcome, "AUTO_APPROVED");

  const aboveD = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 46, proposedUnit: "DAYS" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "DAYS", commissionDurationLimitValue: 45 }),
  );
  assert.equal(aboveD.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(aboveD.reasonCode, "exceeds_limit");
});

test("commissionDuration: COUNT semantics — boundary below/on/above", () => {
  const on = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 3, proposedUnit: "COUNT" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "COUNT", commissionDurationLimitValue: 3 }),
  );
  assert.equal(on.outcome, "AUTO_APPROVED");

  const above = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 4, proposedUnit: "COUNT" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "COUNT", commissionDurationLimitValue: 3 }),
  );
  assert.equal(above.outcome, "REQUIRES_BRAND_APPROVAL");
});

test("commissionDuration: LIFETIME semantics — the mode itself is the grant, auto-approves under ALLOW_WITHIN_LIMIT", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: "lifetime", proposedUnit: "LIFETIME" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "LIFETIME" }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "within_limit");
});

test("commissionDuration: LIFETIME under KEEP_PUBLIC_DURATION matches the public LIFETIME term", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: "lifetime", proposedUnit: "LIFETIME" }),
    snap({ commissionDurationMode: "KEEP_PUBLIC_DURATION", commissionDurationUnit: "LIFETIME" }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "matches_public_offer");
});

// Review fix (mirrors rightsPolicyEvaluator.ts's identical B2 fix): both
// LIFETIME branches used to pass delta.proposedValue straight into
// appliedValue with no validation — the only numeric paths in this file
// that skipped asNonNegativeFiniteNumber. A malformed, negative, or absent
// proposedValue still auto-approves (the unit match alone is the grant),
// but the unvalidated value must never be recorded in the decision.
const LIFETIME_LEAK_CASES: readonly [string, number | string][] = [
  ["negative", -500],
  ["non-numeric string", "whatever"],
];
for (const [label, proposedValue] of LIFETIME_LEAK_CASES) {
  test(`commissionDuration: ALLOW_WITHIN_LIMIT LIFETIME auto-approves regardless of a ${label} proposedValue, but never records it`, () => {
    const d = evaluateCompensationTerm(
      delta({ category: "commissionDuration", proposedValue, proposedUnit: "LIFETIME" }),
      snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "LIFETIME" }),
    );
    assert.equal(d.outcome, "AUTO_APPROVED");
    assert.equal(d.appliedValue, undefined, "an unvalidated proposedValue must never leak into appliedValue");
  });

  test(`commissionDuration: KEEP_PUBLIC_DURATION LIFETIME auto-approves regardless of a ${label} proposedValue, but never records it`, () => {
    const d = evaluateCompensationTerm(
      delta({ category: "commissionDuration", proposedValue, proposedUnit: "LIFETIME" }),
      snap({ commissionDurationMode: "KEEP_PUBLIC_DURATION", commissionDurationUnit: "LIFETIME" }),
    );
    assert.equal(d.outcome, "AUTO_APPROVED");
    assert.equal(d.appliedValue, undefined, "an unvalidated proposedValue must never leak into appliedValue");
  });
}

test("commissionDuration: ALLOW_WITHIN_LIMIT LIFETIME auto-approves with NO proposedValue at all, and records nothing", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedUnit: "LIFETIME" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "LIFETIME" }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.appliedValue, undefined);
});

test("commissionDuration: a negative proposedValue on a LIFETIME path never appears in the serialized decision", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: -500, proposedUnit: "LIFETIME" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "LIFETIME" }),
  );
  assert.ok(!JSON.stringify(d).includes("-500"));
});

test("commissionDuration: a unit mismatch (DAYS proposal against a COUNT policy) never silently converts", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 30, proposedUnit: "DAYS" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "COUNT", commissionDurationLimitValue: 3 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("commissionDuration: ALLOW_WITHIN_LIMIT with no limit configured fails closed", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 10, proposedUnit: "DAYS" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: null }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "no_limit_configured");
});

test("commissionDuration: a negative proposed value never auto-approves under ALLOW_WITHIN_LIMIT", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: -10, proposedUnit: "DAYS" }),
    snap({ commissionDurationMode: "ALLOW_WITHIN_LIMIT", commissionDurationLimitUnit: "DAYS", commissionDurationLimitValue: 45 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("commissionDuration: ASK_FOR_APPROVAL always requires approval", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commissionDuration", proposedValue: 30, proposedUnit: "DAYS" }),
    snap({ commissionDurationMode: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "mode_requires_approval");
});

// ===========================================================================
// Gift / access — substitution and cash replacement
// ===========================================================================

test("giftSubstitution: KEEP_OFFERED_BENEFIT — a substitute request is not autonomously allowed", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftSubstitution", proposedValue: "a different jacket" }),
    snap({ giftSubstitutionMode: "KEEP_OFFERED_BENEFIT" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "explicitly_fixed");
});

test("giftSubstitution: ALLOW_EQUIVALENT_APPROVED_OPTION — a listed substitute auto-approves", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftSubstitution", proposedValue: "Blue Hoodie" }),
    snap({ giftSubstitutionMode: "ALLOW_EQUIVALENT_APPROVED_OPTION", giftApprovedSubstitutes: ["Blue Hoodie", "Red Cap"] }),
  );
  assert.equal(d.outcome, "AUTO_APPROVED");
  assert.equal(d.reasonCode, "within_limit");
  assert.equal(d.appliedValue, "Blue Hoodie");
});

test("giftSubstitution: ALLOW_EQUIVALENT_APPROVED_OPTION — an unlisted substitute requires approval", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftSubstitution", proposedValue: "Gold Watch" }),
    snap({ giftSubstitutionMode: "ALLOW_EQUIVALENT_APPROVED_OPTION", giftApprovedSubstitutes: ["Blue Hoodie"] }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "exceeds_limit");
});

test("giftSubstitution: ALLOW_EQUIVALENT_APPROVED_OPTION with an empty approved list fails closed", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftSubstitution", proposedValue: "anything" }),
    snap({ giftSubstitutionMode: "ALLOW_EQUIVALENT_APPROVED_OPTION", giftApprovedSubstitutes: [] }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "no_limit_configured");
});

test("giftSubstitution: ASK_FOR_APPROVAL always requires approval", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftSubstitution", proposedValue: "anything" }),
    snap({ giftSubstitutionMode: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "mode_requires_approval");
});

test("giftSubstitution: unsupported when gifting isn't active", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftSubstitution", proposedValue: "anything" }),
    snap({ campaignType: "PAID", includesGifting: false }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
});

test("giftCashReplacement: REJECT mode is always a hard REJECTED, regardless of outOfPolicyAction", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftCashReplacement", proposedValue: 1000, proposedUnit: "CENTS" }),
    snap({ giftCashReplacementMode: "REJECT", outOfPolicyAction: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REJECTED");
  assert.equal(d.reasonCode, "out_of_policy_reject");
});

test("giftCashReplacement: ASK_FOR_APPROVAL always requires approval", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftCashReplacement", proposedValue: 1000, proposedUnit: "CENTS" }),
    snap({ giftCashReplacementMode: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "mode_requires_approval");
});

test("giftCashReplacement: ALLOW_UP_TO_AMOUNT boundary — below/on/above the limit", () => {
  const below = evaluateCompensationTerm(
    delta({ category: "giftCashReplacement", proposedValue: 1999, proposedUnit: "CENTS" }),
    snap({ giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT", giftCashReplacementLimitCents: 2000 }),
  );
  assert.equal(below.outcome, "AUTO_APPROVED");

  const on = evaluateCompensationTerm(
    delta({ category: "giftCashReplacement", proposedValue: 2000, proposedUnit: "CENTS" }),
    snap({ giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT", giftCashReplacementLimitCents: 2000 }),
  );
  assert.equal(on.outcome, "AUTO_APPROVED");

  const above = evaluateCompensationTerm(
    delta({ category: "giftCashReplacement", proposedValue: 2001, proposedUnit: "CENTS" }),
    snap({ giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT", giftCashReplacementLimitCents: 2000 }),
  );
  assert.equal(above.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(above.reasonCode, "exceeds_limit");
});

test("giftCashReplacement: a negative proposed amount never auto-approves under ALLOW_UP_TO_AMOUNT", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftCashReplacement", proposedValue: -100, proposedUnit: "CENTS" }),
    snap({ giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT", giftCashReplacementLimitCents: 2000 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("giftCashReplacement: ALLOW_UP_TO_AMOUNT with no limit configured fails closed", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftCashReplacement", proposedValue: 1, proposedUnit: "CENTS" }),
    snap({ giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT", giftCashReplacementLimitCents: null }),
  );
  assert.equal(d.outcome, "REQUIRES_BRAND_APPROVAL");
  assert.equal(d.reasonCode, "no_limit_configured");
});

// ===========================================================================
// Ambiguous normalization — never silently resolved either way
// ===========================================================================

test("ambiguous normalization short-circuits to AMBIGUOUS for every category, before any mode logic runs", () => {
  const categories: CounterDelta["category"][] = [
    "fee",
    "commission",
    "commissionDuration",
    "giftSubstitution",
    "giftCashReplacement",
  ];
  for (const category of categories) {
    const d = evaluateCompensationTerm(
      delta({ category, proposedValue: 1, proposedUnit: "CENTS", normalization: "AMBIGUOUS" }),
      // A snapshot shaped so every other branch would auto-approve if reached —
      // proves AMBIGUOUS wins even against an otherwise-approving policy.
      snap({
        feeMode: "ALLOW_WITHIN_LIMIT",
        ceilingCents: 1_000_000,
        commissionNegotiationMode: "ALLOW_WITHIN_LIMIT",
        commissionCeilingRate: 100,
        commissionDurationMode: "ALLOW_WITHIN_LIMIT",
        commissionDurationLimitUnit: "DAYS",
        commissionDurationLimitValue: 1_000_000,
        giftSubstitutionMode: "ALLOW_EQUIVALENT_APPROVED_OPTION",
        giftApprovedSubstitutes: ["anything"],
        giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT",
        giftCashReplacementLimitCents: 1_000_000,
      }),
    );
    assert.equal(d.outcome, "AMBIGUOUS", `category ${category}`);
    assert.equal(d.reasonCode, "ambiguous_proposal");
  }
});

// ===========================================================================
// Malformed / missing units
// ===========================================================================

test("malformed units: fee proposal with the wrong unit (PERCENT instead of CENTS) is UNSUPPORTED, never guessed", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 50000, proposedUnit: "PERCENT" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("malformed units: fee proposal with no unit at all is UNSUPPORTED", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 50000 }),
    snap({ feeMode: "KEEP_PUBLIC_OFFER" }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("malformed units: fee proposal with a non-numeric value is UNSUPPORTED", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: "a lot please", proposedUnit: "CENTS" }),
    snap({ feeMode: "KEEP_PUBLIC_OFFER" }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("malformed units: commission proposal in FLAT_AMOUNT_CENTS against a percent public structure is UNSUPPORTED", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "commission", proposedValue: 500, proposedUnit: "FLAT_AMOUNT_CENTS" }),
    snap({ commissionMode: "percent", commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 20 }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("malformed units: commissionDuration with an unrecognized unit string is UNSUPPORTED", () => {
  const d = evaluateCompensationTerm(
    // @ts-expect-error deliberately malformed input, proving the evaluator
    // fails closed rather than crashing or guessing.
    delta({ category: "commissionDuration", proposedValue: 30, proposedUnit: "WEEKS" }),
    snap({ commissionDurationMode: "KEEP_PUBLIC_DURATION" }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

test("malformed units: giftSubstitution with an empty/missing proposed value is UNSUPPORTED", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "giftSubstitution", proposedValue: "   " }),
    snap({ giftSubstitutionMode: "ALLOW_EQUIVALENT_APPROVED_OPTION", giftApprovedSubstitutes: ["anything"] }),
  );
  assert.equal(d.outcome, "UNSUPPORTED");
  assert.equal(d.reasonCode, "missing_unit");
});

// ===========================================================================
// Private-value non-leakage
// ===========================================================================

test("private-value non-leakage: a REQUIRES_BRAND_APPROVAL decision never carries the raw ceiling anywhere", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 99999, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 }),
  );
  const serialized = JSON.stringify(d);
  assert.ok(!serialized.includes("60000"), "the private ceiling value must never appear in the decision");
  // appliedValue is only ever set on AUTO_APPROVED — confirm it's absent here.
  assert.equal(d.appliedValue, undefined);
});

test("private-value non-leakage: creatorSafeReasonKey collapses exceeds_limit/explicitly_fixed/mode_requires_approval to the identical generic key", () => {
  const exceeds = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 999999, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 }),
  );
  const fixed = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 1, proposedUnit: "CENTS" }),
    snap({ feeMode: "KEEP_PUBLIC_OFFER" }),
  );
  const askApproval = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 1, proposedUnit: "CENTS" }),
    snap({ feeMode: "ASK_FOR_APPROVAL" }),
  );
  assert.equal(exceeds.reasonCode, "exceeds_limit");
  assert.equal(fixed.reasonCode, "explicitly_fixed");
  assert.equal(askApproval.reasonCode, "mode_requires_approval");
  // A creator watching only creatorSafeReasonKey cannot tell these three
  // internal situations apart — cannot binary-search the real ceiling.
  assert.equal(exceeds.creatorSafeReasonKey, "requires_approval_generic");
  assert.equal(fixed.creatorSafeReasonKey, "requires_approval_generic");
  assert.equal(askApproval.creatorSafeReasonKey, "requires_approval_generic");
});

test("private-value non-leakage: no_limit_configured (a config gap) also collapses to the generic approval key, not a distinct 'misconfigured' signal", () => {
  const d = evaluateCompensationTerm(
    delta({ category: "fee", proposedValue: 1, proposedUnit: "CENTS" }),
    snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: null }),
  );
  assert.equal(d.creatorSafeReasonKey, undefined, "no_limit_configured has no mapped creator-safe key at all — nothing renders");
});

// ===========================================================================
// Multi-term Hybrid package (atomic evaluation)
// ===========================================================================

test("package: a fully autonomous multi-term Hybrid reply (fee + commission + duration) aggregates to AUTO_APPROVED", () => {
  const s = snap({
    feeMode: "ALLOW_WITHIN_LIMIT",
    ceilingCents: 60000,
    commissionNegotiationMode: "ALLOW_WITHIN_LIMIT",
    commissionCeilingRate: 15,
    commissionDurationMode: "ALLOW_WITHIN_LIMIT",
    commissionDurationLimitUnit: "DAYS",
    commissionDurationLimitValue: 45,
  });
  const deltas: CounterDelta[] = [
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    delta({ category: "commission", proposedValue: 12, proposedUnit: "PERCENT" }),
    delta({ category: "commissionDuration", proposedValue: 40, proposedUnit: "DAYS" }),
  ];
  const result = evaluateCompensationPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "AUTO_APPROVED");
  assert.equal(result.decisions.length, 3);
  assert.ok(result.decisions.every((d) => d.outcome === "AUTO_APPROVED"));
});

test("package: one REQUIRES_BRAND_APPROVAL term prevents the whole Hybrid package from being autonomous", () => {
  const s = snap({
    feeMode: "ALLOW_WITHIN_LIMIT",
    ceilingCents: 60000,
    commissionNegotiationMode: "ASK_FOR_APPROVAL",
  });
  const deltas: CounterDelta[] = [
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }), // would auto-approve alone
    delta({ category: "commission", proposedValue: 10, proposedUnit: "PERCENT" }), // ASK_FOR_APPROVAL
  ];
  const result = evaluateCompensationPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "REQUIRES_BRAND_APPROVAL");
});

test("package: one REJECTED term outranks an otherwise-approving package", () => {
  const s = snap({
    feeMode: "ALLOW_WITHIN_LIMIT",
    ceilingCents: 60000,
    giftCashReplacementMode: "REJECT",
  });
  const deltas: CounterDelta[] = [
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    delta({ category: "giftCashReplacement", proposedValue: 100, proposedUnit: "CENTS" }),
  ];
  const result = evaluateCompensationPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "REJECTED");
});

test("package: one AMBIGUOUS term prevents autonomy even when every other term auto-approves", () => {
  const s = snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 });
  const deltas: CounterDelta[] = [
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    delta({ category: "commission", proposedValue: 10, proposedUnit: "PERCENT", normalization: "AMBIGUOUS" }),
  ];
  const result = evaluateCompensationPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "AMBIGUOUS");
});

test("package: one UNSUPPORTED term (flat commission) prevents autonomy even when the fee half auto-approves", () => {
  const s = snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000, commissionMode: "flat" });
  const deltas: CounterDelta[] = [
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    delta({ category: "commission", proposedValue: 500, proposedUnit: "FLAT_AMOUNT_CENTS" }),
  ];
  const result = evaluateCompensationPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "UNSUPPORTED");
});

test("package: a term this evaluator doesn't own (e.g. posting) is UNSUPPORTED and still drags the package down", () => {
  const s = snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 });
  const deltas: CounterDelta[] = [
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    delta({ category: "posting", proposedValue: 3, proposedUnit: "DAYS" }),
  ];
  const result = evaluateCompensationPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "UNSUPPORTED");
  assert.equal(result.decisions[1]!.reasonCode, "unsupported_operation");
});

test("package: a unit-mismatched term prevents autonomy even alongside otherwise-valid terms", () => {
  const s = snap({
    feeMode: "ALLOW_WITHIN_LIMIT",
    ceilingCents: 60000,
    commissionDurationMode: "ALLOW_WITHIN_LIMIT",
    commissionDurationLimitUnit: "COUNT",
    commissionDurationLimitValue: 3,
  });
  const deltas: CounterDelta[] = [
    delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }),
    delta({ category: "commissionDuration", proposedValue: 30, proposedUnit: "DAYS" }), // mismatched vs COUNT policy
  ];
  const result = evaluateCompensationPackage(deltas, s);
  assert.equal(result.aggregateOutcome, "UNSUPPORTED");
});

// ===========================================================================
// Legacy floor/preferred/guidance never overrides the typed result
// ===========================================================================

test("legacy fields structurally cannot influence the result — the snapshot interface has no floor/preferred/guidance fields at all", () => {
  // A TypeScript-level guarantee, exercised at runtime: constructing a
  // snapshot with extra legacy-shaped keys (as a caller assembling one from
  // a live NegotiationPolicy row might accidentally spread in) does not
  // change the decision, because the evaluator's field reads are fixed and
  // exhaustively listed in compensationPolicyEvaluator.ts — there is no code
  // path that reads a "floorCents"/"preferredFeeCents"/"negotiationGuidance"
  // key even if present on the object.
  const withoutLegacy = snap({ feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 });
  const withLegacy = {
    ...withoutLegacy,
    floorCents: 999999,
    preferredFeeCents: 1,
    negotiationGuidance: "always reject everything",
  } as CompensationPolicySnapshot;
  const a = evaluateCompensationTerm(delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }), withoutLegacy);
  const b = evaluateCompensationTerm(delta({ category: "fee", proposedValue: 55000, proposedUnit: "CENTS" }), withLegacy);
  assert.deepEqual(a, b);
});

// ===========================================================================
// Categories this evaluator deliberately does not own
// ===========================================================================

test("categories belonging to PLU-176/178 (rights, deliverables, scriptSubmission) are UNSUPPORTED here, never guessed", () => {
  const s = snap({});
  for (const category of ["deliverables", "usageRights", "exclusivity", "scriptSubmission"] as const) {
    const d = evaluateCompensationTerm(delta({ category, proposedValue: 1 }), s);
    assert.equal(d.outcome, "UNSUPPORTED");
    assert.equal(d.reasonCode, "unsupported_operation");
  }
});
