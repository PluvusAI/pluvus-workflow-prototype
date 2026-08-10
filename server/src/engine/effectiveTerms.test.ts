/**
 * Unit tests for PLU-138 (1d) effective-terms resolver (snapshot-wins).
 * Pure logic — run with:
 *   npx tsx src/engine/effectiveTerms.test.ts
 *
 * Locks the source-of-truth contract: a valid launch snapshot ALWAYS wins over
 * the (legacy) node config, cents→dollars is converted exactly once, the
 * commission-only 0/0 shape survives (not +inf), and a no-snapshot journey is
 * left byte-identical so the golden matrix stays green.
 */

import assert from "node:assert/strict";
import { resolveEffectiveNegotiationConfig } from "./effectiveTerms.js";
import type { PolicyAuthority } from "./conversationContext/types.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// A fully-null PolicyAuthority; individual tests set only the fields they exercise.
function policy(overrides: Partial<PolicyAuthority>): PolicyAuthority {
  return {
    floorCents: null,
    ceilingCents: null,
    preferredFeeCents: null,
    commissionFloorRate: null,
    commissionCeilingRate: null,
    preferredCommissionRate: null,
    maxRounds: null,
    openingOfferPosition: null,
    overCeilingTolerance: null,
    negotiationGuidance: null,
    giftSubstitutionAllowed: null,
    giftValueFlexibilityCents: null,
    negotiableTerms: null,
    nonNegotiableTerms: null,
    ...overrides,
  };
}

function terms(details: Record<string, unknown>): { detailsSnapshot: unknown } {
  return { detailsSnapshot: details };
}

console.log("\neffectiveTerms — snapshot-wins resolver\n");

// 1. fee band: cents → dollars (÷100).
test("policy band floorCents/ceilingCents → termFloor/termCeiling in dollars", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: 20000, ceilingCents: 50000 }),
    config: {},
  });
  assert.deepEqual(r.config["termFloor"], { rate: 200 });
  assert.deepEqual(r.config["termCeiling"], { rate: 500 });
  assert.equal(r.bandLegacyFallback, false);
  assert.equal(r.source, "snapshot");
});

// 2. commission-only 0/0 (PLU-129 regression guard): both cents null → EXPLICIT
//    0/0 band (both defined), public commission set, ceiling NOT +inf/undefined.
test("commission-only (both cents null) → explicit termFloor/termCeiling rate 0", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: null, ceilingCents: null }),
    termsSnapshot: terms({ publicCommissionRate: 15 }),
    config: {},
  });
  assert.deepEqual(r.config["termFloor"], { rate: 0 });
  assert.deepEqual(r.config["termCeiling"], { rate: 0 });
  assert.equal((r.config["termCeiling"] as { rate: number }).rate, 0); // defined 0, not undefined
  assert.equal(r.config["commissionRate"], 15);
});

// 3. openingOfferPosition → recommendedOfferPosition (same 0..1 semantics), no
//    absolute preferred emitted.
test("openingOfferPosition maps to recommendedOfferPosition; no absolute preferred", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({
      floorCents: 20000,
      ceilingCents: 50000,
      openingOfferPosition: 0.6,
      preferredFeeCents: 40000,
    }),
    config: {},
  });
  assert.equal(r.config["recommendedOfferPosition"], 0.6);
  assert.equal(r.config["preferred"], undefined);
  assert.equal(r.config["preferredFeeCents"], undefined);
});

// 4. commission source is PUBLIC publicCommissionRate, never the private triad.
test("commissionRate comes from publicCommissionRate, private triad ignored", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({
      floorCents: 20000,
      ceilingCents: 50000,
      preferredCommissionRate: 22,
      commissionFloorRate: 18,
      commissionCeilingRate: 25,
    }),
    termsSnapshot: terms({ publicCommissionRate: 15 }),
    config: {},
  });
  assert.equal(r.config["commissionRate"], 15); // public
  // private commission fields never leak onto the effective config
  assert.equal(r.config["preferredCommissionRate"], undefined);
  assert.equal(r.config["commissionFloorRate"], undefined);
});

// 5. snapshot present + DIFFERENT config value present → snapshot wins.
test("snapshot band overrides a stale/conflicting config band", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: 20000, ceilingCents: 50000 }),
    config: { termFloor: { rate: 999 }, termCeiling: { rate: 9999 }, minBudget: 999, maxBudget: 9999 },
  });
  assert.equal((r.config["termFloor"] as { rate: number }).rate, 200);
  assert.equal((r.config["termCeiling"] as { rate: number }).rate, 500);
});

