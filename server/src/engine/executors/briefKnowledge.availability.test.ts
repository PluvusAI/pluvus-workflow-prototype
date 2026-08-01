/**
 * PLU-82 §4.4 — deriveBriefAvailability truth-table tests.
 * Pure projection; run with:
 *   npx tsx src/engine/executors/briefKnowledge.availability.test.ts
 *
 * Locks the invariant #5 mapping (empty → PARSE_FAILED, not NO_BRIEF), the
 * expected-sections-drive-PARTIAL rule (expected = campaign's declared fields ∩
 * _CONFLICT_KEYS, NOT all keys — else every brief is PARTIAL forever), and that
 * the projection touches no cache/parser logic (it is a pure view).
 */

import assert from "node:assert/strict";
import {
  deriveBriefAvailability,
  type ResolvedBrief,
  type CampaignBriefSection,
} from "./briefKnowledge.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

function section(text: string): CampaignBriefSection {
  return { type: "x", text, sourceFileReference: "ref", parserVersion: "v1" };
}

console.log("\nderiveBriefAvailability — status mapping (invariant #5)\n");

test("no_brief → NO_BRIEF", () => {
  const r = deriveBriefAvailability({ flatText: "", status: "no_brief" }, []);
  assert.equal(r.status, "NO_BRIEF");
  assert.equal(r.error, undefined);
});

test("parse_failed → PARSE_FAILED with an error", () => {
  const r = deriveBriefAvailability({ flatText: "", status: "parse_failed" }, []);
  assert.equal(r.status, "PARSE_FAILED");
  assert.ok(r.error && r.error.length > 0);
});

test("empty → PARSE_FAILED (present-but-unreadable ≠ absent) — NOT NO_BRIEF", () => {
  const r = deriveBriefAvailability({ flatText: "", status: "empty" }, []);
  assert.equal(r.status, "PARSE_FAILED");
  assert.notEqual(r.status, "NO_BRIEF");
  assert.ok(r.error && /empty/i.test(r.error));
});

console.log("\nok status → AVAILABLE vs PARTIAL by EXPECTED-section presence\n");

test("ok + no expected sections → AVAILABLE (vacuously complete)", () => {
  const resolved: ResolvedBrief = { flatText: "brief text", status: "ok" };
  const r = deriveBriefAvailability(resolved, []);
  assert.equal(r.status, "AVAILABLE");
  assert.equal(r.text, "brief text");
});

test("ok + every expected section present → AVAILABLE", () => {
  const resolved: ResolvedBrief = {
    flatText: "full",
    status: "ok",
    sections: {
      usageRights: section("6 months usage"),
      paymentTerms: section("Net 30"),
    },
  };
  const r = deriveBriefAvailability(resolved, ["usageRights", "paymentTerms"]);
  assert.equal(r.status, "AVAILABLE");
  assert.equal(r.missingSections, undefined);
});

test("ok + one expected section absent → PARTIAL, listing the missing key", () => {
  const resolved: ResolvedBrief = {
    flatText: "partial",
    status: "ok",
    sections: { usageRights: section("6 months usage") },
  };
  const r = deriveBriefAvailability(resolved, ["usageRights", "exclusivity"]);
  assert.equal(r.status, "PARTIAL");
  assert.deepEqual(r.missingSections, ["exclusivity"]);
  assert.equal(r.text, "partial");
});

test("ok + an expected section present but with EMPTY text → PARTIAL (whitespace = absent)", () => {
  const resolved: ResolvedBrief = {
    flatText: "x",
    status: "ok",
    sections: { paymentTerms: section("   ") },
  };
  const r = deriveBriefAvailability(resolved, ["paymentTerms"]);
  assert.equal(r.status, "PARTIAL");
  assert.deepEqual(r.missingSections, ["paymentTerms"]);
});

test("a section the campaign does NOT expect never forces PARTIAL", () => {
  // Campaign only declares usageRights → exclusivity absence is irrelevant.
  const resolved: ResolvedBrief = {
    flatText: "x",
    status: "ok",
    sections: { usageRights: section("6mo") },
  };
  const r = deriveBriefAvailability(resolved, ["usageRights"]);
  assert.equal(r.status, "AVAILABLE");
});

console.log("\nfileReference + text threading (observability detail, not status-affecting)\n");

test("fileReference is threaded through when provided (and does not change status)", () => {
  const r = deriveBriefAvailability({ flatText: "", status: "no_brief" }, [], "upload-ref-123");
  assert.equal(r.status, "NO_BRIEF");
  assert.equal(r.fileReference, "upload-ref-123");
});

test("a blank fileReference is omitted", () => {
  const r = deriveBriefAvailability({ flatText: "x", status: "ok" }, [], "   ");
  assert.equal(r.fileReference, undefined);
});

test("AVAILABLE omits text when flatText is present but a section carries it", () => {
  // Usable content via a section (not flatText) → AVAILABLE, but text is omitted
  // because flatText itself is blank (no empty-string noise on the payload).
  const r = deriveBriefAvailability(
    { flatText: "   ", status: "ok", sections: { usageRights: section("6mo") } },
    [],
  );
  assert.equal(r.status, "AVAILABLE");
  assert.equal(r.text, undefined);
});

test("§4 (Calvin) — ok + blank flatText + NO usable sections → PARSE_FAILED, not AVAILABLE", () => {
  // normalizeStatus defaults a missing agent status to "ok"; a blank/malformed
  // response must NOT read as available knowledge.
  const r = deriveBriefAvailability({ flatText: "   ", status: "ok" }, []);
  assert.equal(r.status, "PARSE_FAILED");
  assert.notEqual(r.status, "AVAILABLE");
  assert.ok(r.error && /no usable content/i.test(r.error));
});

console.log("\npurity — the input ResolvedBrief is not mutated\n");

test("does not mutate the input (pure projection over a cached object)", () => {
  const resolved: ResolvedBrief = {
    flatText: "x",
    status: "ok",
    sections: { usageRights: section("6mo") },
  };
  const snapshot = JSON.stringify(resolved);
  deriveBriefAvailability(resolved, ["usageRights", "exclusivity"]);
  assert.equal(JSON.stringify(resolved), snapshot, "input must be unchanged");
});

console.log(`\n${n} passed\n`);
