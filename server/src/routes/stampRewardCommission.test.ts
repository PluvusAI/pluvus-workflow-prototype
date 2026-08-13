/**
 * Unit tests for stampRewardFromNegotiation. PLU-138 (1d) REVERSED its behavior:
 * it used to COPY the negotiation commission onto the Reward Setup / Content Brief
 * node (a competing copy of a PUBLIC term now owned by CampaignTermsSnapshot); it
 * now STRIPS commissionRate from those nodes so the stamped copy can never win over
 * the snapshot. These tests assert the new strip behavior. Pure — no DB. Run:
 *   npx tsx src/routes/stampRewardCommission.test.ts
 */

import assert from "node:assert/strict";
import { stampRewardFromNegotiation, stampOutreachDerivedFields, restampBrand } from "./workflows.js";

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

test("PLU-138: STRIPS the commission copy off the reward node (no longer stamped)", () => {
  const nodes = graph(20);
  (nodes[1] as Node).config = { commissionRate: 20 }; // a previously-stamped copy
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false); // scrubbed
});

test("PLU-138: strips a stale commission copy, preserves unrelated reward config", () => {
  const nodes = graph(25);
  // Simulate a stale 10% already on the reward node.
  (nodes[1] as Node).config = { commissionRate: 10, brandName: "Acme" };
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false); // scrubbed, NOT re-stamped to 25
  // Unrelated reward-node config is preserved.
  assert.equal(rewardConfig(out)["brandName"], "Acme");
});

test("PLU-138: reward node with no commission stays clean (fixed-fee deal)", () => {
  const nodes = graph(undefined);
  (nodes[1] as Node).config = { commissionRate: 10 }; // stale copy
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false);
});

test("leaves non-reward nodes untouched (NEGOTIATION keeps its own commission)", () => {
  const out = stampRewardFromNegotiation(graph(15)) as Node[];
  const neg = out.find((x) => x.type === "NEGOTIATION")!;
  // The NEGOTIATION node's own config is not a stamped copy — it is where the brand
  // sets the value pre-launch; only the EMAIL nodes are scrubbed. (Post-launch the
  // snapshot is authoritative regardless.)
  assert.equal(neg.config["commissionRate"], 15);
  assert.equal("commissionRate" in neg.config, true);
});

test("no negotiation node → reward node commission cleared, no crash", () => {
  const nodes: Node[] = [{ id: "reward", type: "REWARD_SETUP", order: 0, config: { commissionRate: 12 } }];
  const out = stampRewardFromNegotiation(nodes);
  assert.equal("commissionRate" in rewardConfig(out), false);
});

// ── Merged flow: Content Brief is the post-negotiation email node ─────────────
test("PLU-138: STRIPS the commission copy off the CONTENT_BRIEF node (merged flow)", () => {
  const nodes: Node[] = [
    { id: "neg", type: "NEGOTIATION", order: 0, config: { commissionRate: 18 } },
    { id: "brief", type: "CONTENT_BRIEF", order: 1, config: { commissionRate: 18, briefFileRef: "ref-1" } },
  ];
  const out = stampRewardFromNegotiation(nodes) as Node[];
  const brief = out.find((x) => x.type === "CONTENT_BRIEF")!;
  assert.equal("commissionRate" in brief.config, false); // scrubbed
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

// ── PLU-138 (1d): restampBrand no longer stamps MATERIAL terms ────────────────
test("restampBrand does NOT stamp deliverables/timeline/rewardDescription (material)", () => {
  const nodes: Node[] = [
    { id: "n", type: "NEGOTIATION", order: 0, config: {} },
  ];
  // Even if the campaign had these, restampBrand no longer accepts/injects them —
  // the snapshot owns them. Call with the current (brand + shipsPhysicalProduct) sig.
  const out = restampBrand(nodes, "Acme", "A cool brand", true) as Node[];
  const cfg = out[0]!.config;
  assert.equal("deliverables" in cfg, false);
  assert.equal("timeline" in cfg, false);
  assert.equal("rewardDescription" in cfg, false);
});

test("restampBrand STILL stamps brand presentation + shipsPhysicalProduct (retained)", () => {
  const nodes: Node[] = [{ id: "n", type: "NEGOTIATION", order: 0, config: {} }];
  const out = restampBrand(nodes, "Acme", "A cool brand", true) as Node[];
  const cfg = out[0]!.config;
  assert.equal(cfg["brandName"], "Acme");
  assert.equal(cfg["senderName"], "Acme");
  assert.equal(cfg["brandDescription"], "A cool brand");
  assert.equal(cfg["shipsPhysicalProduct"], true); // compat flag retained (PLU-144 owns removal)
});

test("restampBrand: node config brand values win over the campaign brand", () => {
  const nodes: Node[] = [
    { id: "n", type: "NEGOTIATION", order: 0, config: { brandName: "NodeBrand", senderName: "NodeSender" } },
  ];
  const out = restampBrand(nodes, "Acme", null, false) as Node[];
  const cfg = out[0]!.config;
  assert.equal(cfg["brandName"], "NodeBrand"); // preserve-if-present
  assert.equal(cfg["senderName"], "NodeSender");
  assert.equal(cfg["shipsPhysicalProduct"], false);
});

console.log(`\n${n} passed\n`);
