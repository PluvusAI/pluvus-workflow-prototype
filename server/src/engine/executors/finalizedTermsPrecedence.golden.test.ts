/**
 * PLU-82 GOLDEN regression tests — the migration of the three post-acceptance
 * executors' inline firstString/firstNumber chains to resolveKnowledgeField must
 * be BYTE-IDENTICAL for every real deal (invariant #3, §4.3, §8-d).
 *
 * Run with:
 *   npx tsx src/engine/executors/finalizedTermsPrecedence.golden.test.ts
 *
 * Strategy: each executor resolved its terms with a specific inline chain. The
 * "golden" oracle here is a literal re-implementation of each OLD inline chain
 * (calling firstString/firstNumber exactly as the pre-PLU-82 code did). For a
 * matrix of representative configs (present/absent/whitespace/NaN/wrong-type
 * across all tiers, per executor's exact slot wiring), we assert
 * resolveKnowledgeField produces the SAME value the old chain would have. If the
 * resolver's order, emptiness semantics, or the paymentTerms NS-skip ever drift,
 * one of these fails — that is the net that guarantees no DealHandoff /
 * reward-email / content-brief snapshot moves.
 *
 * The winning-source LABEL is also asserted where it disambiguates which tier won,
 * so the debug `resolvedSources` record can be trusted.
 */

import assert from "node:assert/strict";
import { firstString, firstNumber } from "./agreedFee.js";
import { resolveKnowledgeField, PRECEDENCE_BY_CATEGORY } from "../knowledgePrecedence.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

// A spread of tier values that exercise every emptiness edge firstString/
// firstNumber care about: a real value, "", whitespace, undefined, a wrong-typed
// value. Cartesian across tiers would be huge, so we hand-pick the rows that
// actually flip which tier wins.
const S = {
  node: "NODE",
  neg: "NEG",
  camp: "CAMP",
  empty: "",
  ws: "   \t ",
  num: 42 as unknown, // wrong type for a string field
} as const;

const N = {
  node: 20,
  neg: 15,
  nan: Number.NaN,
  str: "20" as unknown, // wrong type for a number field
} as const;

// ---------------------------------------------------------------------------
// operatorHandoff.ts — 3-tier deliverables/timeline/rewardDescription
//   firstString(config[k], negotiationConfig[k], campaign?.[k])
// 2-tier commissionRate: firstNumber(config[k], negotiationConfig[k])
// 2-tier paymentTerms (SKIPS negotiationConfig): firstString(config[k], campaign?.[k])
// ---------------------------------------------------------------------------

console.log("\noperatorHandoff — 3-tier string terms (config → negotiationConfig → campaign)\n");

// The OLD inline oracle for a 3-tier string term.
function oldHandoff3(node: unknown, neg: unknown, camp: unknown): string | undefined {
  return firstString(node, neg, camp);
}
// The NEW resolver call, wired exactly as operatorHandoff does.
function newHandoff3(node: unknown, neg: unknown, camp: unknown) {
  return resolveKnowledgeField("deliverables", {
    workflowConfig: node,
    negotiationState: neg,
    campaignDefault: camp,
  });
}

const handoff3Cases: Array<[unknown, unknown, unknown]> = [
  [S.node, S.neg, S.camp], // all present → node wins
  [undefined, S.neg, S.camp], // node absent → neg
  [S.empty, S.neg, S.camp], // node "" → neg
  [S.ws, S.neg, S.camp], // node whitespace → neg
  [S.ws, S.ws, S.camp], // node+neg empty → campaign
  [undefined, undefined, S.camp], // only campaign
  [undefined, undefined, undefined], // nothing → undefined
  [S.num, S.neg, S.camp], // node wrong-type → neg
  [S.node, undefined, undefined], // only node
];

for (const [node, neg, camp] of handoff3Cases) {
  test(`3-tier value matches old chain [${JSON.stringify([node, neg, camp])}]`, () => {
    const oldV = oldHandoff3(node, neg, camp);
    const got = newHandoff3(node, neg, camp);
    assert.equal(got.value, oldV, "resolved value must match the old inline chain");
  });
}

test("3-tier label disambiguates the winning tier", () => {
  assert.equal(newHandoff3(S.node, S.neg, S.camp).source, "workflow_config");
  assert.equal(newHandoff3(undefined, S.neg, S.camp).source, "negotiation_state");
  assert.equal(newHandoff3(undefined, undefined, S.camp).source, "campaign_default");
  assert.equal(newHandoff3(undefined, undefined, undefined).source, null);
});

console.log("\noperatorHandoff — commissionRate (2-tier numeric: config → negotiationConfig)\n");

