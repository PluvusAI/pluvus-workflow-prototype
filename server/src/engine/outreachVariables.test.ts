/**
 * Unit tests for the shared outreach-variable module: template resolution,
 * unknown-token extraction, "did you mean" suggestions, and the mode-aware
 * config validator. Pure functions — no DB, no providers.
 *
 * Run with:  npx tsx src/engine/outreachVariables.test.ts
 */

import assert from "node:assert/strict";
import type { Creator } from "../db/schema.js";
import {
  resolveOutreachTemplate,
  extractUnknownTokens,
  suggestVariable,
  validateOutreachConfig,
  missingRequiredValues,
  unavailableUsedTokens,
  availableOutreachVariableNames,
  firstNameOf,
  OUTREACH_VARIABLE_NAMES,
  REQUIRED_OUTREACH_VARIABLE_NAMES,
} from "./outreachVariables.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

const creator = {
  name: "Casey",
  platform: "TikTok",
  niche: "beauty",
} as unknown as Creator;

console.log("\noutreach variables\n");

// Drift guard: pin the canonical variable set. The web mirror
// (web/src/workflow/outreachVariables.ts) asserts the SAME list. If you
// add/rename a variable, update both modules AND both expected sets.
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

test("allow-list matches the canonical variable set (web mirror contract)", () => {
  assert.deepEqual([...OUTREACH_VARIABLE_NAMES].sort(), EXPECTED_VARIABLE_NAMES);
});

test("required set is exactly creatorName + brandName (PLU-117 §3)", () => {
  assert.deepEqual([...REQUIRED_OUTREACH_VARIABLE_NAMES].sort(), ["brandName", "creatorName"]);
});

test("resolves creator + brand + campaign variables", () => {
  const out = resolveOutreachTemplate(
    "Hi {{creatorName}} on {{platform}} ({{niche}}), from {{senderName}} at {{brandName}}. {{deliverables}} / {{timeline}} / {{rewardDescription}}",
    creator,
    {
      senderName: "Acme Partnerships",
      brandName: "Acme",
      deliverables: "2 Reels",
      timeline: "by Sept 15",
      rewardDescription: "free shoes",
    },
  );
  assert.equal(
    out,
    "Hi Casey on TikTok (beauty), from Acme Partnerships at Acme. 2 Reels / by Sept 15 / free shoes",
  );
});

test("brandName and senderName cross-fill each other (same campaign brand)", () => {
  assert.equal(resolveOutreachTemplate("{{brandName}}", creator, { senderName: "Solo Co" }), "Solo Co");
  assert.equal(resolveOutreachTemplate("{{senderName}}", creator, { brandName: "Acme" }), "Acme");
});

test("brandName/senderName resolve EMPTY when unset — never the internal name", () => {
  // PLU-117: "Pluvus Partnerships" must NEVER leak into a brand's outreach.
  assert.equal(resolveOutreachTemplate("[{{senderName}}]", creator, {}), "[]");
  assert.equal(resolveOutreachTemplate("[{{brandName}}]", creator, {}), "[]");
});

test("empty campaign fields resolve to empty string", () => {
  const out = resolveOutreachTemplate("[{{rewardDescription}}]", creator, {});
  assert.equal(out, "[]");
});

test("platform/niche fall back when absent on the creator", () => {
  const bare = { name: "Sky" } as unknown as Creator;
  const out = resolveOutreachTemplate("{{platform}}/{{niche}}", bare, {});
  assert.equal(out, "social media/your niche");
});

test("unknown token is stripped to empty (send-time net)", () => {
  const out = resolveOutreachTemplate("Hi {{creatorName}}{{firstName}}!", creator, {});
  assert.equal(out, "Hi Casey!");
});

test("whitespace inside braces is tolerated", () => {
  const out = resolveOutreachTemplate("Hi {{ creatorName }}", creator, {});
  assert.equal(out, "Hi Casey");
});

test("extractUnknownTokens returns only non-allow-listed names", () => {
  assert.deepEqual(extractUnknownTokens("{{creatorName}} {{firstName}} {{lastName}}"), [
    "firstName",
    "lastName",
  ]);
  assert.deepEqual(extractUnknownTokens("{{creatorName}} {{brandName}}"), []);
});