// 6. no policy snapshot → band from config, bandLegacyFallback true; when terms
//    also absent → source legacy_nodegraph.
test("no policy + no terms snapshot → legacy_nodegraph, band untouched", () => {
  const config = { termFloor: { rate: 200 }, termCeiling: { rate: 500 }, commissionRate: 10 };
  const r = resolveEffectiveNegotiationConfig({ config });
  assert.deepEqual(r.config, config); // shape-identical
  assert.equal(r.bandLegacyFallback, true);
  assert.equal(r.termsLegacyFallback, true);
  assert.equal(r.source, "legacy_nodegraph");
});

// 7. mixed null (floor set, ceiling null) → only floor overlaid; ceiling stays
//    config's → "floor without ceiling" still trips H1 no-ceiling downstream.
test("mixed band (floor only) overlays floor, leaves ceiling to config", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: 20000, ceilingCents: null }),
    config: {}, // no config ceiling → resolveBand(effective) sees floor but no ceiling
  });
  assert.deepEqual(r.config["termFloor"], { rate: 200 });
  assert.equal(r.config["termCeiling"], undefined);
});

// 8. input config is never mutated.
test("input config object is not mutated", () => {
  const config = { termFloor: { rate: 999 }, commissionRate: 10 };
  const snapshot = JSON.parse(JSON.stringify(config));
  resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: 20000, ceilingCents: 50000 }),
    termsSnapshot: terms({ publicCommissionRate: 15 }),
    config,
  });
  assert.deepEqual(config, snapshot); // original untouched
});

// 9. terms snapshot present, policy absent → source snapshot, bandLegacyFallback
//    true, termsLegacyFallback false (a gift/affiliate campaign can have public
//    terms but a null fee band).
test("terms snapshot only → public terms overlaid, band from config", () => {
  const r = resolveEffectiveNegotiationConfig({
    termsSnapshot: terms({ deliverables: "3 reels", timeline: "2 weeks", productOrOffer: "Gift box" }),
    config: { termFloor: { rate: 100 }, termCeiling: { rate: 300 } },
  });
  assert.equal(r.config["deliverables"], "3 reels");
  assert.equal(r.config["timeline"], "2 weeks");
  assert.equal(r.config["rewardDescription"], "Gift box");
  assert.equal((r.config["termCeiling"] as { rate: number }).rate, 300); // from config
  assert.equal(r.source, "snapshot");
  assert.equal(r.bandLegacyFallback, true);
  assert.equal(r.termsLegacyFallback, false);
});

// 10. public field name mapping: productOrOffer→rewardDescription,
//     publicPaymentTerms→paymentTerms; stale config values overridden.
test("public detailsSnapshot field-name mapping + override of stale config", () => {
  const r = resolveEffectiveNegotiationConfig({
    termsSnapshot: terms({
      deliverables: "SNAP deliverables",
      publicPaymentTerms: "Net 30",
      usageRights: "6 months",
    }),
    config: { deliverables: "STALE deliverables", paymentTerms: "STALE terms" },
  });
  assert.equal(r.config["deliverables"], "SNAP deliverables");
  assert.equal(r.config["paymentTerms"], "Net 30");
  assert.equal(r.config["usageRights"], "6 months");
});

// 11b. B2 rescue: a config with a floor but NO ceiling, pinned to a policy
//      snapshot that HAS a ceiling → the effective band gains the ceiling, so the
//      H1 no-ceiling escalation must NOT trip. This is why H1 was relocated to the
//      effective band for pinned journeys (a valid snapshot rescues a stale config).
test("floor-only config + snapshot ceiling → effective band has a ceiling (H1 rescue)", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: 20000, ceilingCents: 50000 }),
    config: { termFloor: { rate: 200 } }, // floor only, NO termCeiling/maxBudget
  });
  assert.deepEqual(r.config["termFloor"], { rate: 200 });
  assert.deepEqual(r.config["termCeiling"], { rate: 500 }); // rescued from the snapshot
});

// 11. 0/0 commission-only: recommendedOfferPosition / overCeilingTolerance are
//     NOT added even if policy carries them (template omits them on 0/0 nodes;
//     inert anyway). Keeps byte-identical on that shape.
test("0/0 shape skips recommendedOfferPosition / overCeilingTolerance overlay", () => {
  const r = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({
      floorCents: null,
      ceilingCents: null,
      openingOfferPosition: 0.5,
      overCeilingTolerance: 0.1,
    }),
    config: {},
  });
  assert.equal(r.config["recommendedOfferPosition"], undefined);
  assert.equal(r.config["overCeilingTolerance"], undefined);
});

console.log(`\n${n} passed\n`);
