/**
 * Connection-rule tests (PLU-130). Pure logic — run with:
 *   npx tsx src/workflow/connectionRules.test.ts
 * The decision-logic layer GraphCanvas calls for both feedback and commit:
 * connect / reconnect / disconnect / merge / invalid relationships.
 */

import assert from "node:assert/strict";
import {
  canConnect,
  canReconnect,
  applyConnect,
  applyReconnect,
  applyDisconnect,
} from "./connectionRules";
import {
  linearNodesToGraph,
  graphToLinearNodes,
  edgeId,
  type WorkflowDefinition,
} from "./graphModel";
import { validateGraph } from "./graphValidation";
import type { DraftNode } from "../api/builderTypes";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("\nconnection rules (PLU-130)\n");

// A linear pipeline: Outreach → Detection → Negotiation → Reward.
const draft: DraftNode[] = [
  { id: "o", type: "INITIAL_OUTREACH", order: 0, config: { subjectTemplate: "Hi", bodyTemplate: "B" } },
  { id: "d", type: "REPLY_DETECTION", order: 1, config: {} },
  { id: "n", type: "NEGOTIATION", order: 2, config: { minBudget: 50, maxBudget: 500 } },
  { id: "r", type: "REWARD_SETUP", order: 3, config: {} },
];
function fresh(): WorkflowDefinition {
  return linearNodesToGraph(draft);
}

// -- connect: happy path ------------------------------------------------------

test("connect: a fresh forward edge is allowed", () => {
  // Start from just two disconnected nodes so there's no pre-existing chain.
  const def = linearNodesToGraph([
    { id: "o", type: "INITIAL_OUTREACH", order: 0, config: { subjectTemplate: "Hi", bodyTemplate: "B" } },
    { id: "d", type: "REPLY_DETECTION", order: 1, config: {} },
  ]);
  // linearNodesToGraph chained o→d; drop it to simulate two free nodes.
  const free: WorkflowDefinition = { ...def, edges: [] };
  const v = canConnect(free, "o", "d");
  assert.equal(v.ok, true);
});

test("connect: applyConnect reroutes the source's existing out-edge (no branch)", () => {
  // applyConnect is a pure transform (rule checks are the caller's job); assert
  // only the reroute mechanic — o's prior out-edge o→d is dropped, o→r added.
  const def = fresh();
  const rerouted = applyConnect(def, "o", "r");
  assert.ok(!rerouted.some((e) => e.source === "o" && e.target === "d"), "old o→d dropped");
  assert.ok(rerouted.some((e) => e.source === "o" && e.target === "r"), "new o→r added");
  assert.equal(rerouted.filter((e) => e.source === "o").length, 1, "o still has exactly one out-edge");
});

test("connect: branching from source is ALLOWED by canConnect (reroute handles it)", () => {
  // o has out-edge o→d. Connecting o→<something new with no parent> is fine.
  const def = fresh();
  // Add an isolated valid target that currently has no parent.
  const withIsland: WorkflowDefinition = {
    ...def,
    nodes: [...def.nodes, { id: "f", type: "FOLLOW_UP", position: { x: 0, y: 0 }, config: { intervals: [3] } }],
  };
  const v = canConnect(withIsland, "o", "f"); // o already has o→d, but f has no parent
  assert.equal(v.ok, true, "source-side branching allowed; applyConnect reroutes");
});

// -- merge: BLOCKED with explanation (converging edges) -----------------------

test("connect: a SECOND incoming edge (merge) is blocked with a reason naming the target", () => {
  const def = fresh(); // n already has d→n
  const v = canConnect(def, "o", "n");
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.code === "INVALID_MERGE");
  assert.ok(!v.ok && /Negotiation/.test(v.reason), "reason names the target node");
});

// -- self-loop / duplicate ----------------------------------------------------

test("connect: self-loop is blocked", () => {
  const v = canConnect(fresh(), "o", "o");
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.code === "SELF_LOOP");
});

test("connect: duplicate edge is blocked", () => {
  const v = canConnect(fresh(), "d", "n"); // d→n already exists
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.code === "DUPLICATE_EDGE");
});

// -- phase order --------------------------------------------------------------

test("connect: backward phase order is blocked (Reward → Negotiation)", () => {
  // Build o→d free of r's parent so the ONLY reason to reject is phase order.
  const def = linearNodesToGraph([
    { id: "n", type: "NEGOTIATION", order: 0, config: { minBudget: 50, maxBudget: 500 } },
    { id: "r", type: "REWARD_SETUP", order: 1, config: {} },
  ]);
  const free: WorkflowDefinition = { ...def, edges: [] }; // n and r free, no parents
  const v = canConnect(free, "r", "n"); // Reward (phase 4) → Negotiation (phase 3)
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.code === "INVALID_PHASE_ORDER");
});

test("connect: forward phase order is allowed (Negotiation → Reward)", () => {
  const def = linearNodesToGraph([
    { id: "n", type: "NEGOTIATION", order: 0, config: { minBudget: 50, maxBudget: 500 } },
    { id: "r", type: "REWARD_SETUP", order: 1, config: {} },
  ]);
  const free: WorkflowDefinition = { ...def, edges: [] };
  assert.equal(canConnect(free, "n", "r").ok, true);
});

// -- reconnect (the blocker's regression) -------------------------------------

