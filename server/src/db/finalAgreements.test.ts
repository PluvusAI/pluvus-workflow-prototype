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

test("finalFulfillmentTerms / finalPostingDate / finalScriptSubmissionRequired are always the documented inert default", () => {
  const input = buildFinalAgreementInput(baseInput());
  assert.equal(input.finalFulfillmentTerms, null);
  assert.equal(input.finalPostingDate, null);
  assert.equal(input.finalScriptSubmissionRequired, false);
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

test("a valid baseline array passes through unchanged", () => {
  const result = resolveFinalDeliverables({ baseline: [reelDeliverable] });
  assert.deepEqual(result, [reelDeliverable]);
});

test("a non-array baseline (null/undefined/legacy shape) resolves to an empty array, never throws", () => {
  assert.deepEqual(resolveFinalDeliverables({ baseline: null }), []);
  assert.deepEqual(resolveFinalDeliverables({ baseline: undefined }), []);
  assert.deepEqual(resolveFinalDeliverables({ baseline: "not an array" }), []);
});

test("legacy id-less items (pre-PLU-169, before the id backfill) are filtered out defensively", () => {
  const legacyItem = { platform: "instagram", format: "reel", quantity: 2 }; // no id
  const result = resolveFinalDeliverables({ baseline: [legacyItem, reelDeliverable] });
  assert.deepEqual(result, [reelDeliverable]);
});

test("malformed array entries (wrong types) are filtered out, never thrown on", () => {
  const result = resolveFinalDeliverables({
    baseline: [null, 42, "string", {}, reelDeliverable],
  });
  assert.deepEqual(result, [reelDeliverable]);
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
