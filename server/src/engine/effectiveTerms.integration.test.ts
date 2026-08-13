/**
 * PLU-138 (1d) integration: prove the snapshot-wins resolver flows THROUGH the
 * real negotiation request builder and the real output guard — i.e. the ticket
 * headline "old nodeGraph values cannot override a valid snapshot" holds at the
 * exact seams the agent + guard read.
 *   npx tsx src/engine/effectiveTerms.integration.test.ts
 */

import assert from "node:assert/strict";
import { resolveEffectiveNegotiationConfig } from "./effectiveTerms.js";
import { buildNegotiationRequest } from "./providers.js";
import { guardConstraintsFromConfig } from "./guards/outputGuard.js";
import type { PolicyAuthority } from "./conversationContext/types.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function policy(overrides: Partial<PolicyAuthority>): PolicyAuthority {
  return {
    floorCents: null, ceilingCents: null, preferredFeeCents: null,
    commissionFloorRate: null, commissionCeilingRate: null, preferredCommissionRate: null,
    maxRounds: null, openingOfferPosition: null, overCeilingTolerance: null,
    negotiationGuidance: null, giftSubstitutionAllowed: null, giftValueFlexibilityCents: null,
    negotiableTerms: null, nonNegotiableTerms: null, ...overrides,
  };
}

console.log("\neffectiveTerms — integration through request builder + guard\n");

// THE HEADLINE: a stale nodeGraph band ($999/$9999) is OVERRIDDEN by the pinned
// policy snapshot ($200/$500) at the exact object the agent negotiates against.
test("nodeGraph band cannot override a valid snapshot (buildNegotiationRequest)", () => {
  const config = {
    termFloor: { rate: 999 }, termCeiling: { rate: 9999 },
    minBudget: 999, maxBudget: 9999,
    commissionRate: 10, // stale public commission on the node
  };
  const { config: effectiveConfig } = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: 20000, ceilingCents: 50000 }),
    termsSnapshot: { detailsSnapshot: { publicCommissionRate: 15 } },
    config,
  });
  const req = buildNegotiationRequest(0, effectiveConfig, "hi", undefined);
  assert.equal(req.campaignConstraints.termFloor.rate, 200); // snapshot, NOT 999
  assert.equal(req.campaignConstraints.termCeiling.rate, 500); // snapshot, NOT 9999
  assert.equal(req.campaignConstraints.commissionRate, 15); // public snapshot, NOT 10
});

// GUARD PARITY: the guard's band + commission come from the SAME effective config,
// so a draft stating the snapshot's public commission (15) is not falsely blocked,
// and its floor/ceiling leak-scan uses the snapshot band (200/500), not 999/9999.
test("output guard reads the same snapshot band + commission (no divergence)", () => {
  const config = {
    termFloor: { rate: 999 }, termCeiling: { rate: 9999 },
    commissionRate: 10,
  };
  const { config: effectiveConfig } = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: 20000, ceilingCents: 50000 }),
    termsSnapshot: { detailsSnapshot: { publicCommissionRate: 15 } },
    config,
  });
  const gc = guardConstraintsFromConfig(effectiveConfig, undefined, undefined);
  assert.equal(gc.floor, 200);
  assert.equal(gc.ceiling, 500);
  assert.equal(gc.commissionRate, 15); // guard allowlists the snapshot commission
});

// BYTE-IDENTICAL LEGACY: a no-snapshot journey → effectiveConfig is shape-identical
// to config, so the request the agent sees is unchanged (golden-matrix safety).
test("no-snapshot journey → request identical to raw-config request", () => {
  const config = {
    termFloor: { rate: 200 }, termCeiling: { rate: 500 },
    commissionRate: 12, deliverables: "3 reels", timeline: "2 weeks",
    recommendedOfferPosition: 0.5,
  };
  const { config: effectiveConfig, source, bandLegacyFallback } =
    resolveEffectiveNegotiationConfig({ config });
  assert.equal(source, "legacy_nodegraph");
  assert.equal(bandLegacyFallback, true);
  const legacyReq = buildNegotiationRequest(1, config, "hi", undefined);
  const effReq = buildNegotiationRequest(1, effectiveConfig, "hi", undefined);
  assert.deepEqual(effReq.campaignConstraints, legacyReq.campaignConstraints);
});

// COMMISSION-ONLY 0/0 through the real builder: ceiling is a defined 0 (a real
// cap), not +inf — the regression guard for the PLU-129 unbounded-agree bug.
test("commission-only 0/0 → builder sees termCeiling.rate === 0 (not +inf)", () => {
  const { config: effectiveConfig } = resolveEffectiveNegotiationConfig({
    policyAuthority: policy({ floorCents: null, ceilingCents: null }),
    termsSnapshot: { detailsSnapshot: { publicCommissionRate: 20 } },
    config: {},
  });
  const req = buildNegotiationRequest(0, effectiveConfig, "hi", undefined);
  assert.equal(req.campaignConstraints.termCeiling.rate, 0);
  assert.equal(req.campaignConstraints.commissionRate, 20);
});

console.log(`\n${n} passed\n`);
