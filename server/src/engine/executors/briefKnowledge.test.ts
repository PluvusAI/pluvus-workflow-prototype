// PLU-107: unit tests for the structured brief resolver's pure logic — conflict
// detection (§4.5), the /parse-brief wire→section-map projection (§5), and status
// normalization (invariant #2). The PDF→text→section pipeline itself is covered on
// the agent side (test_brief_structured.py); here we cover the TS mapping + the
// conservative conflict heuristics that gate what reaches PLU-82.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectBriefConflicts,
  projectSections,
  normalizeStatus,
  type CampaignBriefSection,
} from "./briefKnowledge.js";

const PV = "brief-parser-v1.0";

function section(type: string, text: string, pageStart?: number): CampaignBriefSection {
  return {
    type,
    text,
    sourceFileReference: "ref-1",
    parserVersion: PV,
    ...(pageStart !== undefined ? { pageStart } : {}),
  };
}

// ---------------------------------------------------------------------------
// Conflict detection (§4.5) — material only, conservative.
// ---------------------------------------------------------------------------
test("flags a material net-days payment conflict (Net 60 vs Net 30)", () => {
  const conflicts = detectBriefConflicts(
    { paymentTerms: section("paymentTerms", "Payment is Net 60 after the content goes live.", 3) },
    { paymentTerms: "Net 30" },
  );
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.section, "paymentTerms");
  assert.match(conflicts[0]!.reason, /30 vs 60/);
  assert.equal(conflicts[0]!.pageStart, 3);
});

test("does NOT flag when the brief merely elaborates the Campaign field", () => {
  // Same Net 30, brief just adds detail → evidence, not conflict (invariant #5).
  const conflicts = detectBriefConflicts(
    {
      paymentTerms: section(
        "paymentTerms",
        "Payment is Net 30, processed via PayPal once the invoice is approved.",
      ),
    },
    { paymentTerms: "Net 30" },
  );
  assert.equal(conflicts.length, 0);
});

test("flags a usage-rights duration mismatch (90 vs 60 days)", () => {
  const conflicts = detectBriefConflicts(
    { usageRights: section("usageRights", "The brand may reshare for 90 days.") },
    { usageRights: "60-day paid social usage" },
  );
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0]!.reason, /60 vs 90 days/);
});

test("flags an exclusivity stance mismatch (non-exclusive vs exclusive)", () => {
  const conflicts = detectBriefConflicts(
    { exclusivity: section("exclusivity", "This is an exclusive partnership for the category.") },
    { exclusivity: "non-exclusive" },
  );
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0]!.reason, /exclusivity stance mismatch/);
});

test("no conflict when a Campaign field is absent (nothing authoritative to compare)", () => {
  const conflicts = detectBriefConflicts(
    { paymentTerms: section("paymentTerms", "Net 60.") },
    {}, // no campaign paymentTerms → skip
  );
  assert.equal(conflicts.length, 0);
});

test("no conflict when only the Campaign field exists (no brief section)", () => {
  const conflicts = detectBriefConflicts({}, { paymentTerms: "Net 30" });
  assert.equal(conflicts.length, 0);
});

// ---------------------------------------------------------------------------
// Wire → section-map projection (§5) — stamps the real ref, drops junk.
// ---------------------------------------------------------------------------
test("projectSections stamps the real file ref and keeps provenance", () => {
  const out = projectSections(
    {
      usageRights: { type: "usageRights", text: "reshare 90 days", pageStart: 2, extractionConfidence: 0.9 },
    },
    "real-ref-xyz",
    PV,
  );
  assert.ok(out);
  const ur = out!["usageRights"]!;
  assert.equal(ur.sourceFileReference, "real-ref-xyz"); // ref overwritten with the real one
  assert.equal(ur.parserVersion, PV);
  assert.equal(ur.pageStart, 2);
  assert.equal(ur.extractionConfidence, 0.9);
});

test("projectSections drops list-valued keys (faq/other) and empty text", () => {
  const out = projectSections(
    {
      faq: [{ type: "faq", text: "Q&A" }], // list-valued → skipped from the map
      usageRights: { type: "usageRights", text: "   " }, // empty → skipped
      paymentTerms: { type: "paymentTerms", text: "Net 30" }, // kept
    },
    "ref",
    PV,
  );
  assert.ok(out);
  assert.ok(!("faq" in out!));
  assert.ok(!("usageRights" in out!));
  assert.ok("paymentTerms" in out!);
});

test("projectSections returns undefined for empty / non-object input", () => {
  assert.equal(projectSections(null, "ref", PV), undefined);
  assert.equal(projectSections({}, "ref", PV), undefined);
});

// ---------------------------------------------------------------------------
// Status normalization (invariant #2).
// ---------------------------------------------------------------------------
test("normalizeStatus preserves empty/parse_failed and defaults the rest to ok", () => {
  assert.equal(normalizeStatus("empty"), "empty");
  assert.equal(normalizeStatus("parse_failed"), "parse_failed");
  assert.equal(normalizeStatus("ok"), "ok");
  assert.equal(normalizeStatus(undefined), "ok"); // old agent with no status field
  assert.equal(normalizeStatus("weird"), "ok");
});
