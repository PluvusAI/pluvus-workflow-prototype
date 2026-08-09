/**
 * Unit tests for the workflow graph model + validation (Phase 17).
 * Pure logic — run with:
 *   npx tsx src/workflow/graph.test.ts
 *
 * The critical guarantee here is BACKWARD COMPATIBILITY: a legacy linear
 * draftNodes[] must round-trip through the graph model and come back out as a
 * flat, correctly-ordered array the runtime can still execute.
 */

import assert from "node:assert/strict";
import {
  linearNodesToGraph,
  graphToLinearNodes,
  topologicalOrder,
} from "./graphModel";
import { validateGraph } from "./graphValidation";
import type { DraftNode } from "../api/builderTypes";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const legacyDraft: DraftNode[] = [
  { id: "a", type: "INITIAL_OUTREACH", order: 0, config: { subjectTemplate: "Hi", bodyTemplate: "B" } },
  { id: "b", type: "FOLLOW_UP", order: 1, config: { bodyTemplate: "F", intervals: [3] } },
  // HARD-N3: a positive floor — a $0 floor with a positive ceiling is now an
  // INVALID_ZERO_FLOOR config error (these tests exercise graph structure, not
  // the zero-floor edge case).
  { id: "c", type: "NEGOTIATION", order: 2, config: { minBudget: 50, maxBudget: 500 } },
  { id: "d", type: "REWARD_SETUP", order: 3, config: {} },
];

console.log("\ngraph model + validation\n");

test("legacy draft → graph produces implicit linear edges", () => {
  const g = linearNodesToGraph(legacyDraft);
  assert.equal(g.nodes.length, 4);
  assert.equal(g.edges.length, 3);
  assert.deepEqual(
    g.edges.map((e) => `${e.source}->${e.target}`),
    ["a->b", "b->c", "c->d"],
  );
});

test("graph → linear preserves order + node identity (round-trip)", () => {
  const g = linearNodesToGraph(legacyDraft);
  const back = graphToLinearNodes(g);
  assert.deepEqual(
    back.map((n) => n.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    back.map((n) => n.order),
    [0, 1, 2, 3],
  );
  // Runtime-facing config still carries the original fields (plus the ignored
  // `_graph` sidecar).
  assert.equal((back[0]!.config as Record<string, unknown>)["subjectTemplate"], "Hi");
});

test("round-trip is stable across two passes (idempotent)", () => {
  const g1 = linearNodesToGraph(legacyDraft);
  const linear1 = graphToLinearNodes(g1);
  const g2 = linearNodesToGraph(linear1);
  const linear2 = graphToLinearNodes(g2);
  assert.deepEqual(
    linear1.map((n) => `${n.id}:${n.order}`),
    linear2.map((n) => `${n.id}:${n.order}`),
  );
  // Edges reconstructed from the sidecar match the original implicit chain.
  assert.deepEqual(
    g2.edges.map((e) => `${e.source}->${e.target}`),
    ["a->b", "b->c", "c->d"],
  );
});

test("legacy draft validates as a valid graph", () => {
  const g = linearNodesToGraph(legacyDraft);
  const res = validateGraph(g);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

test("topologicalOrder never drops nodes (cyclic fallback)", () => {
  const g = linearNodesToGraph(legacyDraft);
  // Inject a cycle d→a; topo order must still return all 4 nodes.
  g.edges.push({ id: "e:d->a", source: "d", target: "a" });
  const ordered = topologicalOrder(g);
  assert.equal(ordered.length, 4);
});

test("empty draft → empty graph is invalid", () => {
  const g = linearNodesToGraph([]);
  const res = validateGraph(g);
  assert.equal(res.valid, false);
  assert.equal(res.errors[0]?.code, "EMPTY_GRAPH");
});

test("branching graph is invalid", () => {
  const g = linearNodesToGraph(legacyDraft);
  g.edges.push({ id: "e:a->c", source: "a", target: "c" });
  const res = validateGraph(g);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.code === "INVALID_BRANCHING"));
});

test("mid-chain delete with auto-heal keeps the flow linear + valid", () => {
  // a -> b -> c -> d. Delete 'b' and heal a->c. Result must stay linear/valid.
  const g = linearNodesToGraph(legacyDraft);
  const nodeId = "b";
  const preds = g.edges.filter((e) => e.target === nodeId).map((e) => e.source);
  const succs = g.edges.filter((e) => e.source === nodeId).map((e) => e.target);
  let edges = g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
  if (preds.length === 1 && succs.length === 1 && preds[0] !== succs[0]) {
    edges = [...edges, { id: `e:${preds[0]}->${succs[0]}`, source: preds[0]!, target: succs[0]! }];
  }
  const healed = { ...g, nodes: g.nodes.filter((n) => n.id !== nodeId), edges };
  const res = validateGraph(healed);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
  assert.deepEqual(
    healed.edges.map((e) => `${e.source}->${e.target}`),
    ["c->d", "a->c"],
  );
});

test("moving a node (position only) preserves all edges through serialize", () => {
  // Regression: a position change must never drop edges. Simulate the canvas
  // emitting a nodes-only update (edges untouched), then serialize + reload.
  const g = linearNodesToGraph(legacyDraft);
  const moved = {
    ...g,
    nodes: g.nodes.map((n) => (n.id === "b" ? { ...n, position: { x: 999, y: 42 } } : n)),
  };
  const reloaded = linearNodesToGraph(graphToLinearNodes(moved));
  assert.deepEqual(
    reloaded.edges.map((e) => `${e.source}->${e.target}`),
    ["a->b", "b->c", "c->d"],
  );
  // ...and the moved node kept its new position.
  const b = reloaded.nodes.find((n) => n.id === "b");
  assert.deepEqual(b?.position, { x: 999, y: 42 });
});

// -- PLU-129: MISSING_COMPENSATION mirrored on the web validator --------------

// A minimal valid pipeline whose NEGOTIATION node carries the config under test.
function draftWithNegotiation(negConfig: Record<string, unknown>): DraftNode[] {
  return [
    { id: "a", type: "INITIAL_OUTREACH", order: 0, config: { subjectTemplate: "Hi", bodyTemplate: "B" } },
    { id: "c", type: "NEGOTIATION", order: 1, config: negConfig },
    { id: "d", type: "REWARD_SETUP", order: 2, config: {} },
  ];
}

test("PLU-129 (web): no fee band AND no commission is rejected (neither)", () => {
  const g = linearNodesToGraph(draftWithNegotiation({ minBudget: 0, maxBudget: 0 }));
  const res = validateGraph(g);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.code === "MISSING_COMPENSATION"));
});

test("PLU-129 (web): commission-only (0/0 + positive commission) is valid", () => {
  const g = linearNodesToGraph(
    draftWithNegotiation({ minBudget: 0, maxBudget: 0, commissionRate: 15 }),
  );
  const res = validateGraph(g);
  assert.equal(res.valid, true, JSON.stringify(res.errors));
});

test("PLU-129 (web): fee-on node with a $0 floor still fails INVALID_ZERO_FLOOR (not MISSING_COMPENSATION)", () => {
  const g = linearNodesToGraph(draftWithNegotiation({ minBudget: 0, maxBudget: 500 }));
  const res = validateGraph(g);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.code === "INVALID_ZERO_FLOOR"));
  assert.ok(!res.errors.some((e) => e.code === "MISSING_COMPENSATION"));
});

console.log(`\n${passed} passed\n`);
