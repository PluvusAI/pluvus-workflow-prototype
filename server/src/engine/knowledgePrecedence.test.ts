/**
 * Unit tests for the PLU-82 knowledge-precedence resolver.
 * Pure logic — run with:
 *   npx tsx src/engine/knowledgePrecedence.test.ts
 *
 * Covers: the ordered walk per category (§4.2), that firstString/firstNumber
 * emptiness semantics are honored (whitespace = empty, NaN = absent — invariant
 * #3), the winning-source LABEL (§4.6), the paymentTerms NS-skip inconsistency
 * that MUST be preserved (§7), and the operatorOverride SEAM winning WHEN present
 * even though it is always undefined on this branch (§8-a).
 */

import assert from "node:assert/strict";
import {
  agreedFeeSource,
  resolveKnowledgeField,
  PRECEDENCE_BY_CATEGORY,
  type KnowledgeCategory,
} from "./knowledgePrecedence.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

console.log("\nresolveKnowledgeField — ordered walk + label (§4.1/§4.2)\n");

test("fixedFee provenance is confirmed_agreement only when a real rate exists", () => {
  assert.equal(agreedFeeSource(425), "confirmed_agreement");
  assert.equal(agreedFeeSource(0), "confirmed_agreement");
  assert.equal(agreedFeeSource(undefined), null);
});

test("deliverables: workflow_config wins over campaign_default (node config wins)", () => {
  const r = resolveKnowledgeField("deliverables", {
    workflowConfig: "2 Reels (node)",
    campaignDefault: "1 Reel (campaign)",
  });
  assert.equal(r.value, "2 Reels (node)");
  assert.equal(r.source, "workflow_config");
});

test("deliverables: workflow_config beats negotiation_state (node config wins — byte-identical to firstString(config, negotiationConfig, campaign))", () => {
  const r = resolveKnowledgeField("deliverables", {
    negotiationState: "3 Reels (negotiation)",
    workflowConfig: "2 Reels (node)",
    campaignDefault: "1 Reel (campaign)",
  });
  assert.equal(r.value, "2 Reels (node)");
  assert.equal(r.source, "workflow_config");
});

test("deliverables: negotiation_state wins over campaign_default when workflow_config absent", () => {
  const r = resolveKnowledgeField("deliverables", {
    negotiationState: "3 Reels (negotiation)",
    campaignDefault: "1 Reel (campaign)",
  });
  assert.equal(r.value, "3 Reels (negotiation)");
  assert.equal(r.source, "negotiation_state");
});

test("deliverables: falls through to campaign_default when higher slots absent/empty", () => {
  const r = resolveKnowledgeField("deliverables", {
    negotiationState: "   ", // whitespace = empty (invariant #3)
    workflowConfig: "", // empty
    campaignDefault: "1 Reel (campaign)",
  });
  assert.equal(r.value, "1 Reel (campaign)");
  assert.equal(r.source, "campaign_default");
});

test("deliverables: all slots absent → undefined value + null source", () => {
  const r = resolveKnowledgeField("deliverables", {});
  assert.equal(r.value, undefined);
  assert.equal(r.source, null);
});

test("whitespace-only is treated as EMPTY, not present (byte-identical to firstString)", () => {
  const r = resolveKnowledgeField("timeline", {
    workflowConfig: "   \t\n ",
    campaignDefault: "live by Sept 15",
  });
  assert.equal(r.value, "live by Sept 15");
  assert.equal(r.source, "campaign_default");
});

test("non-string values are skipped for a string category", () => {
  const r = resolveKnowledgeField("timeline", {
    workflowConfig: 42 as unknown, // wrong type → skipped
    campaignDefault: "live by Sept 15",
  });
  assert.equal(r.value, "live by Sept 15");
  assert.equal(r.source, "campaign_default");
});

console.log("\ncommissionRate — numeric category (firstNumber semantics)\n");

test("commissionRate: workflow_config number wins over negotiation_state when NS absent", () => {
  const r = resolveKnowledgeField("commissionRate", { workflowConfig: 20 });
  assert.equal(r.value, 20);
  assert.equal(r.source, "workflow_config");
});

test("commissionRate: workflow_config beats negotiation_state (node config wins — byte-identical to firstNumber(config, negotiationConfig))", () => {
  const r = resolveKnowledgeField("commissionRate", {
    negotiationState: 15,
    workflowConfig: 20,
  });
  assert.equal(r.value, 20);
  assert.equal(r.source, "workflow_config");
});

test("commissionRate: negotiation_state wins when workflow_config absent", () => {
  const r = resolveKnowledgeField("commissionRate", {
    negotiationState: 15,
  });
  assert.equal(r.value, 15);
  assert.equal(r.source, "negotiation_state");
});