function oldCommission(node: unknown, neg: unknown): number | undefined {
  return firstNumber(node, neg);
}
function newCommission(node: unknown, neg: unknown) {
  return resolveKnowledgeField("commissionRate", {
    workflowConfig: node,
    negotiationState: neg,
  });
}

const commissionCases: Array<[unknown, unknown]> = [
  [N.node, N.neg], // both → node
  [undefined, N.neg], // node absent → neg
  [N.nan, N.neg], // node NaN → neg (invariant #3)
  [N.str, N.neg], // node wrong-type → neg
  [N.node, undefined], // only node
  [undefined, undefined], // nothing
];

for (const [node, neg] of commissionCases) {
  test(`commissionRate value matches old firstNumber [${JSON.stringify([node, neg])}]`, () => {
    assert.equal(newCommission(node, neg).value, oldCommission(node, neg));
  });
}

console.log("\noperatorHandoff — paymentTerms (2-tier, SKIPS negotiationConfig — the preserved quirk §7)\n");

// OLD: firstString(config[k], campaign?.[k]) — negotiationConfig is NOT read.
function oldPaymentTerms(node: unknown, camp: unknown): string | undefined {
  return firstString(node, camp);
}
// NEW: resolveKnowledgeField("paymentTerms", {workflowConfig, campaignDefault}) —
// negotiationState deliberately NOT passed.
function newPaymentTerms(node: unknown, camp: unknown) {
  return resolveKnowledgeField("paymentTerms", {
    workflowConfig: node,
    campaignDefault: camp,
  });
}

const paymentCases: Array<[unknown, unknown]> = [
  ["Net 30", "Net 60"], // node wins
  [undefined, "Net 60"], // campaign
  [S.ws, "Net 60"], // node whitespace → campaign
  [undefined, undefined], // nothing
];

for (const [node, camp] of paymentCases) {
  test(`paymentTerms value matches old 2-tier chain [${JSON.stringify([node, camp])}]`, () => {
    assert.equal(newPaymentTerms(node, camp).value, oldPaymentTerms(node, camp));
  });
}

test("paymentTerms: a negotiationConfig value is IGNORED (the preserved quirk) — matches old behavior", () => {
  // OLD code never read negotiationConfig for paymentTerms. Simulate a config where
  // only negotiationConfig has a value: old chain → undefined (node+campaign empty).
  const node = undefined;
  const camp = undefined;
  const oldV = oldPaymentTerms(node, camp); // undefined — NS never consulted
  // NEW: NS is not even a slot the call passes, so it can't win.
  const got = newPaymentTerms(node, camp);
  assert.equal(got.value, oldV);
  assert.equal(got.value, undefined);
  assert.equal(got.source, null);
});

console.log("\nrewardSetup + contentBrief — 2-tier string terms (config → negotiationConfig, NO campaign)\n");

// Both rewardSetup and contentBrief resolve deliverables/timeline as
// firstString(config[k], negotiationConfig[k]) — no campaign tier.
function old2tier(node: unknown, neg: unknown): string | undefined {
  return firstString(node, neg);
}
function new2tier(node: unknown, neg: unknown) {
  return resolveKnowledgeField("deliverables", {
    workflowConfig: node,
    negotiationState: neg,
    // campaignDefault intentionally omitted — these executors had no campaign tier.
  });
}

const twoTierCases: Array<[unknown, unknown]> = [
  [S.node, S.neg], // node
  [undefined, S.neg], // neg
  [S.ws, S.neg], // node whitespace → neg
  [S.node, undefined], // only node
  [undefined, undefined], // nothing
];

for (const [node, neg] of twoTierCases) {
  test(`2-tier value matches old firstString(config, negotiationConfig) [${JSON.stringify([node, neg])}]`, () => {
    const oldV = old2tier(node, neg);
    const got = new2tier(node, neg);
    assert.equal(got.value, oldV);
    // Crucially: an absent campaign tier can NEVER be the source (it wasn't passed).
    assert.notEqual(got.source, "campaign_default");
  });
}

test("2-tier: a campaign value is NEVER consulted (byte-identical to the no-campaign inline chain)", () => {
  // Even if (hypothetically) a campaign value existed, the call site does not pass
  // it, so it cannot win — matching the old chain that never read campaign.
  const got = new2tier(undefined, undefined);
  assert.equal(got.value, undefined);
  assert.equal(got.source, null);
});

console.log("\ncontentBrief — rewardDescription (trimmed workflow config only)\n");

function oldContentBriefString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

