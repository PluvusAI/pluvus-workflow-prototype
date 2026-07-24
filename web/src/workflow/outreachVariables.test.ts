/**
 * Unit tests for the WEB mirror of the outreach-variable module: the live
 * preview renderer, unknown-token extraction, and the mode-aware validator.
 * Must stay behaviorally identical to the server module.
 *
 * Run with:  npx tsx src/workflow/outreachVariables.test.ts
 */

import assert from "node:assert/strict";
import {
  renderOutreachPreview,
  extractUnknownTokens,
  validateOutreachConfig,
  firstNameOf,
  availableOutreachVariableNames,
  unavailableUsedTokens,
  PREVIEW_SAMPLE,
  OUTREACH_VARIABLE_NAMES,
  REQUIRED_OUTREACH_VARIABLE_NAMES,
} from "./outreachVariables";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("\noutreach variables (web mirror)\n");

// Drift guard: the web allow-list MUST match the server allow-list
// (server/src/engine/outreachVariables.ts). The two modules can't cross-import,
// so this frozen list is the contract. If you add/rename a variable, update BOTH
// modules AND this expected set — otherwise the palette resolves a variable the
// server would strip, or vice versa.
const EXPECTED_VARIABLE_NAMES = [
  "creatorFirstName",
  "creatorName",
  "platform",
  "niche",
  "brandName",
  "senderName",
  "brandDescription",
  "campaignName",
  "collaborationType",
  "offerSummary",
  "rewardDescription",
  "deliverables",
  "timeline",
].sort();

test("web allow-list matches the canonical variable set (server mirror contract)", () => {
  assert.deepEqual([...OUTREACH_VARIABLE_NAMES].sort(), EXPECTED_VARIABLE_NAMES);
});

test("web required set matches server (creatorName + brandName)", () => {
  assert.deepEqual([...REQUIRED_OUTREACH_VARIABLE_NAMES].sort(), ["brandName", "creatorName"]);
});

test("preview resolves the new placeholders (first name, campaign, deal shape)", () => {
  const out = renderOutreachPreview(
    "{{creatorFirstName}} / {{campaignName}} / {{collaborationType}} / {{offerSummary}}",
    { campaignName: "Spring Launch", collaborationType: "hybrid partnership", offerSummary: "a hybrid partnership" },
  );
  assert.equal(
    out,
    `${firstNameOf(PREVIEW_SAMPLE.creatorName)} / Spring Launch / hybrid partnership / a hybrid partnership`,
  );
});

test("preview collaborationType falls back to 'partnership'", () => {
  assert.equal(renderOutreachPreview("{{collaborationType}}", {}), "partnership");
});

test("availability: always-vars in, config-vars out with empty config (web mirror)", () => {
  const names = availableOutreachVariableNames({});
  assert.ok(names.has("creatorFirstName") && names.has("collaborationType"));
  // brandName/senderName are now config-sourced (campaign brand) — not offered blank.
  assert.ok(!names.has("brandName") && !names.has("senderName"));
  assert.ok(!names.has("campaignName") && !names.has("offerSummary") && !names.has("deliverables"));
});

test("availability: config var appears once its value is set (web mirror)", () => {
  const names = availableOutreachVariableNames({ campaignName: "Spring Launch" });
  assert.ok(names.has("campaignName"));
  assert.ok(!names.has("timeline"));
});

test("unavailableUsedTokens flags a blank-rendering placeholder (web mirror)", () => {
  // With a brand present, only the truly-absent {{campaignName}} is flagged.
  assert.deepEqual(unavailableUsedTokens("{{campaignName}}", "from {{brandName}}", { brandName: "Acme" }), ["campaignName"]);
  assert.deepEqual(unavailableUsedTokens("{{campaignName}}", "", { campaignName: "X" }), []);
});

test("preview resolves sample creator + config brand/campaign values", () => {
  const out = renderOutreachPreview(
    "Hi {{creatorName}} on {{platform}}, from {{brandName}}. {{rewardDescription}}",
    { brandName: "Acme", senderName: "Acme", rewardDescription: "free shoes" },
  );
  assert.equal(out, `Hi ${PREVIEW_SAMPLE.creatorName} on ${PREVIEW_SAMPLE.platform}, from Acme. free shoes`);
});

test("preview strips unknown tokens", () => {
  const out = renderOutreachPreview("Hi {{creatorName}}{{firstName}}", {});
  assert.equal(out, `Hi ${PREVIEW_SAMPLE.creatorName}`);
});

test("preview: brandName/senderName cross-fill; NEVER the internal name", () => {
  // PLU-117: "Pluvus Partnerships" must never appear — unset resolves to "".
  assert.equal(renderOutreachPreview("[{{senderName}}]", {}), "[]");
  assert.equal(renderOutreachPreview("{{brandName}}", { senderName: "Solo" }), "Solo");
  assert.equal(renderOutreachPreview("{{senderName}}", { brandName: "Acme" }), "Acme");
});

test("extractUnknownTokens flags typos", () => {
  assert.deepEqual(extractUnknownTokens("{{creatorName}} {{firstName}}"), ["firstName"]);
});

test("manual mode requires subject then body; reports the field", () => {
  const s = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "", bodyTemplate: "hi" });
  assert.equal(s?.code, "MISSING_SUBJECT");
  assert.equal(s?.field, "subject");
  const b = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "s", bodyTemplate: "" });
  assert.equal(b?.code, "MISSING_BODY");
  assert.equal(b?.field, "body");
});

test("unknown variable rejected with field placement", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "Hi {{bogus}}",
    bodyTemplate: "Hi {{creatorName}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
  assert.equal(issue?.field, "subject");
});

test("ai/absent mode is lenient on empty copy", () => {
  assert.equal(validateOutreachConfig({ outreachMode: "ai", subjectTemplate: "", bodyTemplate: "" }), null);
  assert.equal(validateOutreachConfig({ subjectTemplate: "", bodyTemplate: "" }), null);
});

console.log(`\n✓ outreachVariables (web): all ${passed} tests passed\n`);