test("suggestVariable finds a spelling-close match", () => {
  assert.equal(suggestVariable("creatorname"), "creatorName"); // case-only diff
  assert.equal(suggestVariable("creatorNam"), "creatorName"); // one-char typo
  assert.equal(suggestVariable("branName"), "brandName"); // one-char deletion
  // A semantically-close but spelling-distant typo has no near match: the error
  // still rejects it, just without a suggestion.
  assert.equal(suggestVariable("firstName"), undefined);
  assert.equal(suggestVariable("zzzzzzzzzzz"), undefined);
});

test("every allow-listed name resolves to a non-token output", () => {
  for (const name of OUTREACH_VARIABLE_NAMES) {
    const out = resolveOutreachTemplate(`{{${name}}}`, creator, { brandName: "B", senderName: "S" });
    assert.ok(!out.includes("{{"), `${name} left an unresolved token`);
  }
});

// --- new PLU-117 placeholders (§2) ---

test("creatorFirstName resolves to the first word of the name", () => {
  const out = resolveOutreachTemplate("Hi {{creatorFirstName}}", creator, {});
  assert.equal(out, "Hi Casey");
  const multi = { name: "Maya Chen Rivera" } as unknown as Creator;
  assert.equal(resolveOutreachTemplate("{{creatorFirstName}}", multi, {}), "Maya");
});

test("firstNameOf handles blank / whitespace names", () => {
  assert.equal(firstNameOf("  "), "");
  assert.equal(firstNameOf(null), "");
  assert.equal(firstNameOf(undefined), "");
  assert.equal(firstNameOf("Solo"), "Solo");
});

test("campaignName / offerSummary resolve from config", () => {
  const out = resolveOutreachTemplate(
    "{{campaignName}} — {{offerSummary}}",
    creator,
    { campaignName: "Spring Launch", offerSummary: "a fixed-fee collaboration" },
  );
  assert.equal(out, "Spring Launch — a fixed-fee collaboration");
});

test("collaborationType falls back to 'partnership' when unset", () => {
  assert.equal(resolveOutreachTemplate("{{collaborationType}}", creator, {}), "partnership");
  assert.equal(
    resolveOutreachTemplate("{{collaborationType}}", creator, { collaborationType: "hybrid partnership" }),
    "hybrid partnership",
  );
});

test("campaignName / offerSummary resolve to empty when unset (no invented value)", () => {
  assert.equal(resolveOutreachTemplate("[{{campaignName}}][{{offerSummary}}]", creator, {}), "[][]");
});

// --- required-value handling (§3 / AC10) ---

test("missingRequiredValues: clean when required vars have values", () => {
  const missing = missingRequiredValues(
    "Hi from {{brandName}}",
    "Hi {{creatorName}}",
    creator,
    { brandName: "Acme", senderName: "Acme Partnerships" },
  );
  assert.deepEqual(missing, []);
});

test("missingRequiredValues: flags a required var with no value", () => {
  const blank = { name: "", platform: "TikTok", niche: "beauty" } as unknown as Creator;
  const missing = missingRequiredValues("Hi {{creatorName}}", "body", blank, {});
  assert.deepEqual(missing, ["creatorName"]);
});

test("missingRequiredValues: required brandName flags when the campaign brand is missing", () => {
  // PLU-117: brandName no longer falls back to an internal name — an empty brand
  // now correctly BLOCKS the send (rather than mailing "Pluvus Partnerships").
  // campaign.brand is NOT NULL in practice, so this only fires for a mis-stamped
  // instance, which is exactly what should route to MANUAL_REVIEW.
  assert.deepEqual(missingRequiredValues("s", "from {{brandName}}", creator, {}), ["brandName"]);
  // With a real brand (or a senderName it cross-fills from) it's satisfied.
  assert.deepEqual(missingRequiredValues("s", "from {{brandName}}", creator, { brandName: "Acme" }), []);
  assert.deepEqual(missingRequiredValues("s", "from {{brandName}}", creator, { senderName: "Acme" }), []);
});

test("missingRequiredValues: optional vars never block (empty is fine)", () => {
  const missing = missingRequiredValues(
    "s",
    "{{platform}} {{campaignName}} {{offerSummary}}",
    creator,
    {},
  );
  assert.deepEqual(missing, []);
});

