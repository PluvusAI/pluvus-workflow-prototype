// ---------------------------------------------------------------------------
// Workflow graph validation (Phase 17) — dedicated, UI-independent module.
// ---------------------------------------------------------------------------
// The single source of truth for whether a workflow graph is valid. It is a
// PURE function of the WorkflowDefinition — no React, no react-flow, no DOM. The
// UI (and the server, which mirrors these rules) simply calls validateGraph()
// and renders the structured result.
//
// A mirror of these rules lives on the server (server/src/validation/
// graphValidation.ts) so publish + launch enforce the exact same contract. Keep
// the two in sync when changing rules.
// ---------------------------------------------------------------------------

import type { NodeType } from "../api/builderTypes";
import type { WorkflowDefinition, GraphNode } from "./graphModel";
import { validateOutreachConfig } from "./outreachVariables";

// ---------------------------------------------------------------------------
// Structured result shape
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning";

export interface ValidationIssue {
  /** Stable machine code, e.g. "NO_START_NODE". */
  code: string;
  /** Human-readable message the UI can show verbatim. */
  message: string;
  /** The node this issue is attached to, if any. */
  nodeId?: string;
  /** The edge this issue is attached to, if any. */
  edgeId?: string;
  severity: Severity;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Issue helpers — shared derivations so every consumer (node card, sidebar,
// issues panel, publish banner) reads the SAME per-node validity signal. There
// is intentionally no second heuristic: this is the one source of truth.
// ---------------------------------------------------------------------------

/**
 * Group a flat issue list into per-node buckets keyed by `nodeId`. Issues with
 * no `nodeId` (graph-wide problems like EMPTY_GRAPH) are omitted here — surface
 * those separately via {@link graphLevelIssues}.
 */
export function issuesByNode(issues: ValidationIssue[]): Map<string, ValidationIssue[]> {
  const map = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    if (!issue.nodeId) continue;
    const bucket = map.get(issue.nodeId);
    if (bucket) bucket.push(issue);
    else map.set(issue.nodeId, [issue]);
  }
  return map;
}

/** Issues not tied to any node — shown as a separate "workflow-level" group. */
export function graphLevelIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => !i.nodeId);
}

/**
 * The single validity verdict for one node's set of issues. `error` beats
 * `warning` beats `ok`, so the card border/badge reflects the worst problem.
 */
export type NodeValidity = "ok" | "warning" | "error";

export function nodeValidity(issues: ValidationIssue[] | undefined): NodeValidity {
  if (!issues || issues.length === 0) return "ok";
  return issues.some((i) => i.severity === "error") ? "error" : "warning";
}

/**
 * De-duplicate issues by message, preserving order. The validator can emit the
 * same human message from more than one edge (e.g. two connections that both
 * violate phase order onto the same node); a user only needs to read it once.
 */
export function dedupeIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const out: ValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Domain rules — node phases + start/terminal classification.
// ---------------------------------------------------------------------------
// PHASE ordering encodes the business sequence. A node in a later phase must
// never precede a node in an earlier phase along the workflow path. This is how
// "payment cannot happen before approval" and "campaign brief cannot happen
// before creator acceptance" are enforced generically.
//
// Phase legend:
//   0 ENTRY      — creators enter here (import / first touch)
//   1 OUTREACH   — first + follow-up emails
//   2 DETECTION  — classify the reply
//   3 NEGOTIATE  — agree terms
//   4 APPROVAL   — creator accepts / agreement finalized (REWARD_SETUP, END)
//   5 PAYMENT    — collect payout details (after approval)
//   6 FULFILMENT — campaign brief / content (after acceptance)

const NODE_PHASE: Record<NodeType, number> = {
  IMPORT_CREATOR_LIST: 0,
  INITIAL_OUTREACH: 1,
  FOLLOW_UP: 1,
  REPLY_DETECTION: 2,
  NEGOTIATION: 3,
  REWARD_SETUP: 4,
  END: 4,
  PAYMENT_INFO: 5,
  CONTENT_BRIEF: 6,
};

// Node types that may legitimately be the START of a workflow (no incoming
// edge). The runtime enters at the first node by order — in practice outreach or
// the creator-import entry node.
const VALID_START_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "IMPORT_CREATOR_LIST",
  "INITIAL_OUTREACH",
]);

// Node types that may legitimately be a TERMINAL node (no outgoing edge).
const VALID_TERMINAL_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "REWARD_SETUP",
  "PAYMENT_INFO",
  "CONTENT_BRIEF",
  "END",
]);

