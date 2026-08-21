/**
 * PLU-172 — unit tests for the compensation-shape predicates and
 * activation-time private-policy projection. Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/compensationShape.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  needsFee,
  needsCommission,
  isGiftOnly,
  wantsGifting,
  projectActivePublicFields,
  projectActivePrivatePolicyFields,
  buildRightsPublicValues,
} from "./compensationShape.js";
import { RIGHTS_TERMS } from "./rightsPolicyRules.js";

console.log("\npredicates\n");

test("needsFee: PAID and HYBRID only", () => {
  assert.equal(needsFee("PAID"), true);
  assert.equal(needsFee("HYBRID"), true);
  assert.equal(needsFee("AFFILIATE"), false);
  assert.equal(needsFee("GIFT_ONLY"), false);
});

test("needsCommission: AFFILIATE and HYBRID only", () => {
  assert.equal(needsCommission("AFFILIATE"), true);
  assert.equal(needsCommission("HYBRID"), true);
  assert.equal(needsCommission("PAID"), false);
  assert.equal(needsCommission("GIFT_ONLY"), false);
});

test("wantsGifting: GIFT_ONLY is always gifting; others depend on includesGifting", () => {
  assert.equal(wantsGifting("GIFT_ONLY", false), true);
  assert.equal(wantsGifting("PAID", true), true);
  assert.equal(wantsGifting("PAID", false), false);
});

test("RIGHTS_TERMS and buildRightsPublicValues' key list stay in sync (review item 10's helper contract)", () => {
  const details: Record<string, unknown> = {};
  for (const term of RIGHTS_TERMS) details[term] = `value-for-${term}`;
  const built = buildRightsPublicValues(details);
  assert.deepEqual(Object.keys(built).sort(), [...RIGHTS_TERMS].sort());
});

console.log("\nprojectActivePublicFields\n");

function publicRow(overrides: Record<string, unknown> = {}) {
  return {
    campaignType: "PAID" as const,
    includesGifting: false,
    publicStartingFeeCents: 50000,
    priceStrategy: "PROPOSE_STARTING_FEE",
    publicCommissionRate: 10,
    commissionDurationDays: 30,
    commissionDurationUnit: "DAYS",
    commissionConditions: "flat window",
    giftDisposition: "KEEP",
    ...overrides,
  };
}

test("PAID: fee fields survive, commission fields nulled, gift nulled (no gifting)", () => {
  const out = projectActivePublicFields(publicRow({ campaignType: "PAID" }));
  assert.equal(out.publicStartingFeeCents, 50000);
  assert.equal(out.priceStrategy, "PROPOSE_STARTING_FEE");
  assert.equal(out.publicCommissionRate, null);
  assert.equal(out.commissionDurationDays, null);
  assert.equal(out.commissionDurationUnit, null);
  assert.equal(out.commissionConditions, null);
  assert.equal(out.giftDisposition, null);
});

test("AFFILIATE: commission fields survive, fee fields nulled", () => {
  const out = projectActivePublicFields(publicRow({ campaignType: "AFFILIATE" }));
  assert.equal(out.publicStartingFeeCents, null);
  assert.equal(out.priceStrategy, null);
  assert.equal(out.publicCommissionRate, 10);
  assert.equal(out.commissionDurationDays, 30);
});

test("GIFT_ONLY: fee AND commission nulled, gift survives", () => {
  const out = projectActivePublicFields(publicRow({ campaignType: "GIFT_ONLY" }));
  assert.equal(out.publicStartingFeeCents, null);
  assert.equal(out.publicCommissionRate, null);
  assert.equal(out.giftDisposition, "KEEP");
});

test("HYBRID: both fee and commission survive", () => {
  const out = projectActivePublicFields(publicRow({ campaignType: "HYBRID" }));
  assert.equal(out.publicStartingFeeCents, 50000);
  assert.equal(out.publicCommissionRate, 10);
});

test("PAID + includesGifting: gift fields survive too (additive gifting)", () => {
  const out = projectActivePublicFields(publicRow({ campaignType: "PAID", includesGifting: true }));
  assert.equal(out.giftDisposition, "KEEP");
});

test("does not mutate the input", () => {
  const input = publicRow({ campaignType: "GIFT_ONLY" });
  const before = JSON.stringify(input);
  projectActivePublicFields(input);
  assert.equal(JSON.stringify(input), before);
});

console.log("\nprojectActivePrivatePolicyFields — campaignType exclusion (pre-existing fields, unchanged rule)\n");

function privateRow(overrides: Record<string, unknown> = {}) {
  return {
    floorCents: 40000,
    ceilingCents: 60000,
    preferredFeeCents: 50000,
    feeMode: "ALLOW_WITHIN_LIMIT",
    commissionFloorRate: 5,
    commissionCeilingRate: 20,
    commissionCeilingAmountCents: null,
    preferredCommissionRate: 10,
    commissionNegotiationMode: "ALLOW_WITHIN_LIMIT",
    commissionDurationMode: "ALLOW_WITHIN_LIMIT",
    commissionDurationLimitValue: 60,
    commissionDurationLimitUnit: "DAYS",
    giftSubstitutionAllowed: true,
    giftSubstitutionMode: "ALLOW_EQUIVALENT_APPROVED_OPTION",
    giftApprovedSubstitutes: ["alt product"],
    giftValueFlexibilityCents: 5000,
    giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT",
    giftCashReplacementLimitCents: 7500,
    deliverableNegotiationMode: "ALLOW_SELECTED_CHANGES",
    deliverablePolicyRules: [{ appliesTo: "any", allowQuantityDecreaseTo: 1 }],
    postingNegotiationMode: "ALLOW_DELAY_DAYS",
    postingMaxDelayDays: 7,
    rightsPolicyRules: [{ term: "usageRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" }],
    scriptWaiverMode: "ALLOW_WAIVER",
    outOfPolicyAction: "ASK_FOR_APPROVAL",
    ...overrides,
  };
}

const ALL_TERMS_HAVE_PUBLIC_VALUE = Object.fromEntries(RIGHTS_TERMS.map((t) => [t, "some value"]));

test("!needsFee: floorCents/ceilingCents/preferredFeeCents nulled; feeMode itself is NOT nulled", () => {
  const out = projectActivePrivatePolicyFields(privateRow(), {
    campaignType: "AFFILIATE",
    includesGifting: false,
    rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE,
  });
  assert.equal(out.floorCents, null);
  assert.equal(out.ceilingCents, null);
  assert.equal(out.preferredFeeCents, null);
  assert.equal(out.feeMode, "ALLOW_WITHIN_LIMIT", "the MODE survives even with no campaign-level fee authority — only the numeric bound is excluded");
});

test("!needsCommission: commission rate fields nulled", () => {
  const out = projectActivePrivatePolicyFields(privateRow(), {
    campaignType: "PAID",
    includesGifting: false,
    rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE,
  });
  assert.equal(out.commissionFloorRate, null);
  assert.equal(out.commissionCeilingRate, null);
  assert.equal(out.preferredCommissionRate, null);
});

test("!wantsGifting: giftSubstitutionAllowed/giftValueFlexibilityCents nulled", () => {
  const out = projectActivePrivatePolicyFields(privateRow(), {
    campaignType: "PAID",
    includesGifting: false,
    rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE,
  });
  assert.equal(out.giftSubstitutionAllowed, null);
  assert.equal(out.giftValueFlexibilityCents, null);
});

console.log("\nprojectActivePrivatePolicyFields — mode exclusion (NEW fields only)\n");

test("commissionCeilingAmountCents nulled when commissionNegotiationMode !== ALLOW_WITHIN_LIMIT", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ commissionNegotiationMode: "KEEP_PUBLIC_COMMISSION", commissionCeilingAmountCents: 9999 }),
    { campaignType: "HYBRID", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.commissionCeilingAmountCents, null);
});

test("commissionCeilingAmountCents SURVIVES when mode === ALLOW_WITHIN_LIMIT", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ commissionNegotiationMode: "ALLOW_WITHIN_LIMIT", commissionCeilingAmountCents: 9999 }),
    { campaignType: "HYBRID", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.commissionCeilingAmountCents, 9999);
});

test("commissionDurationLimitValue/Unit nulled when mode !== ALLOW_WITHIN_LIMIT", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ commissionDurationMode: "KEEP_PUBLIC_DURATION" }),
    { campaignType: "HYBRID", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.commissionDurationLimitValue, null);
  assert.equal(out.commissionDurationLimitUnit, null);
});

test("giftApprovedSubstitutes nulled when giftSubstitutionMode !== ALLOW_EQUIVALENT_APPROVED_OPTION", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ giftSubstitutionMode: "KEEP_OFFERED_BENEFIT" }),
    { campaignType: "GIFT_ONLY", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.giftApprovedSubstitutes, null);
});

test("giftCashReplacementLimitCents nulled when giftCashReplacementMode !== ALLOW_UP_TO_AMOUNT (Calvin review item 6 — a DEDICATED, mode-gated limit, unlike giftValueFlexibilityCents)", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ giftCashReplacementMode: "REJECT", giftCashReplacementLimitCents: 9999 }),
    { campaignType: "GIFT_ONLY", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.giftCashReplacementLimitCents, null);
});

test("giftCashReplacementLimitCents SURVIVES when mode === ALLOW_UP_TO_AMOUNT", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ giftCashReplacementMode: "ALLOW_UP_TO_AMOUNT", giftCashReplacementLimitCents: 9999 }),
    { campaignType: "GIFT_ONLY", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.giftCashReplacementLimitCents, 9999);
});

test("scriptWaiverMode is NEVER nulled — it has no associated limit field to gate", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ scriptWaiverMode: "ALLOW_WAIVER" }),
    { campaignType: "GIFT_ONLY", includesGifting: false, rightsPublicValues: {} },
  );
  assert.equal(out.scriptWaiverMode, "ALLOW_WAIVER");
});

test("postingMaxDelayDays nulled when postingNegotiationMode !== ALLOW_DELAY_DAYS", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ postingNegotiationMode: "KEEP_DEADLINE" }),
    { campaignType: "PAID", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.postingMaxDelayDays, null);
});

test("deliverablePolicyRules nulled when deliverableNegotiationMode !== ALLOW_SELECTED_CHANGES", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ deliverableNegotiationMode: "KEEP_REQUESTED" }),
    { campaignType: "PAID", includesGifting: false, rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE },
  );
  assert.equal(out.deliverablePolicyRules, null);
});

console.log("\nprojectActivePrivatePolicyFields — the §3.6 regression guard: pre-existing fields are NEVER mode-gated\n");

test("ceilingCents SURVIVES under feeMode = KEEP_PUBLIC_OFFER (would starve the live negotiation agent if nulled)", () => {
  const out = projectActivePrivatePolicyFields(privateRow({ feeMode: "KEEP_PUBLIC_OFFER" }), {
    campaignType: "PAID",
    includesGifting: false,
    rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE,
  });
  assert.equal(out.ceilingCents, 60000, "ceilingCents must NOT be nulled by feeMode — only by campaignType, unchanged from today");
  assert.equal(out.floorCents, 40000);
  assert.equal(out.preferredFeeCents, 50000);
});

test("giftValueFlexibilityCents SURVIVES under giftCashReplacementMode = REJECT", () => {
  const out = projectActivePrivatePolicyFields(privateRow({ giftCashReplacementMode: "REJECT" }), {
    campaignType: "GIFT_ONLY",
    includesGifting: false,
    rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE,
  });
  assert.equal(out.giftValueFlexibilityCents, 5000, "giftValueFlexibilityCents must NOT be nulled by giftCashReplacementMode");
});

console.log("\nprojectActivePrivatePolicyFields — rights rules excluded when the public term has no value\n");

test("a rightsPolicyRules entry for a term with NO public value is dropped", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({
      rightsPolicyRules: [
        { term: "usageRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" },
        { term: "contentRepurposeRights", mode: "KEEP_REQUESTED" },
      ],
    }),
    {
      campaignType: "PAID",
      includesGifting: false,
      // contentRepurposeRights has no public collector yet — always null today.
      rightsPublicValues: { usageRights: "90 days", contentRepurposeRights: null },
    },
  );
  const rules = out.rightsPolicyRules as Array<{ term: string }>;
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.term, "usageRights");
});

test("a rightsPolicyRules entry for a term whose public value is an empty string is also dropped", () => {
  const out = projectActivePrivatePolicyFields(
    privateRow({ rightsPolicyRules: [{ term: "exclusivity", mode: "KEEP_REQUESTED" }] }),
    { campaignType: "PAID", includesGifting: false, rightsPublicValues: { exclusivity: "   " } },
  );
  assert.equal((out.rightsPolicyRules as unknown[]).length, 0);
});

test("does not mutate the input", () => {
  const input = privateRow();
  const before = JSON.stringify(input);
  projectActivePrivatePolicyFields(input, {
    campaignType: "AFFILIATE",
    includesGifting: false,
    rightsPublicValues: ALL_TERMS_HAVE_PUBLIC_VALUE,
  });
  assert.equal(JSON.stringify(input), before);
});
