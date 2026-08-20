/**
 * PLU-169 (1f) — unit tests for the pure FinalAgreement builder + creator
 * projection. No DB. Run with:
 *   npx tsx --test src/db/finalAgreements.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFinalAgreementInput,
  resolveFinalDeliverables,
  toCreatorFinalAgreementView,
  type BuildFinalAgreementInput,
} from "./finalAgreements.js";
import type { FinalAgreement } from "./schema.js";

function baseInput(overrides: Partial<BuildFinalAgreementInput> = {}): BuildFinalAgreementInput {
  return {
    instanceId: "i1",
    campaignTermsSnapshotId: "terms-1",
    negotiationPolicySnapshotId: "policy-1",
    effectiveConfig: {},
    detailsSnapshot: undefined,
    finalDeliverables: [],
    agreedFeeCents: undefined,
    acceptanceSource: "AI_NEGOTIATION",
    sourceMessageId: undefined,
    acceptedAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  };
}

const reelDeliverable = {
  id: "del_1",
  platform: "instagram" as const,
  format: "reel" as const,
  quantity: 2,
};

console.log("\nbuildFinalAgreementInput — PAID\n");

test("PAID: fee + deliverables + timeline populated, commission/gift fields null", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      agreedFeeCents: 50000,
      effectiveConfig: { timeline: "Live by Sept 15", deliverables: "ignored — structured wins" },
      finalDeliverables: [reelDeliverable],
    }),
  );
  assert.equal(input.finalFeeCents, 50000);
  assert.equal(input.finalTimeline, "Live by Sept 15");
  assert.deepEqual(input.finalDeliverables, [reelDeliverable]);
  assert.equal(input.finalCommissionMode, null);
  assert.equal(input.finalCommissionRate, null);
  assert.equal(input.finalGiftProductDescription, null);
  assert.equal(input.finalGiftDisposition, null);
});

console.log("\nbuildFinalAgreementInput — AFFILIATE\n");

test("AFFILIATE: commission fields populated from effectiveConfig + detailsSnapshot, no fee", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      agreedFeeCents: undefined,
      effectiveConfig: { commissionRate: 15 },
      detailsSnapshot: { commissionMode: "percent", commissionDurationDays: 30, commissionConditions: "First purchase only" },
    }),
  );
  assert.equal(input.finalFeeCents, null);
  assert.equal(input.finalCommissionMode, "PERCENT");
  assert.equal(input.finalCommissionRate, 15);
  assert.equal(input.finalCommissionDurationDays, 30);
  assert.equal(input.finalCommissionConditions, "First purchase only");
});

test("AFFILIATE: flat commission mode maps to FLAT", () => {
  const input = buildFinalAgreementInput(
    baseInput({ detailsSnapshot: { commissionMode: "flat" } }),
  );
  assert.equal(input.finalCommissionMode, "FLAT");
});

// Review fix (PR #48): CampaignDetails' commissionAmount control stores ONE
// number whose unit is decided by commissionMode — dollars when "flat". The
// old code always wrote it into finalCommissionRate, leaving
// finalCommissionAmountCents permanently null for every flat deal.
test("FLAT mode routes the value to finalCommissionAmountCents (dollars->cents), never finalCommissionRate", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      effectiveConfig: { commissionRate: 20 }, // $20 flat, per the "flat" mode
      detailsSnapshot: { commissionMode: "flat" },
    }),
  );
  assert.equal(input.finalCommissionMode, "FLAT");
  assert.equal(input.finalCommissionAmountCents, 2000);
  assert.equal(input.finalCommissionRate, null, "PERCENT-mode column must stay null for a flat deal");
});

test("PERCENT mode routes the value to finalCommissionRate, never finalCommissionAmountCents", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      effectiveConfig: { commissionRate: 15 },
      detailsSnapshot: { commissionMode: "percent" },
    }),
  );
  assert.equal(input.finalCommissionRate, 15);
  assert.equal(input.finalCommissionAmountCents, null);
});

test("an unrecognized commissionMode string maps to null, never guessed", () => {
  const input = buildFinalAgreementInput(
    baseInput({ detailsSnapshot: { commissionMode: "something-else" } }),
  );
  assert.equal(input.finalCommissionMode, null);
});

console.log("\nbuildFinalAgreementInput — HYBRID (fee + commission both populated)\n");

test("HYBRID: both fee and commission populate together", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      agreedFeeCents: 30000,
      effectiveConfig: { commissionRate: 10 },
      detailsSnapshot: { commissionMode: "percent" },
    }),
  );
  assert.equal(input.finalFeeCents, 30000);
  assert.equal(input.finalCommissionMode, "PERCENT");
  assert.equal(input.finalCommissionRate, 10);
});

console.log("\nbuildFinalAgreementInput — GIFT_ONLY\n");

test("GIFT_ONLY: gift fields populated, fee/commission null", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      agreedFeeCents: undefined,
      effectiveConfig: { rewardDescription: "A free pair of running shoes" },
      detailsSnapshot: { giftDisposition: "KEEP" },
    }),
  );
  assert.equal(input.finalFeeCents, null);
  assert.equal(input.finalCommissionMode, null);
  assert.equal(input.finalGiftProductDescription, "A free pair of running shoes");
  assert.equal(input.finalGiftDisposition, "KEEP");
});

test("an unrecognized giftDisposition string maps to null, never guessed", () => {
  const input = buildFinalAgreementInput(baseInput({ detailsSnapshot: { giftDisposition: "MAYBE" } }));
  assert.equal(input.finalGiftDisposition, null);
});

console.log("\nfields with no current source (PLU-169 decision #3) — always inert, never invented\n");

test("finalPostingDate has no current source column and is always null", () => {
  const input = buildFinalAgreementInput(baseInput());
  assert.equal(input.finalPostingDate, null);
});

console.log("\nfinalScriptSubmissionRequired — review fix (PR #48): reads detailsSnapshot.scriptSubmission\n");

test('scriptSubmission "require" maps to true', () => {
  const input = buildFinalAgreementInput(baseInput({ detailsSnapshot: { scriptSubmission: "require" } }));
  assert.equal(input.finalScriptSubmissionRequired, true);
});

test('scriptSubmission "skip" maps to false', () => {
  const input = buildFinalAgreementInput(baseInput({ detailsSnapshot: { scriptSubmission: "skip" } }));
  assert.equal(input.finalScriptSubmissionRequired, false);
});

test("scriptSubmission absent/unset defaults to false, never guessed true", () => {
  const input = buildFinalAgreementInput(baseInput());
  assert.equal(input.finalScriptSubmissionRequired, false);
});

console.log("\nfinalFulfillmentTerms — review fix (PR #48): folds gift delivery method + promo code/contact + shipping\n");

test("finalFulfillmentTerms is null with no detailsSnapshot and no gift delivery info", () => {
  const input = buildFinalAgreementInput(baseInput());
  assert.equal(input.finalFulfillmentTerms, null);
});

test("promo_code delivery includes the actual promo code", () => {
  const input = buildFinalAgreementInput(
    baseInput({ detailsSnapshot: { giftDeliveryMethod: "promo_code", promoCode: "CREATOR20" } }),
  );
  assert.equal(input.finalFulfillmentTerms, "Promo code: CREATOR20");
});

test("manual_contact delivery includes the contact email", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      detailsSnapshot: { giftDeliveryMethod: "manual_contact", giftContactEmail: "gifts@brand.com" },
    }),
  );
  assert.equal(input.finalFulfillmentTerms, "Manual fulfillment — contact gifts@brand.com");
});

test("requiresShippingInfo appends a shipping line alongside the delivery method", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      detailsSnapshot: {
        giftDeliveryMethod: "promo_code",
        promoCode: "CREATOR20",
        requiresShippingInfo: true,
      },
    }),
  );
  assert.equal(input.finalFulfillmentTerms, "Promo code: CREATOR20; Shipping information required");
});

test("the worked example from the review comment: script approval + flat $20 commission + promo-code gift, all preserved together", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      effectiveConfig: { commissionRate: 20 },
      detailsSnapshot: {
        scriptSubmission: "require",
        commissionMode: "flat",
        giftDeliveryMethod: "promo_code",
        promoCode: "CREATOR20",
      },
    }),
  );
  assert.equal(input.finalScriptSubmissionRequired, true);
  assert.equal(input.finalCommissionMode, "FLAT");
  assert.equal(input.finalCommissionAmountCents, 2000);
  assert.equal(input.finalFulfillmentTerms, "Promo code: CREATOR20");
});

console.log("\nno private-policy field name ever appears in the builder output\n");

// Mirrors the codebase's existing POLICY_SNAPSHOT_KEYS-style leak-prevention
// tests: scan the serialized output for any private-policy-shaped key name.
const PRIVATE_POLICY_KEY_FRAGMENTS = [
  "floorCents",
  "ceilingCents",
  "preferredFeeCents",
  "commissionFloorRate",
  "commissionCeilingRate",
  "preferredCommissionRate",
  "openingOfferPosition",
  "overCeilingTolerance",
  "negotiationGuidance",
  "maxRounds",
];

test("JSON.stringify(input) never contains a private-policy key name", () => {
  const input = buildFinalAgreementInput(
    baseInput({
      effectiveConfig: {
        commissionRate: 10,
        // Simulates effectiveConfig accidentally carrying private fields too —
        // the builder must only ever READ the public keys it names explicitly.
        floorCents: 20000,
        ceilingCents: 50000,
        maxRounds: 5,
      },
    }),
  );
  const json = JSON.stringify(input);
  for (const fragment of PRIVATE_POLICY_KEY_FRAGMENTS) {
    assert.ok(!json.includes(fragment), `leaked private-policy key: ${fragment}`);
  }
});

console.log("\nresolveFinalDeliverables — Phase 1 pass-through\n");

function assertOk(
  result: ReturnType<typeof resolveFinalDeliverables>,
): asserts result is { ok: true; deliverables: import("../domain/deliverables.js").Deliverable[] } {
  assert.equal(result.ok, true, result.ok ? "" : `expected ok:true, got error: ${result.error}`);
}

test("a valid baseline array passes through unchanged", () => {
  const result = resolveFinalDeliverables({ baseline: [reelDeliverable] });
  assertOk(result);
  assert.deepEqual(result.deliverables, [reelDeliverable]);
});

test("a non-array baseline (null/undefined/legacy shape) resolves to ok:true with an empty array, never fails", () => {
  for (const baseline of [null, undefined, "not an array", []]) {
    const result = resolveFinalDeliverables({ baseline });
    assertOk(result);
    assert.deepEqual(result.deliverables, []);
  }
});

test("PLU-169 Greptile fix (PR #46): legacy id-less items (a launched, IMMUTABLE snapshot the id backfill can never reach) are PRESERVED with a freshly minted id, never dropped", () => {
  const legacyItem = { platform: "instagram", format: "reel", quantity: 2 }; // no id
  const result = resolveFinalDeliverables({ baseline: [legacyItem, reelDeliverable] });
  assertOk(result);
  assert.equal(result.deliverables.length, 2, "the legacy item's data must survive, not be silently lost");
  const normalizedLegacy = result.deliverables.find((d) => d.id !== reelDeliverable.id);
  assert.ok(normalizedLegacy, "the legacy item is present");
  assert.equal(typeof normalizedLegacy!.id, "string");
  assert.ok(normalizedLegacy!.id.length > 0, "a fresh id was minted");
  assert.equal(normalizedLegacy!.platform, "instagram");
  assert.equal(normalizedLegacy!.format, "reel");
  assert.equal(normalizedLegacy!.quantity, 2);
});

test("an item that already has an id keeps that EXACT id (not re-minted)", () => {
  const result = resolveFinalDeliverables({ baseline: [reelDeliverable] });
  assertOk(result);
  assert.equal(result.deliverables[0]?.id, reelDeliverable.id);
});

test("two legacy id-less items in the same array each get their OWN distinct minted id", () => {
  const a = { platform: "instagram", format: "reel", quantity: 1 };
  const b = { platform: "instagram", format: "story", quantity: 3 };
  const result = resolveFinalDeliverables({ baseline: [a, b] });
  assertOk(result);
  assert.equal(result.deliverables.length, 2);
  assert.notEqual(result.deliverables[0]?.id, result.deliverables[1]?.id);
});

test("optional fields (requirements/customLabel/notes) survive normalization when present", () => {
  const item = {
    platform: "instagram",
    format: "reel",
    quantity: 1,
    requirements: { durationSeconds: { min: 30, max: 60 } },
    customLabel: null,
    notes: "brand-requested angle",
  };
  const result = resolveFinalDeliverables({ baseline: [item] });
  assertOk(result);
  assert.deepEqual(result.deliverables[0]?.requirements, { durationSeconds: { min: 30, max: 60 } });
  assert.equal(result.deliverables[0]?.notes, "brand-requested angle");
});

// Review fix (PR #48): the old version silently FILTERED OUT malformed items
// instead of failing — so an invalid platform/format combination could
// survive into FinalAgreement, and a genuinely malformed item just vanished
// from the package with no record. Now the WHOLE resolution fails.
test("malformed array entries (wrong types) fail the WHOLE resolution, never silently dropped", () => {
  const result = resolveFinalDeliverables({
    baseline: [null, 42, "string", {}, reelDeliverable],
  });
  assert.equal(result.ok, false);
});

test("an invalid platform/format combination (not in PLATFORM_FORMAT_MATRIX) fails, never survives into FinalAgreement", () => {
  const invalid = { id: "del_bad", platform: "tiktok", format: "reel", quantity: 1 }; // tiktok only pairs with "video"
  const result = resolveFinalDeliverables({ baseline: [invalid] });
  assert.equal(result.ok, false);
});

test("one invalid item fails the ENTIRE package, not just that item — the valid sibling is not silently kept either", () => {
  const invalid = { id: "del_bad", platform: "tiktok", format: "reel", quantity: 1 };
  const result = resolveFinalDeliverables({ baseline: [reelDeliverable, invalid] });
  assert.equal(result.ok, false, "a partially-valid package must escalate, not silently ship only the good half");
});

test("platform \"other\" without a customLabel fails (deliverablesSchema's own rule)", () => {
  const result = resolveFinalDeliverables({
    baseline: [{ id: "del_custom", platform: "other", format: "other", quantity: 1 }],
  });
  assert.equal(result.ok, false);
});

test("duplicate ids within the package fail (deliverablesSchema's own rule)", () => {
  const result = resolveFinalDeliverables({
    baseline: [reelDeliverable, { ...reelDeliverable }],
  });
  assert.equal(result.ok, false);
});

console.log("\ntoCreatorFinalAgreementView — strips exactly the four internal fields\n");

function fakeFinalAgreement(): FinalAgreement {
  return {
    id: "fa_1",
    instanceId: "i1",
    campaignTermsSnapshotId: "terms-1",
    negotiationPolicySnapshotId: "policy-1",
    finalFeeCents: 50000,
    finalCommissionMode: null,
    finalCommissionRate: null,
    finalCommissionAmountCents: null,
    finalCommissionDurationDays: null,
    finalCommissionConditions: null,
    finalGiftProductDescription: null,
    finalGiftDisposition: null,
    finalFulfillmentTerms: null,
    finalDeliverables: [reelDeliverable],
    finalTimeline: "Live by Sept 15",
    finalPostingDate: null,
    finalUsageRights: null,
    finalExclusivity: null,
    finalAttributionWindow: null,
    finalPaymentTerms: null,
    finalScriptSubmissionRequired: false,
    approvedDeviations: null,
    acceptanceSource: "AI_NEGOTIATION",
    sourceMessageId: "m1",
    acceptedAt: new Date("2026-08-20T00:00:00Z"),
    contentBriefGeneratedAt: null,
    contentBriefCampaignBriefId: null,
    contentBriefAssetRef: null,
    contentBriefTemplateVersion: null,
    createdAt: new Date("2026-08-20T00:00:00Z"),
    updatedAt: new Date("2026-08-20T00:00:00Z"),
  };
}

test("strips id/instanceId/createdAt/updatedAt and nothing else", () => {
  const record = fakeFinalAgreement();
  const view = toCreatorFinalAgreementView(record);
  assert.equal("id" in view, false);
  assert.equal("instanceId" in view, false);
  assert.equal("createdAt" in view, false);
  assert.equal("updatedAt" in view, false);
  // Everything else survives, unchanged.
  const { id: _id, instanceId: _instanceId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = record;
  assert.deepEqual(view, rest);
});

test("the view carries no private-policy field name either (the table never had one to begin with)", () => {
  const view = toCreatorFinalAgreementView(fakeFinalAgreement());
  const json = JSON.stringify(view);
  for (const fragment of PRIVATE_POLICY_KEY_FRAGMENTS) {
    assert.ok(!json.includes(fragment), `leaked private-policy key: ${fragment}`);
  }
});
