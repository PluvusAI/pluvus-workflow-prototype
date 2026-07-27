/**
 * PLU-114 Calvin follow-up W1 — the four authoritative flat knowledge fields must
 * reach the negotiate router via campaignContext (parity with /draft).
 *
 * Pure test over `projectFlatKnowledge` (the projection spread into the negotiate
 * knowledgeContext) — no DB, no network. Run with:
 *   npx tsx --test src/engine/executors/flatKnowledge.test.ts
 */

import assert from "node:assert/strict";
import { projectFlatKnowledge, FLAT_KNOWLEDGE_KEYS } from "./negotiation.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nPLU-114 W1 projectFlatKnowledge\n");

test("projects all four configured flat knowledge fields", () => {
  const config = {
    usageRights: "30-day reshare on paid + organic.",
    exclusivity: "No category exclusivity.",
    paymentTerms: "Net-30 after content goes live.",
    attributionWindow: "30-day attribution window.",
    // unrelated keys are ignored
    maxRounds: 3,
    senderName: "Pluvus",
  } as Record<string, unknown>;
  const out = projectFlatKnowledge(config);
  assert.deepEqual(
    out,
    {
      usageRights: "30-day reshare on paid + organic.",
      exclusivity: "No category exclusivity.",
      paymentTerms: "Net-30 after content goes live.",
      attributionWindow: "30-day attribution window.",
    },
  );
});

test("omits empty / whitespace-only / non-string fields", () => {
  const config = {
    usageRights: "  Reshare 90 days.  ", // trimmed
    exclusivity: "   ", // whitespace-only → omitted
    paymentTerms: "", // empty → omitted
    attributionWindow: 30, // non-string → omitted
  } as Record<string, unknown>;
  const out = projectFlatKnowledge(config);
  assert.deepEqual(out, { usageRights: "Reshare 90 days." });
});

test("no flat fields → empty object (spread is a no-op)", () => {
  assert.deepEqual(projectFlatKnowledge({}), {});
});

test("only the four knowledge keys are ever projected", () => {
  assert.deepEqual([...FLAT_KNOWLEDGE_KEYS], [
    "usageRights",
    "exclusivity",
    "paymentTerms",
    "attributionWindow",
  ]);
  // deliverables/timeline are NOT flat-knowledge keys here (they ride
  // campaignConstraints on the negotiate side) — confirm they're excluded.
  const out = projectFlatKnowledge({
    deliverables: "2 Reels",
    timeline: "3 weeks",
    paymentTerms: "Net-30",
  } as Record<string, unknown>);
  assert.deepEqual(out, { paymentTerms: "Net-30" });
});

test("independent of BRIEF_INTO_NEGOTIATE (pure over config, reads no env)", () => {
  const prev = process.env["BRIEF_INTO_NEGOTIATE"];
  try {
    process.env["BRIEF_INTO_NEGOTIATE"] = "false";
    const off = projectFlatKnowledge({ paymentTerms: "Net-30" } as Record<string, unknown>);
    process.env["BRIEF_INTO_NEGOTIATE"] = "true";
    const on = projectFlatKnowledge({ paymentTerms: "Net-30" } as Record<string, unknown>);
    assert.deepEqual(off, on);
    assert.deepEqual(on, { paymentTerms: "Net-30" });
  } finally {
    if (prev === undefined) delete process.env["BRIEF_INTO_NEGOTIATE"];
    else process.env["BRIEF_INTO_NEGOTIATE"] = prev;
  }
});

console.log(`\n${n} tests passed\n`);
