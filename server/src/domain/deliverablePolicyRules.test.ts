/**
 * PLU-172 — unit tests for the S8.C1 deliverable-negotiation storage shape.
 * Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/deliverablePolicyRules.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { validateDeliverablePolicyRules } from "./deliverablePolicyRules.js";

test("appliesTo: 'any' with a quantity floor is valid", () => {
  const r = validateDeliverablePolicyRules([{ appliesTo: "any", allowQuantityDecreaseTo: 1 }]);
  assert.equal(r.ok, true);
});

test("appliesTo: a specific deliverable id is valid", () => {
  const r = validateDeliverablePolicyRules([{ appliesTo: "del_1", allowQuantityDecreaseTo: 2 }]);
  assert.equal(r.ok, true);
});

test("an empty object (no permissions at all) is valid — a rule that authorizes nothing", () => {
  const r = validateDeliverablePolicyRules([{ appliesTo: "any" }]);
  assert.equal(r.ok, true);
});

test("allowFormatChangeTo with a valid platform/format combination is accepted", () => {
  const r = validateDeliverablePolicyRules([
    { appliesTo: "any", allowFormatChangeTo: [{ platform: "instagram", format: "story" }] },
  ]);
  assert.equal(r.ok, true);
});

test("allowFormatChangeTo with an INVALID platform/format combination is rejected (reuses PLATFORM_FORMAT_MATRIX)", () => {
  const r = validateDeliverablePolicyRules([
    { appliesTo: "any", allowFormatChangeTo: [{ platform: "tiktok", format: "reel" }] },
  ]);
  assert.equal(r.ok, false);
});

test("allowQuantityDecreaseTo of 0 is rejected (must be a positive integer)", () => {
  const r = validateDeliverablePolicyRules([{ appliesTo: "any", allowQuantityDecreaseTo: 0 }]);
  assert.equal(r.ok, false);
});

test("an unrecognized extra field is rejected (.strict())", () => {
  const r = validateDeliverablePolicyRules([{ appliesTo: "any", somethingElse: true }]);
  assert.equal(r.ok, false);
});

test("an empty array is valid — no permissions authorized (fails closed)", () => {
  const r = validateDeliverablePolicyRules([]);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.rules.length, 0);
});
