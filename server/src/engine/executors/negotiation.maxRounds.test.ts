/**
 * PLU-142 follow-up — unit tests for resolveMaxRounds, the ONE authoritative
 * maxRounds precedence used by executeNegotiation's pre-build hard stop, the
 * post-agent counter guard, relationshipWarmth, and (via effectiveConfig,
 * built from the same immutable snapshot row) the agent request itself.
 *
 * Reproduces the reported bug directly: workflow maxRounds=2 / pinned policy=5
 * must NOT reject round 2 early (the policy is authoritative and allows 5);
 * workflow maxRounds=5 / pinned policy=2 must resolve to 2 everywhere, not the
 * stale workflow value.
 *
 * Follow-up 2: a policy pin that exists but cannot be VERIFIED (campaign
 * unresolved / row missing / cross-campaign) must be flagged via
 * `policyPinUnresolved` so the caller never treats the (necessarily
 * conservative) fallback `maxRounds` as grounds for a terminal auto-reject —
 * that must defer to the real snapshot-integrity gate instead.
 *
 * Pure logic — no DB. Run with:
 *   npx tsx --test src/engine/executors/negotiation.maxRounds.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveMaxRounds } from "./negotiation.js";

test("pinned policy maxRounds wins over a LOWER workflow config value (workflow=2, policy=5 → 5, not an early reject)", () => {
  const r = resolveMaxRounds({
    config: { maxRounds: 2 },
    negotiationPolicySnapshotId: "policy-1",
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: { campaignId: "camp-1", maxRounds: 5 },
  });
  assert.equal(r.maxRounds, 5, "the authoritative pinned policy value must win, not the stale workflow config");
  assert.equal(r.policyPinUnresolved, false);
});

test("pinned policy maxRounds wins over a HIGHER workflow config value (workflow=5, policy=2 → 2, so round 2 stops)", () => {
  const r = resolveMaxRounds({
    config: { maxRounds: 5 },
    negotiationPolicySnapshotId: "policy-1",
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: { campaignId: "camp-1", maxRounds: 2 },
  });
  assert.equal(r.maxRounds, 2, "the authoritative pinned policy value must win, not the looser workflow config");
  assert.equal(r.policyPinUnresolved, false);
});

test("no pinned snapshot id → raw config value used (legacy/no-snapshot journey, unchanged)", () => {
  const r = resolveMaxRounds({
    config: { maxRounds: 3 },
    negotiationPolicySnapshotId: null,
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: undefined,
  });
  assert.equal(r.maxRounds, 3);
  assert.equal(r.policyPinUnresolved, false, "no pin at all is not an unresolved pin");
});

test("no config maxRounds and no pin → documented default of 5", () => {
  const r = resolveMaxRounds({
    config: {},
    negotiationPolicySnapshotId: null,
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: undefined,
  });
  assert.equal(r.maxRounds, 5);
  assert.equal(r.policyPinUnresolved, false);
});

test("pinned snapshot with null maxRounds (never configured) falls through to raw config, still verified", () => {
  const r = resolveMaxRounds({
    config: { maxRounds: 7 },
    negotiationPolicySnapshotId: "policy-1",
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: { campaignId: "camp-1", maxRounds: null },
  });
  assert.equal(r.maxRounds, 7, "a present-but-null policy maxRounds is not a value — same fallback as effectiveTerms.ts");
  assert.equal(r.policyPinUnresolved, false, "the pin itself verified fine — only its maxRounds field was null");
});

console.log("\nfollow-up 2 — an unverified pin must be FLAGGED, never silently trusted for a terminal decision\n");

test("pin id set but the row is missing (undefined) → policyPinUnresolved true, maxRounds is the raw-config fallback", () => {
  const r = resolveMaxRounds({
    config: { maxRounds: 4 },
    negotiationPolicySnapshotId: "policy-deleted",
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: undefined,
  });
  assert.equal(r.maxRounds, 4, "the fallback number is still populated (non-terminal callers keep working)");
  assert.equal(r.policyPinUnresolved, true, "a missing pinned row must be flagged as unresolved");
});

test("cross-campaign pin → policyPinUnresolved true (an unverified snapshot must never inform a real decision)", () => {
  const r = resolveMaxRounds({
    config: { maxRounds: 4 },
    negotiationPolicySnapshotId: "policy-1",
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: { campaignId: "camp-OTHER", maxRounds: 1 },
  });
  assert.equal(r.maxRounds, 4);
  assert.equal(r.policyPinUnresolved, true);
});

test("unresolved expectedCampaignId (campaign load failure) → policyPinUnresolved true", () => {
  const r = resolveMaxRounds({
    config: { maxRounds: 4 },
    negotiationPolicySnapshotId: "policy-1",
    expectedCampaignId: undefined,
    pinnedPolicySnapshot: { campaignId: "camp-1", maxRounds: 1 },
  });
  assert.equal(r.maxRounds, 4);
  assert.equal(r.policyPinUnresolved, true);
});

test("consistency: the SAME resolved value would be produced whether read pre-build or via effectiveConfig post-build", () => {
  // Simulates both call sites reading the identical immutable snapshot row.
  const config = { maxRounds: 2 };
  const snapshotRow = { campaignId: "camp-1", maxRounds: 5 };
  const preBuild = resolveMaxRounds({
    config,
    negotiationPolicySnapshotId: "policy-1",
    expectedCampaignId: "camp-1",
    pinnedPolicySnapshot: snapshotRow,
  });
  // effectiveTerms.ts's own precedence for the SAME shape: finiteNumber(policyAuthority.maxRounds) wins.
  const effective = typeof snapshotRow.maxRounds === "number" ? snapshotRow.maxRounds : config.maxRounds;
  assert.equal(preBuild.maxRounds, effective, "pre-build and post-build (effectiveConfig) must agree on one value");
});