test("reconnect: moving an edge endpoint back onto a valid neighbour is allowed", () => {
  // o→d→n→r. Grab the d→n edge and drop its target back onto n. canConnect would
  // wrongly report DUPLICATE_EDGE (the old edge is still present); canReconnect
  // excludes the moving edge first, so it's allowed.
  const def = fresh();
  const moving = edgeId("d", "n");
  assert.equal(canConnect(def, "d", "n").ok, false, "canConnect sees the old edge → false");
  assert.equal(canReconnect(def, moving, "d", "n").ok, true, "canReconnect excludes the moving edge → true");
});

test("reconnect: excluding the moving edge clears a false merge", () => {
  // Reconnect d→n so its SOURCE becomes o (o→n). Without excluding d→n, n would
  // look like it has two parents; excluding it, o is the only parent → allowed.
  const def = fresh();
  const moving = edgeId("d", "n");
  const v = canReconnect(def, moving, "o", "n");
  assert.equal(v.ok, true, JSON.stringify(v));
});

test("reconnect: applyReconnect drops old + adds new", () => {
  const def = fresh();
  const moving = edgeId("d", "n");
  const next = applyReconnect(def, moving, "o", "n");
  assert.ok(!next.some((e) => e.id === moving), "old d→n gone");
  assert.ok(next.some((e) => e.source === "o" && e.target === "n"), "new o→n added");
});

test("reconnect: onto an already-existing edge just drops the old (dedupe)", () => {
  // o→d→n→r plus a spare edge we then reconnect onto an existing one.
  const def = fresh();
  const moving = edgeId("d", "n");
  // Reconnect d→n onto o→d (which exists): result should just drop d→n, not
  // create a duplicate o→d.
  const next = applyReconnect(def, moving, "o", "d");
  assert.ok(!next.some((e) => e.id === moving), "moving edge dropped");
  assert.equal(next.filter((e) => e.source === "o" && e.target === "d").length, 1, "no duplicate o→d");
});

// -- disconnect ---------------------------------------------------------------

test("disconnect: removes exactly the one edge", () => {
  const def = fresh();
  const target = edgeId("d", "n");
  const next = applyDisconnect(def, target);
  assert.equal(next.length, def.edges.length - 1);
  assert.ok(!next.some((e) => e.id === target));
  // every OTHER edge survives
  for (const e of def.edges) {
    if (e.id === target) continue;
    assert.ok(next.some((x) => x.id === e.id), `edge ${e.id} preserved`);
  }
});

// -- web ↔ server parity: block codes agree with the validator ----------------

test("parity: canConnect block codes agree with validateGraph flagging the same edge", () => {
  // For each blockable connection, assert BOTH that canConnect rejects it with a
  // code AND that adding the edge makes validateGraph surface the SAME code — so
  // the connect-time guard can never diverge from the publish/launch validator.
  // Each case uses the base chain plus the one offending edge.
  // Each case supplies its OWN base def so the offending edge is the ONLY
  // violation the validator reports (otherwise a pre-existing incoming edge would
  // mask a phase-order case as a merge, which is itself correct but muddies the
  // parity comparison).
  const cases: Array<{ def: () => WorkflowDefinition; source: string; target: string; code: string }> = [
    // Merge: n already has d→n in the base chain, so o→n is a second incoming.
    { def: fresh, source: "o", target: "n", code: "INVALID_MERGE" },
    // Duplicate: d→n already exists in the base chain.
    { def: fresh, source: "d", target: "n", code: "DUPLICATE_EDGE" },
    // Phase order: two FREE nodes (no parents) so Reward→Negotiation is backward
    // and nothing else. (In the full chain this would surface as a merge first —
    // also correct — so we isolate it here.)
    {
      def: () => ({
        ...linearNodesToGraph([
          { id: "n", type: "NEGOTIATION", order: 0, config: { minBudget: 50, maxBudget: 500 } },
          { id: "r", type: "REWARD_SETUP", order: 1, config: {} },
        ]),
        edges: [],
      }),
      source: "r",
      target: "n",
      code: "INVALID_PHASE_ORDER",
    },
  ];
  for (const c of cases) {
    const def = c.def();
    const verdict = canConnect(def, c.source, c.target);
    assert.equal(verdict.ok, false, `${c.source}→${c.target} should be blocked`);
    assert.ok(!verdict.ok && verdict.code === c.code, `canConnect code for ${c.source}→${c.target}`);
    // Add the edge and validate — the validator must surface the same code.
    const withEdge: WorkflowDefinition = {
      ...def,
      edges: [...def.edges, { id: edgeId(c.source, c.target), source: c.source, target: c.target }],
    };
    const res = validateGraph(withEdge);
    assert.ok(
      res.errors.some((e) => e.code === c.code),
      `validator should emit ${c.code} for ${c.source}→${c.target}, got ${res.errors.map((e) => e.code).join(",")}`,
    );
  }
});

// -- round-trip: transforms survive serialize/reload --------------------------

test("round-trip: applyReconnect result survives graph→linear→graph", () => {
  const def = fresh();
  const moving = edgeId("d", "n");
  const nextEdges = applyReconnect(def, moving, "o", "n");
  const mutated: WorkflowDefinition = { ...def, edges: nextEdges };
  const reloaded = linearNodesToGraph(graphToLinearNodes(mutated));
  // The o→n edge must survive the sidecar round-trip.
  assert.ok(reloaded.edges.some((e) => e.source === "o" && e.target === "n"));
  assert.ok(!reloaded.edges.some((e) => e.id === moving));
});

console.log(`\n${passed} passed\n`);
