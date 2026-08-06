/**
 * Template invariants for the negotiation compensation shape.
 *
 * Two kinds of template now exist:
 *   * FEE-BEARING templates (hybrid, fixed_fee) carry a POSITIVE fee band
 *     (maxBudget > 0). Founder #2: they open at the FLOOR (preferred budget) and
 *     concede up — recommendedOfferPosition is 0.0. Opening at the floor is only
 *     safe because a fee-bearing template keeps minBudget > 0 (HARD-N3: a zero
 *     floor plus open-at-floor once produced a $0 opening offer for a bare
 *     "I'm interested" reply). These tests lock BOTH halves of that contract.
 *   * COMMISSION-ONLY templates (affiliate, PLU-129) carry NO fee band
 *     (minBudget:0, maxBudget:0) plus a positive commission. There is no fixed
 *     fee to open, so the fee-band invariants above don't apply — they are
 *     scoped to maxBudget > 0. The affiliate shape gets its own assertion.
 *
 * Run with:  npx tsx --test src/templates/templates.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_TEMPLATES } from "./index.js";
import { resolveBand } from "../engine/band.js";

const negotiationConfigs = Object.values(WORKFLOW_TEMPLATES).map((tpl) => {
  const node = tpl.nodes.find((n) => n.type === "NEGOTIATION");
  assert.ok(node, `template ${tpl.key} must have a NEGOTIATION node`);
  return { key: tpl.key, config: node.config as Record<string, unknown> };
});

// A template is "fee-bearing" when it configures a positive fee band. The
// open-at-floor invariants below only make sense for these; commission-only
// templates (affiliate) have no fee band and are asserted separately.
const feeBearingConfigs = negotiationConfigs.filter(
  ({ config }) => typeof config["maxBudget"] === "number" && (config["maxBudget"] as number) > 0,
);

test("every fee-bearing template opens at the floor (recommendedOfferPosition 0.0)", () => {
  assert.ok(feeBearingConfigs.length > 0, "expected at least one fee-bearing template");
  for (const { key, config } of feeBearingConfigs) {
    assert.equal(
      config["recommendedOfferPosition"],
      0.0,
      `${key}: V1 #2 — open at the floor, concede up`,
    );
  }
});

test("every fee-bearing template keeps minBudget > 0 (HARD-N3 $0-offer guard)", () => {
  for (const { key, config } of feeBearingConfigs) {
    const floor = config["minBudget"];
    assert.equal(typeof floor, "number", `${key}: minBudget must be a number`);
    assert.ok(
      (floor as number) > 0,
      `${key}: minBudget must be > 0 — open-at-floor with a $0 floor recreates the $0-offer bug`,
    );
  }
});

test("bare 'I'm interested' opening offer is the floor, never $0 (fee-bearing)", () => {
  // Mirror the agent's recommended-offer math (negotiate.py):
  //   recommended = floor + (ceiling - floor) * position
  // With position 0.0 that is exactly the floor, which must be positive.
  for (const { key, config } of feeBearingConfigs) {
    const band = resolveBand(config);
    assert.ok(band.floor !== undefined, `${key}: band floor must resolve`);
    assert.ok(band.ceiling !== undefined, `${key}: band ceiling must resolve`);

    const position = config["recommendedOfferPosition"] as number;
    const opening = band.floor! + (band.ceiling! - band.floor!) * position;
    assert.equal(opening, band.floor, `${key}: opening offer must be the floor`);
    assert.ok(opening > 0, `${key}: opening offer must never be $0`);
  }
});

// -- PLU-129: per-template compensation shape (AC #6/#7/#8) -------------------

function negConfig(key: keyof typeof WORKFLOW_TEMPLATES): Record<string, unknown> {
  const found = negotiationConfigs.find((c) => c.key === key);
  assert.ok(found, `template ${key} must exist`);
  return found.config;
}

test("PLU-129: affiliate template is commission-only (fixed fee OFF): 0/0 + commission", () => {
  const config = negConfig("affiliate");
  assert.equal(config["minBudget"], 0, "affiliate: no fee band (minBudget 0)");
  assert.equal(config["maxBudget"], 0, "affiliate: no fee band (maxBudget 0)");
  assert.equal(config["commissionRate"], 15, "affiliate: positive commission carries the deal");
  // The fee-band-only knobs are dropped on a no-fee node (they're inert at 0/0).
  assert.equal(
    config["recommendedOfferPosition"],
    undefined,
    "affiliate: no recommendedOfferPosition on a no-fee node",
  );
  assert.equal(
    config["overCeilingTolerance"],
    undefined,
    "affiliate: no overCeilingTolerance on a no-fee node",
  );
  // The band resolves to a zero-width fee band — nothing to negotiate.
  const band = resolveBand(config);
  assert.equal(band.floor, 0, "affiliate: floor 0");
  assert.equal(band.ceiling, 0, "affiliate: ceiling 0 (no fee to negotiate)");
});

test("PLU-129: hybrid template is fixed fee ON + commission ON", () => {
  const config = negConfig("hybrid");
  assert.ok(
    typeof config["maxBudget"] === "number" && (config["maxBudget"] as number) > 0,
    "hybrid: positive fee band",
  );
  assert.ok(
    typeof config["minBudget"] === "number" && (config["minBudget"] as number) > 0,
    "hybrid: positive floor",
  );
  assert.ok(
    typeof config["commissionRate"] === "number" && (config["commissionRate"] as number) > 0,
    "hybrid: commission on",
  );
});

test("PLU-129: fixed_fee template is fixed fee ON + commission ABSENT", () => {
  const config = negConfig("fixed_fee");
  assert.ok(
    typeof config["maxBudget"] === "number" && (config["maxBudget"] as number) > 0,
    "fixed_fee: positive fee band",
  );
  assert.ok(
    typeof config["minBudget"] === "number" && (config["minBudget"] as number) > 0,
    "fixed_fee: positive floor",
  );
  const commission = config["commissionRate"];
  assert.ok(
    commission === undefined || commission === 0,
    "fixed_fee: no commission component",
  );
});
