/**
 * PLU-172 — unit tests for the Stage-1 Draft revision-identity primitive.
 * Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/draftRevision.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRevisionId,
  computeActivePublicRevisionId,
  computeActivePrivateRevisionId,
  PUBLIC_REVISION_FIELDS,
  PRIVATE_REVISION_FIELDS,
} from "./draftRevision.js";
import type { CampaignDetails, CampaignType, NegotiationPolicy } from "../db/schema.js";

function baseDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignType: "PAID",
    includesGifting: false,
    giftDisposition: null,
    objective: "Drive signups",
    productOrOffer: null,
    deliverables: "2 Reels", // deliberately NOT a tracked field — see below
    timeline: "30 days",
    usageRights: "90-day paid social",
    exclusivity: null,
    attributionWindow: null,
    publicStartingFeeCents: 50000,
    priceStrategy: "PROPOSE_STARTING_FEE",
    publicCommissionRate: null,
    commissionDurationDays: null,
    commissionDurationUnit: null,
    commissionConditions: null,
    deliverableQuantities: [{ id: "d1", platform: "instagram", format: "reel", quantity: 2 }],
    adAuthorization: null,
    postRetention: null,
    contentRepurposeRights: null,
    scriptSubmission: null,
    ...overrides,
  };
}

function basePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    floorCents: 40000,
    ceilingCents: 60000,
    preferredFeeCents: 50000,
    feeMode: "ALLOW_WITHIN_LIMIT",
    commissionFloorRate: null,
    commissionCeilingRate: null,
    commissionCeilingAmountCents: null,
    preferredCommissionRate: null,
    commissionNegotiationMode: "KEEP_PUBLIC_COMMISSION",
    commissionDurationMode: "KEEP_PUBLIC_DURATION",
    commissionDurationLimitValue: null,
    commissionDurationLimitUnit: null,
    giftSubstitutionAllowed: null,
    giftSubstitutionMode: "KEEP_OFFERED_BENEFIT",
    giftApprovedSubstitutes: null,
    giftValueFlexibilityCents: null,
    giftCashReplacementMode: "REJECT",
    giftCashReplacementLimitCents: null,
    deliverableNegotiationMode: "KEEP_REQUESTED",
    deliverablePolicyRules: null,
    postingNegotiationMode: "KEEP_DEADLINE",
    postingMaxDelayDays: null,
    rightsPolicyRules: null,
    scriptWaiverMode: "KEEP_SUBMISSION_REQUIRED",
    outOfPolicyAction: "ASK_FOR_APPROVAL",
    negotiableTerms: null,
    nonNegotiableTerms: null,
    negotiationGuidance: null,
    maxRounds: 3,
    overCeilingTolerance: 0,
    ...overrides,
  };
}

test("determinism: identical input produces the identical hash, repeatedly", () => {
  const details = baseDetails();
  const a = computeRevisionId(details, PUBLIC_REVISION_FIELDS);
  const b = computeRevisionId(details, PUBLIC_REVISION_FIELDS);
  const c = computeRevisionId(baseDetails(), PUBLIC_REVISION_FIELDS);
  assert.equal(a, b);
  assert.equal(a, c, "two structurally-identical-but-distinct objects must hash the same");
});

test("sensitivity: a change to ANY tracked public field changes the hash", () => {
  const base = computeRevisionId(baseDetails(), PUBLIC_REVISION_FIELDS);
  for (const field of PUBLIC_REVISION_FIELDS) {
    const changed = computeRevisionId(
      baseDetails({ [field]: "___CHANGED___" }),
      PUBLIC_REVISION_FIELDS,
    );
    assert.notEqual(changed, base, `changing tracked field "${field}" must change the hash`);
  }
});

test("sensitivity: a change to ANY tracked private field changes the hash", () => {
  const base = computeRevisionId(basePolicy(), PRIVATE_REVISION_FIELDS);
  for (const field of PRIVATE_REVISION_FIELDS) {
    const changed = computeRevisionId(
      basePolicy({ [field]: "___CHANGED___" }),
      PRIVATE_REVISION_FIELDS,
    );
    assert.notEqual(changed, base, `changing tracked field "${field}" must change the hash`);
  }
});

test("an UNTRACKED field change does NOT change the hash (deliverables free-text is deliberately excluded)", () => {
  const a = computeRevisionId(baseDetails(), PUBLIC_REVISION_FIELDS);
  const b = computeRevisionId(baseDetails({ deliverables: "totally different free text" }), PUBLIC_REVISION_FIELDS);
  assert.equal(a, b, "deliverables (free text) must not be part of the hash — deliverableQuantities is the one frozen source");
  // Sanity: something NOT in either list at all is also ignored.
  const c = computeRevisionId(baseDetails({ createdAt: new Date(0) }), PUBLIC_REVISION_FIELDS);
  assert.equal(a, c);
});

test("nested JSON key order does not change the hash (jsonb array-of-objects fields)", () => {
  const a = computeRevisionId(
    basePolicy({ rightsPolicyRules: [{ term: "usageRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" }] }),
    PRIVATE_REVISION_FIELDS,
  );
  const b = computeRevisionId(
    basePolicy({ rightsPolicyRules: [{ minimumUnit: "DAYS", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, term: "usageRights" }] }),
    PRIVATE_REVISION_FIELDS,
  );
  assert.equal(a, b, "re-serializing the same rule with keys in a different order must not change the hash");
});

test("a genuine change INSIDE a nested JSON array field still changes the hash", () => {
  const a = computeRevisionId(
    basePolicy({ rightsPolicyRules: [{ term: "usageRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 30, minimumUnit: "DAYS" }] }),
    PRIVATE_REVISION_FIELDS,
  );
  const b = computeRevisionId(
    basePolicy({ rightsPolicyRules: [{ term: "usageRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 45, minimumUnit: "DAYS" }] }),
    PRIVATE_REVISION_FIELDS,
  );
  assert.notEqual(a, b);
});

test("undefined and explicit null on a tracked field hash identically", () => {
  const withUndefined = { ...baseDetails() };
  delete withUndefined["exclusivity"];
  const withNull = baseDetails({ exclusivity: null });
  assert.equal(
    computeRevisionId(withUndefined, PUBLIC_REVISION_FIELDS),
    computeRevisionId(withNull, PUBLIC_REVISION_FIELDS),
  );
});

test("field lists have no duplicate entries", () => {
  assert.equal(new Set(PUBLIC_REVISION_FIELDS).size, PUBLIC_REVISION_FIELDS.length);
  assert.equal(new Set(PRIVATE_REVISION_FIELDS).size, PRIVATE_REVISION_FIELDS.length);
});

test("the hash is a 24-character lowercase hex string", () => {
  const id = computeRevisionId(baseDetails(), PUBLIC_REVISION_FIELDS);
  assert.match(id, /^[0-9a-f]{24}$/);
});

console.log("\ncomputeActivePublicRevisionId / computeActivePrivateRevisionId — Calvin review, point B: revision hash and activation snapshot MUST use the exact same active-policy projection\n");

test("an inactive (dormant) commission value does NOT affect the PUBLIC revision id for a PAID campaign", () => {
  // AFFILIATE-only fields left populated on a PAID campaign (as if the
  // brand had switched structures and Draft just never cleared them) —
  // projectActivePublicFields excludes them; the active-projected hash
  // must be identical to a campaign that never had them set at all.
  const withDormantCommission = baseDetails({
    campaignType: "PAID",
    publicCommissionRate: 15,
    commissionDurationDays: 60,
    commissionConditions: "some stale note",
  }) as unknown as CampaignDetails;
  const withoutDormantCommission = baseDetails({
    campaignType: "PAID",
    publicCommissionRate: null,
    commissionDurationDays: null,
    commissionConditions: null,
  }) as unknown as CampaignDetails;
  assert.equal(
    computeActivePublicRevisionId(withDormantCommission),
    computeActivePublicRevisionId(withoutDormantCommission),
    "a dormant, inactive field must not change the approved revision id — only ACTIVE fields are hashed",
  );
});

test("switching AWAY from a structure and back reproduces the SAME active public revision id, provided the active fields end up equal", () => {
  const paidNow = baseDetails({ campaignType: "PAID", publicCommissionRate: 999 }) as unknown as CampaignDetails; // dormant leftover
  const paidClean = baseDetails({ campaignType: "PAID" }) as unknown as CampaignDetails;
  assert.equal(computeActivePublicRevisionId(paidNow), computeActivePublicRevisionId(paidClean));
});

test("an inactive (dormant) fee value does NOT affect the PRIVATE revision id for an AFFILIATE campaign", () => {
  const dormantFee = basePolicy({ floorCents: 12345, ceilingCents: 67890 }) as unknown as NegotiationPolicy;
  const noFee = basePolicy({ floorCents: null, ceilingCents: null }) as unknown as NegotiationPolicy;
  const ctx = { campaignType: "AFFILIATE" as CampaignType, includesGifting: false };
  assert.equal(
    computeActivePrivateRevisionId(dormantFee, ctx),
    computeActivePrivateRevisionId(noFee, ctx),
    "AFFILIATE needs no fee authority — a dormant fee value must not change the approved private revision id",
  );
});

test("an ACTIVE field difference still changes the private revision id (the projection excludes dormant fields, not real ones)", () => {
  const a = basePolicy({ commissionFloorRate: 5 }) as unknown as NegotiationPolicy;
  const b = basePolicy({ commissionFloorRate: 10 }) as unknown as NegotiationPolicy;
  const ctx = { campaignType: "AFFILIATE" as CampaignType, includesGifting: false };
  assert.notEqual(computeActivePrivateRevisionId(a, ctx), computeActivePrivateRevisionId(b, ctx));
});

test("computeActivePrivateRevisionId drops a rightsPolicyRules entry with no public value, same as the activation snapshot does", () => {
  const withDeadRule = basePolicy({
    rightsPolicyRules: [{ term: "contentRepurposeRights", mode: "KEEP_REQUESTED" }],
  }) as unknown as NegotiationPolicy;
  const withNoRules = basePolicy({ rightsPolicyRules: [] }) as unknown as NegotiationPolicy;
  // contentRepurposeRights has no public value on this fixture (baseDetails
  // sets it null) — the rule above is dead on arrival, same as at launch.
  const ctx = { campaignType: "PAID" as CampaignType, includesGifting: false, contentRepurposeRights: null };
  assert.equal(
    computeActivePrivateRevisionId(withDeadRule, ctx),
    computeActivePrivateRevisionId(withNoRules, ctx),
  );
});