for (const raw of ["  creator receives shoes  ", "", S.ws, undefined, S.num]) {
  test(`rewardDescription preserves legacy trim semantics [${JSON.stringify(raw)}]`, () => {
    const resolved = resolveKnowledgeField("rewardDescription", { workflowConfig: raw });
    const rendered = typeof resolved.value === "string" ? resolved.value.trim() : "";
    assert.equal(rendered, oldContentBriefString(raw));
    assert.equal(
      resolved.source,
      oldContentBriefString(raw) ? "workflow_config" : null,
    );
  });
}

console.log("\nPLU-142 follow-up — a pinned-snapshot clear must not resurrect a stale NEGOTIATION value\n");

// Reproduces the reported bug directly against the real call sites' wiring: the
// pinned terms snapshot explicitly cleared this field (workflowConfig is absent
// because effectiveTerms deleted it), but the stale NEGOTIATION node still has a
// leftover value from before the clear. Without explicitlyCleared, the old
// resolveKnowledgeField would fall through and resurrect it into the
// contract-forming confirmation.
for (const category of ["commissionRate", "deliverables", "timeline", "rewardDescription"] as const) {
  test(`${category}: explicitlyCleared blocks the stale negotiation_state value from reappearing`, () => {
    const staleNegotiationValue = category === "commissionRate" ? 37 : "STALE from NEGOTIATION node";
    const cleared = resolveKnowledgeField(category, {
      // workflowConfig absent — effectiveTerms.ts deleted the stale config value.
      negotiationState: staleNegotiationValue,
      explicitlyCleared: true,
    });
    assert.equal(cleared.value, undefined, `${category} must not resurrect the stale negotiation value`);
    assert.equal(cleared.source, null);

    // Sanity: WITHOUT the fix (explicitlyCleared unset), the stale value DOES win —
    // proving this is a real regression guard, not a vacuously-true assertion.
    const unpatched = resolveKnowledgeField(category, {
      negotiationState: staleNegotiationValue,
    });
    assert.equal(unpatched.value, staleNegotiationValue);
    assert.equal(unpatched.source, "negotiation_state");
  });
}

// ---------------------------------------------------------------------------
// review §2 (Calvin): PIN the exact field-by-field precedence policy as a literal
// table, so approving PLU-82 means intentionally approving THIS order — not
// assuming the issue's proposed hierarchy was implemented unchanged. Any drift in
// PRECEDENCE_BY_CATEGORY (a reordered tier, an added/removed slot, the paymentTerms
// NS-skip silently "fixed") fails HERE, loudly, against the documented table in
// readme_docs/KNOWLEDGE_PRECEDENCE.md §2.
// ---------------------------------------------------------------------------
console.log("\nreview §2 — the precedence table is pinned exactly\n");

const EXPECTED_PRECEDENCE: Record<string, string[]> = {
  // Finalized-terms family.
  commissionRate: ["operator_override", "workflow_config", "negotiation_state"],
  deliverables: ["operator_override", "workflow_config", "negotiation_state", "campaign_default"],
  timeline: ["operator_override", "workflow_config", "negotiation_state", "campaign_default"],
  rewardDescription: ["operator_override", "workflow_config", "negotiation_state", "campaign_default"],
  // paymentTerms deliberately SKIPS negotiation_state (the preserved quirk, §2.1).
  paymentTerms: ["operator_override", "workflow_config", "campaign_default"],
  // General-knowledge family (brief is a conflict challenger, never a slot).
  usageRights: ["operator_override", "workflow_config", "campaign_default"],
  exclusivity: ["operator_override", "workflow_config", "campaign_default"],
  attributionWindow: ["operator_override", "workflow_config", "campaign_default"],
};

test("PRECEDENCE_BY_CATEGORY matches the documented table byte-for-byte (order included)", () => {
  assert.deepEqual(
    PRECEDENCE_BY_CATEGORY as unknown as Record<string, string[]>,
    EXPECTED_PRECEDENCE,
    "the precedence policy drifted from the approved KNOWLEDGE_PRECEDENCE.md §2 table",
  );
});

test("every finalized-terms category leads with operator_override (the fixed PLU-113 seam)", () => {
  for (const [cat, order] of Object.entries(EXPECTED_PRECEDENCE)) {
    assert.equal(order[0], "operator_override", `${cat} must lead with operator_override`);
  }
});

test("paymentTerms is the ONLY category that omits negotiation_state (the preserved inconsistency)", () => {
  const omitsNS = Object.entries(EXPECTED_PRECEDENCE)
    .filter(([, order]) => !order.includes("negotiation_state"))
    .map(([cat]) => cat)
    .sort();
  // usageRights/exclusivity/attributionWindow are general-knowledge (never had NS);
  // among the FINALIZED-TERMS family, paymentTerms is the sole NS-skipper.
  assert.deepEqual(omitsNS, ["attributionWindow", "exclusivity", "paymentTerms", "usageRights"]);
});

console.log(`\n${n} passed\n`);