const KNOWN_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "IMPORT_CREATOR_LIST",
  "INITIAL_OUTREACH",
  "FOLLOW_UP",
  "REPLY_DETECTION",
  "NEGOTIATION",
  "REWARD_SETUP",
  "PAYMENT_INFO",
  "CONTENT_BRIEF",
  "END",
]);

// Exported (PLU-130): connectionRules.ts derives its phase check from this.
export function phaseOf(type: NodeType): number {
  return NODE_PHASE[type] ?? 99;
}

// ---------------------------------------------------------------------------
// validateGraph — the entry point.
// ---------------------------------------------------------------------------

export function validateGraph(def: WorkflowDefinition): ValidationResult {
  const errors: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => errors.push(i);

  const nodes = def.nodes ?? [];
  const edges = def.edges ?? [];

  // -- empty graph ---------------------------------------------------------
  if (nodes.length === 0) {
    push({
      code: "EMPTY_GRAPH",
      message: "Workflow has no nodes. Add at least one node to publish.",
      severity: "error",
    });
    return { valid: false, errors };
  }

  const byId = new Map<string, GraphNode>();

  // -- duplicate / unknown node ids ---------------------------------------
  for (const n of nodes) {
    if (!n.id) {
      push({ code: "MISSING_NODE_ID", message: "A node is missing an id.", severity: "error" });
      continue;
    }
    if (byId.has(n.id)) {
      push({
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate node id "${n.id}".`,
        nodeId: n.id,
        severity: "error",
      });
      continue;
    }
    byId.set(n.id, n);
    if (!KNOWN_TYPES.has(n.type)) {
      push({
        code: "UNKNOWN_NODE_TYPE",
        message: `Node "${n.id}" has an unknown type "${n.type}".`,
        nodeId: n.id,
        severity: "error",
      });
    }
  }

  // -- edge integrity + duplicates ----------------------------------------
  const seenEdgeKeys = new Set<string>();
  const outMap = new Map<string, string[]>(); // source -> targets
  const inMap = new Map<string, string[]>(); // target -> sources
  for (const n of nodes) {
    outMap.set(n.id, []);
    inMap.set(n.id, []);
  }

  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      push({
        code: "DANGLING_EDGE",
        message: `Edge connects to a node that doesn't exist.`,
        edgeId: e.id,
        severity: "error",
      });
      continue;
    }
    if (e.source === e.target) {
      push({
        code: "SELF_LOOP",
        message: `Node "${e.source}" is connected to itself.`,
        nodeId: e.source,
        edgeId: e.id,
        severity: "error",
      });
      continue;
    }
    const key = `${e.source}->${e.target}`;
    if (seenEdgeKeys.has(key)) {
      push({
        code: "DUPLICATE_EDGE",
        message: `Duplicate connection ${labelFor(byId, e.source)} → ${labelFor(byId, e.target)}.`,
        edgeId: e.id,
        severity: "error",
      });
      continue;
    }
    seenEdgeKeys.add(key);
    outMap.get(e.source)!.push(e.target);
    inMap.get(e.target)!.push(e.source);
  }

  // -- disconnected (isolated) nodes --------------------------------------
  // Reported first and excluded from the start-node analysis so a lone island
  // reads as "not connected" rather than "extra entry point".
  const isIsolated = (id: string) =>
    (outMap.get(id) ?? []).length === 0 && (inMap.get(id) ?? []).length === 0;
  if (nodes.length > 1) {
    for (const n of nodes) {
      if (isIsolated(n.id)) {
        push({
          code: "DISCONNECTED_NODE",
          message: `"${labelFor(byId, n.id)}" is not connected to anything. Connect it or remove it.`,
          nodeId: n.id,
          severity: "error",
        });
      }
    }
  }

  // -- start nodes: exactly one -------------------------------------------
  const startNodes = nodes.filter(
    (n) => (inMap.get(n.id) ?? []).length === 0 && !(nodes.length > 1 && isIsolated(n.id)),
  );
  if (startNodes.length === 0) {
    push({
      code: "NO_START_NODE",
      message: "No start node — every node has an incoming connection (the graph is fully cyclic).",
      severity: "error",
    });
  } else if (startNodes.length > 1) {
    for (const s of startNodes) {
      push({
        code: "MULTIPLE_START_NODES",
        message: `Multiple start nodes. "${labelFor(byId, s.id)}" has no incoming connection — a workflow must have exactly one entry point.`,
        nodeId: s.id,
        severity: "error",
      });
    }
  } else {
    const start = startNodes[0]!;
    if (!VALID_START_TYPES.has(start.type)) {
      push({
        code: "INVALID_START_TYPE",
        message: `"${labelFor(byId, start.id)}" can't be the workflow's entry point. Start with Initial Outreach.`,
        nodeId: start.id,
        severity: "error",
      });
    }
  }

  // -- terminal nodes: at least one ---------------------------------------
  const terminalNodes = nodes.filter((n) => (outMap.get(n.id) ?? []).length === 0);
  if (terminalNodes.length === 0) {
    push({
      code: "NO_TERMINAL_NODE",
      message: "No terminal node — every node has an outgoing connection.",
      severity: "error",
    });
  } else {
    for (const t of terminalNodes) {
      if (!VALID_TERMINAL_TYPES.has(t.type)) {
        push({
          code: "INVALID_TERMINAL_TYPE",
          message: `"${labelFor(byId, t.id)}" can't be a final step — it has no next step. Connect it onward or end on Reward Setup, Payment Info, Content Brief, or End.`,
          nodeId: t.id,
          severity: "error",
        });
      }
    }
  }

  // -- branching: linear graph → at most one edge in/out per node ---------
  for (const n of nodes) {
    const outs = outMap.get(n.id) ?? [];
    const ins = inMap.get(n.id) ?? [];
    if (outs.length > 1) {
      push({
        code: "INVALID_BRANCHING",
        message: `"${labelFor(byId, n.id)}" has ${outs.length} outgoing connections. Workflows must be a single linear path — remove the extra connection(s).`,
        nodeId: n.id,
        severity: "error",
      });
    }
    if (ins.length > 1) {
      push({
        code: "INVALID_MERGE",
        message: `"${labelFor(byId, n.id)}" has ${ins.length} incoming connections. Workflows must be a single linear path — remove the extra connection(s).`,
        nodeId: n.id,
        severity: "error",
      });
    }
  }

  // -- cycle detection -----------------------------------------------------
  if (hasCycle(nodes, outMap)) {
    push({
      code: "CYCLE_DETECTED",
      message: "Workflow contains a cycle — nodes loop back on themselves. Remove the looping connection.",
      severity: "error",
    });
  }

  // -- unreachable nodes ---------------------------------------------------
  // Reachability from the (unique) start node. Isolated nodes were already
  // reported as DISCONNECTED_NODE above and are skipped here. Only meaningful
  // when we have a single clean start; otherwise the start errors above fire.
  if (startNodes.length === 1) {
    const reachable = reachableFrom(startNodes[0]!.id, outMap);
    for (const n of nodes) {
      if (nodes.length > 1 && isIsolated(n.id)) continue;
      if (!reachable.has(n.id)) {
        push({
          code: "UNREACHABLE_NODE",
          message: `"${labelFor(byId, n.id)}" can't be reached from the start of the workflow.`,
          nodeId: n.id,
          severity: "error",
        });
      }
    }
  }

  // -- invalid connection / phase ordering --------------------------------
  // A connection may never go from a later phase back to an earlier phase.
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const sp = phaseOf(s.type);
    const tp = phaseOf(t.type);
    if (tp < sp) {
      push({
        code: "INVALID_PHASE_ORDER",
        message: phaseMessage(s.type, t.type),
        nodeId: t.id,
        edgeId: e.id,
        severity: "error",
      });
    }
  }

  // -- required node configuration ----------------------------------------
  for (const n of nodes) {
    const cfgIssue = validateNodeConfig(n);
    if (cfgIssue) push(cfgIssue);
  }

  return { valid: errors.filter((e) => e.severity === "error").length === 0, errors };
}