test("commissionRate: NaN in workflow_config falls through to negotiation_state (invariant #3)", () => {
  const r = resolveKnowledgeField("commissionRate", {
    workflowConfig: Number.NaN,
    negotiationState: 15,
  });
  assert.equal(r.value, 15);
  assert.equal(r.source, "negotiation_state");
});

test("commissionRate: a string value is skipped for a numeric category", () => {
  const r = resolveKnowledgeField("commissionRate", {
    negotiationState: "20" as unknown, // string → skipped by firstNumber
    workflowConfig: 12,
  });
  assert.equal(r.value, 12);
  assert.equal(r.source, "workflow_config");
});

test("commissionRate has NO campaign_default tier (a campaign value never wins)", () => {
  // Even if a caller (wrongly) passed campaignDefault, the category order does not
  // include it, so it is never consulted.
  const r = resolveKnowledgeField("commissionRate", {
    campaignDefault: 99 as unknown,
  });
  assert.equal(r.value, undefined);
  assert.equal(r.source, null);
});

console.log("\npaymentTerms — the PRESERVED inconsistency (§7, invariant #3)\n");

test("paymentTerms SKIPS negotiation_state: WC → CD only", () => {
  // A negotiation_state value must NOT win — paymentTerms deliberately omits NS to
  // match operatorHandoff.ts:93. If this ever changes, a real deal's DealHandoff
  // snapshot moves — this test is the guard.
  const r = resolveKnowledgeField("paymentTerms", {
    negotiationState: "Net 15 (negotiation — must be ignored)",
    workflowConfig: "Net 30 (node)",
    campaignDefault: "Net 60 (campaign)",
  });
  assert.equal(r.value, "Net 30 (node)");
  assert.equal(r.source, "workflow_config");
});

test("paymentTerms falls to campaign_default when workflow_config absent (still skipping NS)", () => {
  const r = resolveKnowledgeField("paymentTerms", {
    negotiationState: "Net 15 (must be ignored)",
    campaignDefault: "Net 60 (campaign)",
  });
  assert.equal(r.value, "Net 60 (campaign)");
  assert.equal(r.source, "campaign_default");
});

test("PRECEDENCE_BY_CATEGORY.paymentTerms does NOT contain negotiation_state", () => {
  assert.ok(!PRECEDENCE_BY_CATEGORY.paymentTerms.includes("negotiation_state"));
});

console.log("\noperatorOverride — the typed SEAM (§8-a): wins WHEN present, always undefined here\n");

test("operator_override wins over every lower slot when present (proves the seam)", () => {
  const r = resolveKnowledgeField("deliverables", {
    operatorOverride: "operator says 4 Reels",
    negotiationState: "3 Reels",
    workflowConfig: "2 Reels",
    campaignDefault: "1 Reel",
  });
  assert.equal(r.value, "operator says 4 Reels");
  assert.equal(r.source, "operator_override");
});

test("operator_override LEADS every category on this branch (no confirmed_agreement tier for these string/rate terms)", () => {
  for (const cat of Object.keys(PRECEDENCE_BY_CATEGORY) as KnowledgeCategory[]) {
    const order = PRECEDENCE_BY_CATEGORY[cat];
    assert.ok(
      order.includes("operator_override"),
      `${cat} should include the operator_override seam`,
    );
    assert.equal(
      order[0],
      "operator_override",
      `${cat} order should lead with operator_override on this branch (no confirmed_agreement tier for these string/rate terms)`,
    );
  }
});

test("an undefined operator_override is skipped exactly like an absent slot (byte-identical today)", () => {
  const withSeam = resolveKnowledgeField("deliverables", {
    operatorOverride: undefined,
    workflowConfig: "2 Reels",
  });
  const withoutSeam = resolveKnowledgeField("deliverables", {
    workflowConfig: "2 Reels",
  });
  assert.deepEqual(withSeam, withoutSeam);
  assert.equal(withSeam.value, "2 Reels");
  assert.equal(withSeam.source, "workflow_config");
});

console.log("\ngeneral-knowledge family — WC → CD, no NS, no brief slot (§4.2)\n");

for (const cat of ["usageRights", "exclusivity", "attributionWindow"] as const) {
  test(`${cat}: workflow_config wins over campaign_default; NS never consulted`, () => {
    const r = resolveKnowledgeField(cat, {
      negotiationState: "should be ignored",
      workflowConfig: "node value",
      campaignDefault: "campaign value",
    });
    assert.equal(r.value, "node value");
    assert.equal(r.source, "workflow_config");
    assert.ok(!PRECEDENCE_BY_CATEGORY[cat].includes("negotiation_state"));
  });
}

console.log(`\n${n} passed\n`);
