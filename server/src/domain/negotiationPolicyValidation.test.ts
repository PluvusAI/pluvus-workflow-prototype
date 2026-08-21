/**
 * PLU-172 — unit tests for the negotiation-policy PATCH route's cross-field
 * validation. Pure logic — no DB, no Express. Run with:
 *   npx tsx --test src/domain/negotiationPolicyValidation.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  validateNegotiationPolicyPatch,
  needsNegotiationPolicyCrossFieldCheck,
  type NegotiationPolicyPatchInput,
  type NegotiationPolicyValidationContext,
} from "./negotiationPolicyValidation.js";

function ctx(overrides: Partial<NegotiationPolicyValidationContext> = {}): NegotiationPolicyValidationContext {
  return {
    publicPriceStrategy: null,
    publicStartingFeeCents: null,
    publicCommissionMode: null,
    publicCommissionRate: null,
    existingCommissionDurationMode: null,
    existingPostingNegotiationMode: null,
    existingGiftSubstitutionMode: null,
    existingGiftCashReplacementMode: null,
    existingDeliverableNegotiationMode: null,
    ...overrides,
  };
}

console.log("\nneedsNegotiationPolicyCrossFieldCheck\n");

test("an empty patch needs no check", () => {
  assert.equal(needsNegotiationPolicyCrossFieldCheck({}), false);
});

test("a patch touching an unrelated field (e.g. maxRounds isn't in this validator's scope) still needs no check", () => {
  // maxRounds isn't part of NegotiationPolicyPatchInput at all — this test
  // documents that ONLY the fields this validator actually reads trigger it.
  assert.equal(needsNegotiationPolicyCrossFieldCheck({ feeMode: undefined }), false);
});

test("a patch touching any single relevant field needs a check", () => {
  assert.equal(needsNegotiationPolicyCrossFieldCheck({ feeMode: "KEEP_PUBLIC_OFFER" }), true);
  assert.equal(needsNegotiationPolicyCrossFieldCheck({ postingMaxDelayDays: 3 }), true);
  assert.equal(needsNegotiationPolicyCrossFieldCheck({ giftApprovedSubstitutes: ["x"] }), true);
});

console.log("\nS8.P1 — fee limit vs. public starting fee\n");

test("ceilingCents below the public starting fee is rejected", () => {
  const r = validateNegotiationPolicyPatch(
    { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 40000 },
    ctx({ publicPriceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "FEE_LIMIT_BELOW_PUBLIC_OFFER");
});

test("ceilingCents at or above the public starting fee is accepted", () => {
  const atFee = validateNegotiationPolicyPatch(
    { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 50000 },
    ctx({ publicPriceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 }),
  );
  assert.equal(atFee.ok, true);
  const aboveFee = validateNegotiationPolicyPatch(
    { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 60000 },
    ctx({ publicPriceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 }),
  );
  assert.equal(aboveFee.ok, true);
});

test("feeMode != ALLOW_WITHIN_LIMIT skips the check entirely, even with a low ceilingCents", () => {
  const r = validateNegotiationPolicyPatch(
    { feeMode: "KEEP_PUBLIC_OFFER", ceilingCents: 1 },
    ctx({ publicPriceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 }),
  );
  assert.equal(r.ok, true);
});

test("REQUEST_RATE_CARD (no public numeric fee) never trips this check, regardless of ceilingCents", () => {
  const r = validateNegotiationPolicyPatch(
    { feeMode: "ALLOW_WITHIN_LIMIT", ceilingCents: 1 },
    ctx({ publicPriceStrategy: "REQUEST_RATE_CARD", publicStartingFeeCents: null }),
  );
  assert.equal(r.ok, true);
});

test("an unrelated patch (ceilingCents not part of THIS request) does not re-run the check", () => {
  const r = validateNegotiationPolicyPatch(
    { feeMode: "ALLOW_WITHIN_LIMIT" }, // ceilingCents omitted
    ctx({ publicPriceStrategy: "PROPOSE_STARTING_FEE", publicStartingFeeCents: 50000 }),
  );
  assert.equal(r.ok, true);
});

console.log("\nS8.A1 — commission limit vs. public commission, percent vs. flat\n");

test("commissionCeilingRate below the public PERCENT commission is rejected", () => {
  const r = validateNegotiationPolicyPatch(
    { commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingRate: 5 },
    ctx({ publicCommissionMode: "percent", publicCommissionRate: 10 }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION");
});

test("commissionCeilingAmountCents below the public FLAT commission is rejected (the unit-mismatch fix, item 8)", () => {
  const r = validateNegotiationPolicyPatch(
    { commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingAmountCents: 500 },
    ctx({ publicCommissionMode: "flat", publicCommissionRate: 1000 }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "COMMISSION_LIMIT_BELOW_PUBLIC_COMMISSION");
});

test("a flat-amount limit is compared against the flat public value, NOT the percent-rate field, when public is flat", () => {
  // commissionCeilingRate is submitted too, with a value that WOULD fail if
  // (incorrectly) compared against the flat public amount — proving the
  // branch genuinely reads commissionCeilingAmountCents for a flat public
  // commission, not commissionCeilingRate.
  const r = validateNegotiationPolicyPatch(
    { commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingAmountCents: 2000, commissionCeilingRate: 1 },
    ctx({ publicCommissionMode: "flat", publicCommissionRate: 1000 }),
  );
  assert.equal(r.ok, true);
});

test("commissionNegotiationMode != ALLOW_WITHIN_LIMIT skips the check", () => {
  const r = validateNegotiationPolicyPatch(
    { commissionNegotiationMode: "KEEP_PUBLIC_COMMISSION", commissionCeilingRate: 1 },
    ctx({ publicCommissionMode: "percent", publicCommissionRate: 10 }),
  );
  assert.equal(r.ok, true);
});

console.log("\nlimit-without-authorizing-mode (write-time rejection, item 9)\n");

test("commissionDurationLimitValue without ALLOW_WITHIN_LIMIT (patch mode) is rejected", () => {
  const r = validateNegotiationPolicyPatch(
    { commissionDurationMode: "KEEP_PUBLIC_DURATION", commissionDurationLimitValue: 60 },
    ctx(),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "LIMIT_SET_WITHOUT_AUTHORIZING_MODE");
});

test("commissionDurationLimitValue with mode omitted from the patch falls back to the EXISTING stored mode", () => {
  const authorized = validateNegotiationPolicyPatch(
    { commissionDurationLimitValue: 60 }, // mode not part of this patch
    ctx({ existingCommissionDurationMode: "ALLOW_WITHIN_LIMIT" }),
  );
  assert.equal(authorized.ok, true);

  const unauthorized = validateNegotiationPolicyPatch(
    { commissionDurationLimitValue: 60 },
    ctx({ existingCommissionDurationMode: "KEEP_PUBLIC_DURATION" }),
  );
  assert.equal(unauthorized.ok, false);
});

test("postingMaxDelayDays without ALLOW_DELAY_DAYS is rejected", () => {
  const r = validateNegotiationPolicyPatch({ postingNegotiationMode: "KEEP_DEADLINE", postingMaxDelayDays: 7 }, ctx());
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "LIMIT_SET_WITHOUT_AUTHORIZING_MODE");
});

test("postingMaxDelayDays WITH ALLOW_DELAY_DAYS is accepted", () => {
  const r = validateNegotiationPolicyPatch({ postingNegotiationMode: "ALLOW_DELAY_DAYS", postingMaxDelayDays: 7 }, ctx());
  assert.equal(r.ok, true);
});

test("giftApprovedSubstitutes without ALLOW_EQUIVALENT_APPROVED_OPTION is rejected", () => {
  const r = validateNegotiationPolicyPatch(
    { giftSubstitutionMode: "KEEP_OFFERED_BENEFIT", giftApprovedSubstitutes: ["alt product"] },
    ctx(),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "LIMIT_SET_WITHOUT_AUTHORIZING_MODE");
});

test("deliverablePolicyRules without ALLOW_SELECTED_CHANGES is rejected", () => {
  const r = validateNegotiationPolicyPatch(
    { deliverableNegotiationMode: "KEEP_REQUESTED", deliverablePolicyRules: [{ appliesTo: "any" }] },
    ctx(),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "LIMIT_SET_WITHOUT_AUTHORIZING_MODE");
});

test("a limit field explicitly set to null is never treated as 'set' — no rejection", () => {
  const r = validateNegotiationPolicyPatch(
    { postingNegotiationMode: "KEEP_DEADLINE", postingMaxDelayDays: null },
    ctx(),
  );
  assert.equal(r.ok, true);
});

console.log("\n§3.6 regression guard: ceilingCents/giftValueFlexibilityCents are NEVER subject to a 'without authorizing mode' rejection\n");

test("ceilingCents has no 'without authorizing mode' rejection at all — only the below-public-offer check applies to it", () => {
  // feeMode = KEEP_PUBLIC_OFFER (would "fail to authorize" a limit under the
  // new-field pattern) + a ceilingCents value present: must NOT be rejected
  // as LIMIT_SET_WITHOUT_AUTHORIZING_MODE — this validator has no such rule
  // for ceilingCents at all (see compensationShape.ts's parallel guard for
  // the READ side of this same exemption).
  const r = validateNegotiationPolicyPatch({ feeMode: "KEEP_PUBLIC_OFFER", ceilingCents: 99999999 }, ctx());
  assert.equal(r.ok, true);
});

console.log("\ngiftCashReplacementLimitCents (Calvin review, item 6: a dedicated limit, not a reuse of giftValueFlexibilityCents)\n");

test("giftCashReplacementLimitCents without ALLOW_UP_TO_AMOUNT is rejected", () => {
  const r = validateNegotiationPolicyPatch(
    { giftCashReplacementMode: "REJECT", giftCashReplacementLimitCents: 5000 },
    ctx(),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "LIMIT_SET_WITHOUT_AUTHORIZING_MODE");
});

test("giftCashReplacementLimitCents WITH ALLOW_UP_TO_AMOUNT is accepted", () => {
  const r = validateNegotiationPolicyPatch(
    { giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT", giftCashReplacementLimitCents: 5000 },
    ctx(),
  );
  assert.equal(r.ok, true);
});

test("giftCashReplacementLimitCents with mode omitted falls back to the EXISTING stored mode", () => {
  const authorized = validateNegotiationPolicyPatch(
    { giftCashReplacementLimitCents: 5000 },
    ctx({ existingGiftCashReplacementMode: "ALLOW_UP_TO_AMOUNT" }),
  );
  assert.equal(authorized.ok, true);
  const unauthorized = validateNegotiationPolicyPatch(
    { giftCashReplacementLimitCents: 5000 },
    ctx({ existingGiftCashReplacementMode: "REJECT" }),
  );
  assert.equal(unauthorized.ok, false);
});