// ---------------------------------------------------------------------------
// Per-node required configuration.
// ---------------------------------------------------------------------------

function validateNodeConfig(n: GraphNode): ValidationIssue | null {
  const cfg = (n.config ?? {}) as Record<string, unknown>;
  switch (n.type) {
    case "INITIAL_OUTREACH": {
      // Manual Initial Outreach: mode-aware validation. In "manual" mode the
      // operator's subject/body ARE the email, so both are required; in "ai" mode
      // (and legacy nodes with no mode) they're the AI fallback and stay optional.
      // Both modes reject an unknown {{variable}} so a typo can't ship literal
      // braces to a creator. Logic mirrors the server via the shared outreach
      // variables module.
      const issue = validateOutreachConfig(cfg);
      return issue ? cfgErr(n, issue.code, issue.message) : null;
    }
    case "FOLLOW_UP": {
      // Body is OPTIONAL for the same reason as INITIAL_OUTREACH: production
      // generates the follow-up with the AI (executeFollowUp → agent.draftEmail),
      // which writes the copy itself. bodyTemplate is only the fallback the engine
      // renders if AI generation fails after retries (email.draft() substitutes a
      // built-in generic body when it's blank). Intervals, by contrast, are NOT
      // AI-generated — they drive scheduling — so they stay required.
      if (!Array.isArray(cfg["intervals"]) || (cfg["intervals"] as unknown[]).length === 0)
        return cfgErr(n, "MISSING_INTERVALS", "Follow-Up needs at least one interval.");
      return null;
    }
    case "NEGOTIATION": {
      const min = cfg["minBudget"];
      const max = cfg["maxBudget"];
      if (typeof min !== "number" || typeof max !== "number")
        return cfgErr(n, "MISSING_BUDGET", "Negotiation needs a preferred and maximum budget.");
      if (max < min)
        return cfgErr(
          n,
          "INVALID_BUDGET_RANGE",
          "Negotiation maximum budget is below the preferred budget.",
        );
      // HARD-N3: a fee band with a positive ceiling must have a positive floor. A
      // $0 floor with a positive max opens the recommended offer at $0 (the
      // $0-offer bug). Commission-only campaigns (max 0) are unaffected.
      if (max > 0 && min <= 0)
        return cfgErr(
          n,
          "INVALID_ZERO_FLOOR",
          "Negotiation preferred budget must be greater than 0 when a maximum budget is set (a $0 floor opens the offer at $0).",
        );
      return null;
    }
    case "CONTENT_BRIEF": {
      // Required campaign brief attachment.
      if (!isNonEmptyString(cfg["briefFileRef"]))
        return cfgErr(
          n,
          "MISSING_BRIEF_ATTACHMENT",
          "Content Brief requires an uploaded Campaign Brief PDF.",
        );
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function reachableFrom(startId: string, outMap: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of outMap.get(id) ?? []) stack.push(next);
  }
  return seen;
}

function hasCycle(nodes: GraphNode[], outMap: Map<string, string[]>): boolean {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const visit = (id: string): boolean => {
    color.set(id, GRAY);
    for (const next of outMap.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  };

  for (const n of nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE && visit(n.id)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

// Exported (PLU-130): reused by connectionRules.ts for node-naming in messages.
export const TYPE_LABEL: Record<NodeType, string> = {
  IMPORT_CREATOR_LIST: "Import Creators",
  INITIAL_OUTREACH: "Initial Outreach",
  FOLLOW_UP: "Follow-Up",
  REPLY_DETECTION: "Reply Detection",
  NEGOTIATION: "Negotiation",
  REWARD_SETUP: "Reward Setup",
  PAYMENT_INFO: "Payment Info",
  CONTENT_BRIEF: "Content Brief",
  END: "End",
};

/** Human label for a node type (PLU-130). */
export function labelForType(type: NodeType): string {
  return TYPE_LABEL[type] ?? type;
}

function labelFor(byId: Map<string, GraphNode>, id: string): string {
  const n = byId.get(id);
  return n ? TYPE_LABEL[n.type] ?? n.type : id;
}

// Exported (PLU-130): shared so the connect-time block and the validator agree.
export function phaseMessage(source: NodeType, target: NodeType): string {
  // Friendly, specific messages for the flagship ordering rules.
  if (target === "PAYMENT_INFO")
    return `Payment Info can't come before the agreement is approved (it follows Reward Setup).`;
  if (target === "CONTENT_BRIEF")
    return `Content Brief can't come before the creator accepts (it follows the negotiation).`;
  if (target === "NEGOTIATION" && phaseOf(source) > phaseOf("NEGOTIATION"))
    return `Negotiation can't come after the deal is already finalized.`;
  return `"${TYPE_LABEL[target]}" can't come after "${TYPE_LABEL[source]}" — it belongs earlier in the workflow.`;
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function cfgErr(n: GraphNode, code: string, message: string): ValidationIssue {
  return { code, message, nodeId: n.id, severity: "error" };
}