// --- availability (PLU-117: only offer placeholders with a real value) ---

test("availableOutreachVariableNames: always-vars present with empty config", () => {
  const names = availableOutreachVariableNames({});
  // Creator vars + collaborationType always resolve (they carry fallbacks).
  for (const n of ["creatorFirstName", "creatorName", "platform", "niche", "collaborationType"]) {
    assert.ok(names.has(n), `${n} should always be available`);
  }
  // Config-sourced vars with no value are NOT available — INCLUDING brandName /
  // senderName now (they come from the campaign brand, never an internal name).
  for (const n of ["brandName", "senderName", "brandDescription", "campaignName", "offerSummary", "rewardDescription", "deliverables", "timeline"]) {
    assert.ok(!names.has(n), `${n} should be unavailable with empty config`);
  }
});

test("availableOutreachVariableNames: brandName/senderName appear once the brand is set", () => {
  const names = availableOutreachVariableNames({ brandName: "Acme", senderName: "Acme" });
  assert.ok(names.has("brandName") && names.has("senderName"));
});

test("availableOutreachVariableNames: config vars appear only when set", () => {
  const names = availableOutreachVariableNames({
    campaignName: "Spring Launch",
    deliverables: "2 Reels",
    // offerSummary intentionally blank/whitespace → still unavailable
    offerSummary: "   ",
  });
  assert.ok(names.has("campaignName"));
  assert.ok(names.has("deliverables"));
  assert.ok(!names.has("offerSummary"), "whitespace-only value is not available");
  assert.ok(!names.has("timeline"));
});

test("unavailableUsedTokens: flags a used placeholder with no campaign value", () => {
  // Template uses {{campaignName}} + {{offerSummary}} but config has neither
  // (brandName IS present here so it is not flagged).
  const flagged = unavailableUsedTokens(
    "About {{campaignName}}",
    "The offer is {{offerSummary}}. From {{brandName}}.",
    { brandName: "Acme" },
  );
  assert.deepEqual(flagged.sort(), ["campaignName", "offerSummary"]);
});

test("unavailableUsedTokens: does not flag available or unknown tokens", () => {
  // {{brandName}} present; {{deliverables}} present; {{bogus}} is unknown
  // (handled by extractUnknownTokens, not here).
  const flagged = unavailableUsedTokens(
    "{{brandName}} {{bogus}}",
    "{{deliverables}}",
    { brandName: "Acme", deliverables: "2 Reels" },
  );
  assert.deepEqual(flagged, []);
});

// --- validation ---

test("manual mode requires subject", () => {
  const issue = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "", bodyTemplate: "hi" });
  assert.equal(issue?.code, "MISSING_SUBJECT");
});

test("manual mode requires body", () => {
  const issue = validateOutreachConfig({ outreachMode: "manual", subjectTemplate: "s", bodyTemplate: "  " });
  assert.equal(issue?.code, "MISSING_BODY");
});

test("manual mode with valid copy passes", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "Hi from {{brandName}}",
    bodyTemplate: "Hi {{creatorName}}",
  });
  assert.equal(issue, null);
});

test("unknown variable is rejected with a suggestion (spelling-close typo)", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "s",
    bodyTemplate: "Hi {{creatorNam}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
  assert.match(issue!.message, /did you mean \{\{creatorName\}\}/);
});

test("unknown variable with no near match is still rejected (no suggestion)", () => {
  const issue = validateOutreachConfig({
    outreachMode: "manual",
    subjectTemplate: "s",
    bodyTemplate: "Hi {{firstName}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
  assert.match(issue!.message, /not a known variable/);
});

test("ai/absent mode does not require subject/body", () => {
  assert.equal(validateOutreachConfig({ outreachMode: "ai", subjectTemplate: "", bodyTemplate: "" }), null);
  assert.equal(validateOutreachConfig({ subjectTemplate: "", bodyTemplate: "" }), null);
});

test("ai mode still rejects an unknown variable in the fallback", () => {
  const issue = validateOutreachConfig({
    outreachMode: "ai",
    subjectTemplate: "s",
    bodyTemplate: "{{bogusVar}}",
  });
  assert.equal(issue?.code, "UNKNOWN_VARIABLE");
});

console.log(`\n✓ outreachVariables: all ${n} tests passed\n`);
