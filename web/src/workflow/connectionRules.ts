// Connection rules (PLU-130) — pure, framework-free source of truth for "may
// these two nodes connect?" plus the connect/reconnect/disconnect edge
// transforms. Shared by GraphCanvas's live feedback (isValidConnection) AND its
// commit path, so the two can never disagree. Rules are derived from
// graphValidation.ts (phaseOf/phaseMessage/labelForType) to stay in sync with the
// publish/launch validator. The workflow is a single linear chain: ≤1 outgoing
// (source branching is auto-rerouted) and ≤1 incoming (a merge is blocked).

import type { WorkflowDefinition, GraphEdge } from "./graphModel";
import { edgeId } from "./graphModel";
import { phaseOf, phaseMessage, labelForType } from "./graphValidation";

export type ConnectVerdict =
  | { ok: true }
  | { ok: false; code: string; reason: string };

const OK: ConnectVerdict = { ok: true };

function typeOf(def: WorkflowDefinition, nodeId: string) {
  return def.nodes.find((n) => n.id === nodeId)?.type;
}

// May we draw a NEW edge source → target? Branching from source is allowed
// (applyConnect reroutes it); only a merge on the target is blocked.
export function canConnect(
  def: WorkflowDefinition,
  source: string | null | undefined,
  target: string | null | undefined,
): ConnectVerdict {
  if (!source || !target) return { ok: false, code: "MISSING_ENDPOINT", reason: "Incomplete connection." };

  if (source === target)
    return { ok: false, code: "SELF_LOOP", reason: "A step can't connect to itself." };

  if (def.edges.some((e) => e.source === source && e.target === target))
    return { ok: false, code: "DUPLICATE_EDGE", reason: "These steps are already connected." };

  // A surviving incoming edge here is a genuine second parent (an edge from
  // `source` would have been caught as a duplicate above).
  const existingParent = def.edges.find((e) => e.target === target)?.source;
  if (existingParent && existingParent !== source) {
    const targetLabel = labelForType(typeOf(def, target) ?? ("" as never));
    return {
      ok: false,
      code: "INVALID_MERGE",
      reason: `"${targetLabel}" already has an incoming connection. Workflows are a single linear path — disconnect the existing one first.`,
    };
  }

  // No connection from a later phase back to an earlier one.
  const st = typeOf(def, source);
  const tt = typeOf(def, target);
  if (st && tt && phaseOf(tt) < phaseOf(st)) {
    return { ok: false, code: "INVALID_PHASE_ORDER", reason: phaseMessage(st, tt) };
  }

  return OK;
}

// Same predicate as canConnect but with the in-flight edge removed first —
// during an edge-updater drag React Flow still has the old edge present, so
// without this a valid reconnect would falsely read as a duplicate/merge.
export function canReconnect(
  def: WorkflowDefinition,
  movingEdgeId: string,
  source: string | null | undefined,
  target: string | null | undefined,
): ConnectVerdict {
  const without: WorkflowDefinition = {
    ...def,
    edges: def.edges.filter((e) => e.id !== movingEdgeId),
  };
  return canConnect(without, source, target);
}

// Commit a new edge, rerouting the source's existing "next" so we replace
// rather than branch. Assumes canConnect already passed.
export function applyConnect(
  def: WorkflowDefinition,
  source: string,
  target: string,
): GraphEdge[] {
  const id = edgeId(source, target);
  const withoutSourceOut = def.edges.filter((e) => e.source !== source);
  return [...withoutSourceOut, { id, source, target }];
}

// Move oldEdgeId to (source, target): drop the old edge and add the new one,
// or just drop the old one if the new edge already exists (dedupe).
export function applyReconnect(
  def: WorkflowDefinition,
  oldEdgeId: string,
  source: string,
  target: string,
): GraphEdge[] {
  const newId = edgeId(source, target);
  const withoutOld = def.edges.filter((e) => e.id !== oldEdgeId);
  if (withoutOld.some((e) => e.id === newId)) return withoutOld;
  return [...withoutOld, { id: newId, source, target }];
}

// Remove exactly one edge (the Disconnect action).
export function applyDisconnect(def: WorkflowDefinition, edgeIdToRemove: string): GraphEdge[] {
  return def.edges.filter((e) => e.id !== edgeIdToRemove);
}
