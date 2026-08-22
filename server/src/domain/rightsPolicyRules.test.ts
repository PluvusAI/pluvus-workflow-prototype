/**
 * PLU-172 — unit tests for the rights-family private-policy storage shape.
 * Pure logic — no DB. Run with:
 *   npx tsx --test src/domain/rightsPolicyRules.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  RIGHTS_TERMS,
  rightsPolicyRuleSchema,
  validateRightsPolicyRules,
  resolveRightsMode,
  SCRIPT_WAIVER_MODES,
  isScriptWaiverMode,
} from "./rightsPolicyRules.js";

test("RIGHTS_TERMS is exactly the five DURATION-bearing worksheet terms, no more (the ticket forbids adding territory/channel/etc.; script submission has its own shape — see below)", () => {
  assert.deepEqual([...RIGHTS_TERMS].sort(), [
    "adAuthorization",
    "contentRepurposeRights",
    "exclusivity",
    "postRetention",
    "usageRights",
  ]);
});

test("scriptSubmission is NOT one of the duration-bearing RIGHTS_TERMS (Calvin review: ALLOW_TO_MINIMUM doesn't apply to it)", () => {
  assert.ok(!(RIGHTS_TERMS as readonly string[]).includes("scriptSubmission"));
});

test("a KEEP_REQUESTED rule with no minimum is valid", () => {
  const r = rightsPolicyRuleSchema.safeParse({ term: "usageRights", mode: "KEEP_REQUESTED" });
  assert.equal(r.success, true);
});

test("ALLOW_TO_MINIMUM without minimumValue is rejected", () => {
  const r = rightsPolicyRuleSchema.safeParse({ term: "exclusivity", mode: "ALLOW_TO_MINIMUM" });
  assert.equal(r.success, false);
});

test("BUG (fixed): ALLOW_TO_MINIMUM with minimumValue but NO minimumUnit is rejected — 30 what?", () => {
  const r = rightsPolicyRuleSchema.safeParse({ term: "exclusivity", mode: "ALLOW_TO_MINIMUM", minimumValue: 30 });
  assert.equal(r.success, false, "a bare number with no unit is semantically incomplete and must not validate");
});

test("ALLOW_TO_MINIMUM with minimumUnit but NO minimumValue is also rejected", () => {
  const r = rightsPolicyRuleSchema.safeParse({ term: "exclusivity", mode: "ALLOW_TO_MINIMUM", minimumUnit: "DAYS" });
  assert.equal(r.success, false);
});

test("ALLOW_TO_MINIMUM with minimumValue + minimumUnit is valid", () => {
  const r = rightsPolicyRuleSchema.safeParse({
    term: "exclusivity",
    mode: "ALLOW_TO_MINIMUM",
    minimumValue: 30,
    minimumUnit: "DAYS",
  });
  assert.equal(r.success, true);
});

test("an unknown term is rejected", () => {
  const r = rightsPolicyRuleSchema.safeParse({ term: "territory", mode: "KEEP_REQUESTED" });
  assert.equal(r.success, false);
});

test("an unrecognized extra field is rejected (.strict())", () => {
  const r = rightsPolicyRuleSchema.safeParse({ term: "usageRights", mode: "KEEP_REQUESTED", channel: "tv" });
  assert.equal(r.success, false);
});

test("validateRightsPolicyRules: a duplicate term in the array is rejected", () => {
  const r = validateRightsPolicyRules([
    { term: "usageRights", mode: "KEEP_REQUESTED" },
    { term: "usageRights", mode: "ALLOW_TO_MINIMUM", minimumValue: 10, minimumUnit: "DAYS" },
  ]);
  assert.equal(r.ok, false);
});

test("validateRightsPolicyRules: distinct terms are accepted together", () => {
  const r = validateRightsPolicyRules([
    { term: "usageRights", mode: "KEEP_REQUESTED" },
    { term: "exclusivity", mode: "ALLOW_TO_MINIMUM", minimumValue: 0, minimumUnit: "COUNT" },
  ]);
  assert.equal(r.ok, true);
});

test("scriptSubmission is rejected as a rightsPolicyRules term (it has its own column now, not a rule entry)", () => {
  const r = rightsPolicyRuleSchema.safeParse({ term: "scriptSubmission", mode: "KEEP_REQUESTED" });
  assert.equal(r.success, false);
});

test("an empty array is valid (no terms opened up — everything stays conservative)", () => {
  const r = validateRightsPolicyRules([]);
  assert.equal(r.ok, true);
});

console.log("\nresolveRightsMode — the conservative-absence rule (PLU-172 review item 7)\n");

test("a term with NO entry resolves to KEEP_REQUESTED, never 'unrestricted'", () => {
  assert.equal(resolveRightsMode([], "usageRights"), "KEEP_REQUESTED");
  assert.equal(
    resolveRightsMode([{ term: "exclusivity", mode: "ALLOW_TO_MINIMUM" }], "usageRights"),
    "KEEP_REQUESTED",
    "a rule for a DIFFERENT term must not leak into this term's resolution",
  );
});

test("a term WITH an entry resolves to that entry's mode", () => {
  assert.equal(
    resolveRightsMode([{ term: "usageRights", mode: "ASK_FOR_APPROVAL" }], "usageRights"),
    "ASK_FOR_APPROVAL",
  );
});

console.log("\nScriptWaiverMode — S8.C5's own dedicated (non-duration) shape\n");

test("SCRIPT_WAIVER_MODES has no ALLOW_TO_MINIMUM — that concept doesn't apply to a boolean-ish waiver", () => {
  assert.deepEqual([...SCRIPT_WAIVER_MODES], ["KEEP_SUBMISSION_REQUIRED", "ALLOW_WAIVER", "ASK_FOR_APPROVAL"]);
  assert.ok(!(SCRIPT_WAIVER_MODES as readonly string[]).includes("ALLOW_TO_MINIMUM"));
});

test("isScriptWaiverMode accepts every declared value and rejects an unrelated one", () => {
  for (const mode of SCRIPT_WAIVER_MODES) assert.equal(isScriptWaiverMode(mode), true);
  assert.equal(isScriptWaiverMode("ALLOW_TO_MINIMUM"), false);
  assert.equal(isScriptWaiverMode("keep_submission_required"), false);
  assert.equal(isScriptWaiverMode(null), false);
});
