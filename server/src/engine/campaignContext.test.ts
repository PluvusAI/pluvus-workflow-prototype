/**
 * Unit tests for the campaign → node-config brand-context fallback (H5).
 * Pure logic — run with:
 *   npx tsx src/engine/campaignContext.test.ts
 *
 * Regression target: imported/legacy workflows reached the LLM with brand
 * context missing from node config, so the agent signed as "Pluvus Partnerships"
 * with no scope even though the campaign row HAD the data. mergeCampaignFallback
 * fills ONLY the missing keys; node config always wins; a null campaign is a
 * no-op.
 */

import assert from "node:assert/strict";
import type { Campaign } from "../db/schema.js";
import { mergeCampaignFallback, resolveBrandName } from "./campaignContext.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const campaign = {
  id: "camp1",
  brand: "Acme Running",
  brandDescription: "Acme makes premium running shoes.",
  deliverables: "2 Instagram Reels",
  timeline: "live by Sept 15",
  rewardDescription: "a free pair of shoes",
  shipsPhysicalProduct: true,
} as unknown as Campaign;

console.log("\nmergeCampaignFallback (H5)\n");

test("fills missing brand fields from the campaign", () => {
  const merged = mergeCampaignFallback({ maxRounds: 5 }, campaign);
  assert.equal(merged["senderName"], "Acme Running");
  assert.equal(merged["brandName"], "Acme Running");
  assert.equal(merged["brandDescription"], "Acme makes premium running shoes.");
  assert.equal(merged["deliverables"], "2 Instagram Reels");
  assert.equal(merged["timeline"], "live by Sept 15");
  assert.equal(merged["rewardDescription"], "a free pair of shoes");
  assert.equal(merged["shipsPhysicalProduct"], true);
  // Non-brand config is preserved.
  assert.equal(merged["maxRounds"], 5);
});

test("node config always wins over the campaign", () => {
  const merged = mergeCampaignFallback(
    { senderName: "Custom Brand", brandDescription: "stamped description" },
    campaign,
  );
  assert.equal(merged["senderName"], "Custom Brand");
  assert.equal(merged["brandDescription"], "stamped description");
  // But a field the config lacks is still filled.
  assert.equal(merged["deliverables"], "2 Instagram Reels");
});

test("empty-string config value is treated as missing and gets filled", () => {
  const merged = mergeCampaignFallback({ brandDescription: "   " }, campaign);
  assert.equal(merged["brandDescription"], "Acme makes premium running shoes.");
});

test("null / undefined campaign is a no-op (returns a copy)", () => {
  const original = { maxRounds: 5, senderName: "X" };
  const mergedNull = mergeCampaignFallback(original, null);
  assert.deepEqual(mergedNull, original);
  assert.notEqual(mergedNull, original, "must be a copy, not the same object");
  assert.deepEqual(mergeCampaignFallback(original, undefined), original);
});

test("a campaign with blank optional fields does not overwrite with junk", () => {
  const sparse = { id: "c2", brand: "Bare Co", shipsPhysicalProduct: false } as unknown as Campaign;
  const merged = mergeCampaignFallback({ maxRounds: 3 }, sparse);
  assert.equal(merged["senderName"], "Bare Co");
  // No brandDescription on the campaign → key stays absent (not "undefined").
  assert.ok(!("brandDescription" in merged) || merged["brandDescription"] === undefined);
  assert.equal(merged["shipsPhysicalProduct"], false);
});

// ---------------------------------------------------------------------------
// L4 — resolveBrandName: config → campaign → undefined (caller fails loud).
// ---------------------------------------------------------------------------

test("resolveBrandName prefers config brandName", () => {
  assert.equal(resolveBrandName({ brandName: "Configured Co" }, campaign), "Configured Co");
});

test("resolveBrandName falls back to senderName then campaign.brand", () => {
  assert.equal(resolveBrandName({ senderName: "Sender Co" }, campaign), "Sender Co");
  assert.equal(resolveBrandName({}, campaign), "Acme Running");
});

test("resolveBrandName returns undefined when neither config nor campaign has one", () => {
  assert.equal(resolveBrandName({}, null), undefined);
  assert.equal(resolveBrandName({ brandName: "   " }, null), undefined);
  const blankBrand = { id: "c3", brand: "  " } as unknown as Campaign;
  assert.equal(resolveBrandName({}, blankBrand), undefined);
});

console.log(`\n${n} passed\n`);
