/**
 * Unit tests for stampRewardFromNegotiation — mirrors the brand's negotiation
 * commission onto the Reward Setup node so the builder + runtime always show the
 * CURRENT value (not a frozen copy). Pure — no DB, no network. Run:
 *   npx tsx src/routes/stampRewardCommission.test.ts
 */

import assert from "node:assert/strict";
import { stampRewardFromNegotiation, stampOutreachDerivedFields } from "./workflows.js";

let n = 0;
function test(name: string, fn: () => void): void {
  fn();
  n++;
  console.log(`  ✓ ${name}`);
}

type Node = { id: string; type: string; order: number; config: Record<string, unknown> };

function graph(commission: number | undefined): Node[] {
  return [
    { id: "neg", type: "NEGOTIATION", order: 0, config: commission === undefined ? {} : { commissionRate: commission } },
    { id: "reward", type: "REWARD_SETUP", order: 1, config: {} },
  ];
}

function rewardConfig(nodes: unknown): Record<string, unknown> {
  const arr = nodes as Node[];
  return arr.find((x) => x.type === "REWARD_SETUP")!.config;
}

console.log("\nstampRewardFromNegotiation\n");

test("copies the negotiation commission onto the reward node", () => {
  const out = stampRewardFromNegotiation(graph(20));
  assert.equal(rewardConfig(out)["commissionRate"], 20);
});

test("tracks an edited commission (overwrites a stale value)", () => {
  const nodes = graph(25);
  // Simulate a stale 10% already on the reward node.
  (nodes[1] as Node).config = { commissionRate: 10, brandName: "Acme" };
  const out = stampRewardFromNegotiation(nodes);
  assert.equal(rewardConfig(out)["commissionRate"], 25);
  // Unrelated reward-node config is preserved.
  assert.equal(rewardConfig(out)["brandName"], "Acme");
});

test("removes commission when the negotiation has none (fixed-fee deal)", () => {
  const nodes = graph(undefined);
  (nodes[1] as Node).config = { commissionRate: 10 }; // stale
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false);
});

test("commission of 0 is treated as no commission", () => {
  const out = stampRewardFromNegotiation(graph(0));
  assert.equal("commissionRate" in rewardConfig(out), false);
});

test("leaves non-reward nodes untouched", () => {
  const out = stampRewardFromNegotiation(graph(15)) as Node[];
  const neg = out.find((x) => x.type === "NEGOTIATION")!;
  assert.equal(neg.config["commissionRate"], 15);
  assert.equal("commissionRate" in neg.config, true);
});

test("no negotiation node → reward node commission cleared, no crash", () => {
  const nodes: Node[] = [{ id: "reward", type: "REWARD_SETUP", order: 0, config: { commissionRate: 12 } }];
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false);
});

// ── Merged flow: Content Brief is the post-negotiation email node ─────────────
test("copies the negotiation commission onto the CONTENT_BRIEF node (merged flow)", () => {
  const nodes: Node[] = [
    { id: "neg", type: "NEGOTIATION", order: 0, config: { commissionRate: 18 } },
    { id: "brief", type: "CONTENT_BRIEF", order: 1, config: { briefFileRef: "ref-1" } },
  ];
  const out = stampRewardFromNegotiation(nodes) as Node[];
  const brief = out.find((x) => x.type === "CONTENT_BRIEF")!;
  assert.equal(brief.config["commissionRate"], 18);
  // Unrelated brief config is preserved.
  assert.equal(brief.config["briefFileRef"], "ref-1");
});

test("clears a stale commission on CONTENT_BRIEF for a fixed-fee deal", () => {
  const nodes: Node[] = [
    { id: "neg", type: "NEGOTIATION", order: 0, config: {} },
    { id: "brief", type: "CONTENT_BRIEF", order: 1, config: { commissionRate: 9, briefFileRef: "ref-2" } },
  ];
  const out = stampRewardFromNegotiation(nodes) as Node[];
  const brief = out.find((x) => x.type === "CONTENT_BRIEF")!;
  assert.equal("commissionRate" in brief.config, false);
  assert.equal(brief.config["briefFileRef"], "ref-2");
});

// ── PLU-117: stampOutreachDerivedFields — campaignName + deal shape onto outreach
function outreachConfig(nodes: unknown): Record<string, unknown> {
  return (nodes as Node[]).find((x) => x.type === "INITIAL_OUTREACH")!.config;
}

test("stamps campaignName + collaborationType + offerSummary onto the outreach node", () => {
  const nodes: Node[] = [
    { id: "neg", type: "NEGOTIATION", order: 0, config: { maxBudget: 500, commissionRate: 15 } },
    { id: "out", type: "INITIAL_OUTREACH", order: 1, config: { brandName: "Acme" } },
  ];
  const cfg = outreachConfig(stampOutreachDerivedFields(nodes, "Spring Launch"));
  assert.equal(cfg["campaignName"], "Spring Launch");
  assert.equal(cfg["collaborationType"], "hybrid partnership");
  assert.match(cfg["offerSummary"] as string, /hybrid partnership/);
  assert.equal(cfg["brandName"], "Acme", "unrelated config preserved");
});

test("removes derived keys when the source is absent (so availability hides them)", () => {
  const nodes: Node[] = [
    { id: "neg", type: "NEGOTIATION", order: 0, config: {} }, // no deal shape
    // stale derived values from a previous save
    { id: "out", type: "INITIAL_OUTREACH", order: 1, config: { campaignName: "Old", collaborationType: "x", offerSummary: "y" } },
  ];
  const cfg = outreachConfig(stampOutreachDerivedFields(nodes, null));
  assert.equal("campaignName" in cfg, false);
  assert.equal("collaborationType" in cfg, false);
  assert.equal("offerSummary" in cfg, false);
});

test("overwrites a stale campaignName with the current one", () => {
  const nodes: Node[] = [
    { id: "neg", type: "NEGOTIATION", order: 0, config: {} },
    { id: "out", type: "INITIAL_OUTREACH", order: 1, config: { campaignName: "Old Name" } },
  ];
  const cfg = outreachConfig(stampOutreachDerivedFields(nodes, "New Name"));
  assert.equal(cfg["campaignName"], "New Name");
});

test("leaves non-outreach nodes untouched", () => {
  const nodes: Node[] = [
    { id: "neg", type: "NEGOTIATION", order: 0, config: { maxBudget: 500 } },
    { id: "out", type: "INITIAL_OUTREACH", order: 1, config: {} },
  ];
  const out = stampOutreachDerivedFields(nodes, "Camp") as Node[];
  const neg = out.find((x) => x.type === "NEGOTIATION")!;
  assert.equal("campaignName" in neg.config, false);
});

console.log(`\n${n} passed\n`);
