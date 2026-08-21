// ---------------------------------------------------------------------------
// Workflow graph validation (Phase 17) — server mirror of the web module.
// ---------------------------------------------------------------------------
// The runtime stores a flat NodeSnapshot[] (id/type/order/config). The builder
// layers a graph on top: each node's config carries a runtime-ignored `_graph`
// sidecar { position, next[] } describing edges + layout. This module
// reconstructs the graph from that sidecar (falling back to order-implicit
// linear edges for legacy drafts saved before the graph builder) and runs the
// SAME structural checks the web module runs, returning structured issues.
//
// Keep in sync with web/src/workflow/graphValidation.ts. The rules are identical;
// only the input adapter (NodeSnapshot[] → graph) differs.
// ---------------------------------------------------------------------------

import { validateOutreachConfig } from "../engine/outreachVariables.js";

export type Severity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  severity: Severity;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Internal graph shape reconstructed from NodeSnapshot[].
// ---------------------------------------------------------------------------

interface GNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
}
interface GEdge {
  id: string;
  source: string;
  target: string;
}

// ---------------------------------------------------------------------------
// Domain rules (must match the web module).
// ---------------------------------------------------------------------------

const NODE_PHASE: Record<string, number> = {
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

const VALID_START_TYPES = new Set(["IMPORT_CREATOR_LIST", "INITIAL_OUTREACH"]);
const VALID_TERMINAL_TYPES = new Set(["REWARD_SETUP", "PAYMENT_INFO", "CONTENT_BRIEF", "END"]);
const KNOWN_TYPES = new Set([
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

const TYPE_LABEL: Record<string, string> = {
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

function phaseOf(type: string): number {
  return NODE_PHASE[type] ?? 99;
}
function edgeIdFor(source: string, target: string): string {
  return `e:${source}->${target}`;
}

// ---------------------------------------------------------------------------
// Adapter — NodeSnapshot[] (with `_graph` sidecar) → graph {nodes, edges}.
// ---------------------------------------------------------------------------

function buildGraph(nodesRaw: unknown): { nodes: GNode[]; edges: GEdge[] } | null {
  if (!Array.isArray(nodesRaw)) return null;

  const nodes: GNode[] = [];
  for (const raw of nodesRaw) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    nodes.push({
      id: typeof n["id"] === "string" ? (n["id"] as string) : "",
      type: typeof n["type"] === "string" ? (n["type"] as string) : "",
      config:
        n["config"] && typeof n["config"] === "object"
          ? (n["config"] as Record<string, unknown>)
          : {},
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id).filter(Boolean));

  // Prefer explicit edges from the `_graph` sidecar; fall back to order-implicit
  // linear edges for legacy drafts.
  const hasSidecarEdges = nodesRaw.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const cfg = (raw as Record<string, unknown>)["config"] as Record<string, unknown> | undefined;
    const sc = cfg?.["_graph"] as { next?: unknown } | undefined;
    return sc && Array.isArray(sc.next);
  });

  const edges: GEdge[] = [];
  const seen = new Set<string>();

  if (hasSidecarEdges) {
    for (const raw of nodesRaw) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      const source = typeof n["id"] === "string" ? (n["id"] as string) : "";
      const cfg = (n["config"] as Record<string, unknown> | undefined) ?? {};
      const sc = cfg["_graph"] as { next?: unknown } | undefined;
      const next = Array.isArray(sc?.next) ? (sc!.next as unknown[]) : [];
      for (const t of next) {
        if (typeof t !== "string" || !nodeIds.has(t)) continue;
        const id = edgeIdFor(source, t);
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ id, source, target: t });
      }
    }
  } else {
    // Legacy: order the snapshots and chain them.
    const ordered = [...nodesRaw]
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .sort((a, b) => Number(a["order"] ?? 0) - Number(b["order"] ?? 0));
    for (let i = 0; i < ordered.length - 1; i++) {
      const s = ordered[i]!;
      const t = ordered[i + 1]!;
      const source = typeof s["id"] === "string" ? (s["id"] as string) : "";
      const target = typeof t["id"] === "string" ? (t["id"] as string) : "";
      if (!source || !target) continue;
      const id = edgeIdFor(source, target);
      seen.add(id);
      edges.push({ id, source, target });
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// validateWorkflowGraph — structured graph validation over NodeSnapshot[].
// ---------------------------------------------------------------------------

export interface GraphValidationOptions {
  /**
   * When true, skip per-node required-config checks (subject/body/budget/brief)
   * and validate only the graph STRUCTURE (start/terminal/cycles/branching/
   * reachability/phase-order). Used at launch time, where the version is
   * immutable and config completeness was already gated at publish — this keeps
   * older versions (and demo-seeded graphs that use alternate config field
   * names) launchable while still refusing structurally-broken graphs.
   */
  structuralOnly?: boolean;
  /**
   * Review fix (PLU-143): CampaignDetails.briefDeliveryMethod — NOT node
   * config, so this validator (which otherwise only ever sees the
   * NodeSnapshot[] graph) has no way to see it unless the caller threads it
   * in explicitly. When `"pluvus_builder"`, the CONTENT_BRIEF node attaches
   * the PLU-142-resolved rendered CampaignBrief at send time instead of a
   * brand-uploaded `briefFileRef` (see contentBrief.ts) — so requiring
   * `briefFileRef` at publish for that campaign is a false positive that
   * blocks an otherwise-complete, correctly-configured campaign. Absent/
   * `"own_doc"`/anything else falls back to today's behavior unchanged.
   */
  briefDeliveryMethod?: string | null;
}

export function validateWorkflowGraph(
  nodesRaw: unknown,
  options: GraphValidationOptions = {},
): GraphValidationResult {
  const errors: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => errors.push(i);

  if (!Array.isArray(nodesRaw)) {
    return {
      valid: false,
      errors: [{ code: "NOT_AN_ARRAY", message: "nodeGraph must be an array", severity: "error" }],
    };
  }

  const graph = buildGraph(nodesRaw);
  if (!graph || graph.nodes.length === 0) {
    return {
      valid: false,
      errors: [
        { code: "EMPTY_GRAPH", message: "Workflow must have at least one node.", severity: "error" },
      ],
    };
  }

  const { nodes, edges } = graph;
  const byId = new Map<string, GNode>();

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

  const outMap = new Map<string, string[]>();
  const inMap = new Map<string, string[]>();
  for (const n of nodes) {
    outMap.set(n.id, []);
    inMap.set(n.id, []);
  }
  const seenEdgeKeys = new Set<string>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      push({
        code: "DANGLING_EDGE",
        message: "Edge connects to a node that doesn't exist.",
        edgeId: e.id,
        severity: "error",
      });
      continue;
    }
    if (e.source === e.target) {
      push({
        code: "SELF_LOOP",
        message: `Node "${label(byId, e.source)}" is connected to itself.`,
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
        message: `Duplicate connection ${label(byId, e.source)} → ${label(byId, e.target)}.`,
        edgeId: e.id,
        severity: "error",
      });
      continue;
    }
    seenEdgeKeys.add(key);
    outMap.get(e.source)!.push(e.target);
    inMap.get(e.target)!.push(e.source);
  }

  // disconnected (isolated) nodes — flagged first and excluded from the
  // start-node analysis so a lone island reads as "not connected" rather than
  // "extra entry point".
  const isIsolated = (id: string) =>
    (outMap.get(id) ?? []).length === 0 && (inMap.get(id) ?? []).length === 0;
  if (nodes.length > 1) {
    for (const n of nodes) {
      if (isIsolated(n.id)) {
        push({
          code: "DISCONNECTED_NODE",
          message: `"${label(byId, n.id)}" is not connected to anything.`,
          nodeId: n.id,
          severity: "error",
        });
      }
    }
  }

  // start nodes (connected nodes with no incoming edge)
  const startNodes = nodes.filter(
    (n) => (inMap.get(n.id) ?? []).length === 0 && !(nodes.length > 1 && isIsolated(n.id)),
  );
  if (startNodes.length === 0) {
    push({
      code: "NO_START_NODE",
      message: "No start node — the workflow has no entry point (fully cyclic).",
      severity: "error",
    });
  } else if (startNodes.length > 1) {
    for (const s of startNodes) {
      push({
        code: "MULTIPLE_START_NODES",
        message: `Multiple start nodes. "${label(byId, s.id)}" has no incoming connection — a workflow needs exactly one entry point.`,
        nodeId: s.id,
        severity: "error",
      });
    }
  } else if (!VALID_START_TYPES.has(startNodes[0]!.type)) {
    push({
      code: "INVALID_START_TYPE",
      message: `"${label(byId, startNodes[0]!.id)}" can't be the entry point. Start with Initial Outreach.`,
      nodeId: startNodes[0]!.id,
      severity: "error",
    });
  }

  // terminal nodes
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
          message: `"${label(byId, t.id)}" can't be a final step. End on Reward Setup, Payment Info, Content Brief, or End.`,
          nodeId: t.id,
          severity: "error",
        });
      }
    }
  }

  // branching / merge (linear)
  for (const n of nodes) {
    const outs = outMap.get(n.id) ?? [];
    const ins = inMap.get(n.id) ?? [];
    if (outs.length > 1)
      push({
        code: "INVALID_BRANCHING",
        message: `"${label(byId, n.id)}" has ${outs.length} outgoing connections. Workflows must be a single linear path.`,
        nodeId: n.id,
        severity: "error",
      });
    if (ins.length > 1)
      push({
        code: "INVALID_MERGE",
        message: `"${label(byId, n.id)}" has ${ins.length} incoming connections. Workflows must be a single linear path.`,
        nodeId: n.id,
        severity: "error",
      });
  }

  // cycles
  if (hasCycle(nodes, outMap)) {
    push({
      code: "CYCLE_DETECTED",
      message: "Workflow contains a cycle. Remove the looping connection.",
      severity: "error",
    });
  }

  // unreachable — nodes not reachable from the single start (isolated nodes were
  // already reported as DISCONNECTED_NODE above and are skipped here).
  if (startNodes.length === 1) {
    const reachable = reachableFrom(startNodes[0]!.id, outMap);
    for (const n of nodes) {
      if (nodes.length > 1 && isIsolated(n.id)) continue;
      if (!reachable.has(n.id)) {
        push({
          code: "UNREACHABLE_NODE",
          message: `"${label(byId, n.id)}" can't be reached from the start of the workflow.`,
          nodeId: n.id,
          severity: "error",
        });
      }
    }
  }

  // phase ordering
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    if (phaseOf(t.type) < phaseOf(s.type)) {
      push({
        code: "INVALID_PHASE_ORDER",
        message: phaseMessage(s.type, t.type),
        nodeId: t.id,
        edgeId: e.id,
        severity: "error",
      });
    }
  }

  // required node config (skipped in structural-only mode)
  if (!options.structuralOnly) {
    for (const n of nodes) {
      const issue = validateNodeConfig(n, options.briefDeliveryMethod);
      if (issue) push(issue);
    }
  }

  return { valid: errors.filter((e) => e.severity === "error").length === 0, errors };
}

// ---------------------------------------------------------------------------
// Per-node required config.
// ---------------------------------------------------------------------------

function validateNodeConfig(n: GNode, briefDeliveryMethod?: string | null): ValidationIssue | null {
  const cfg = n.config ?? {};
  switch (n.type) {
    case "INITIAL_OUTREACH": {
      // Manual Initial Outreach: mode-aware validation lives in the shared
      // outreachVariables module (one source of truth with the renderer + web
      // palette). Manual mode requires subject+body; both modes reject an
      // unknown {{variable}} so a typo can never mail literal braces.
      const issue = validateOutreachConfig(cfg);
      return issue ? err(n, issue.code, issue.message) : null;
    }
    case "FOLLOW_UP":
      if (!nonEmpty(cfg["bodyTemplate"]))
        return err(n, "MISSING_FOLLOWUP_BODY", "Follow-Up needs an email body.");
      if (!Array.isArray(cfg["intervals"]) || (cfg["intervals"] as unknown[]).length === 0)
        return err(n, "MISSING_INTERVALS", "Follow-Up needs at least one interval.");
      return null;
    case "NEGOTIATION": {
      const min = cfg["minBudget"];
      const max = cfg["maxBudget"];
      if (typeof min !== "number" || typeof max !== "number")
        return err(n, "MISSING_BUDGET", "Negotiation needs a preferred and maximum budget.");
      if (max < min)
        return err(
          n,
          "INVALID_BUDGET_RANGE",
          "Negotiation maximum budget is below the preferred budget.",
        );
      // BUG-W1: bound the money/loop knobs SERVER-SIDE. These were enforced only
      // in the builder UI, so a raw POST could publish maxRounds:9999 (unbounded
      // negotiation loop / LLM spend) or commissionRate:500 (a 5x payout). Reject
      // out-of-range values at publish. Absent values fall back to safe code
      // defaults, so only a PRESENT out-of-range value is an error.
      const boundsIssue = validateNegotiationBounds(n, cfg);
      if (boundsIssue) return boundsIssue;
      // HARD-N3: a fee band with a positive ceiling must have a positive floor. A
      // zero (or negative) min with a positive max opens the recommended offer at
      // $0 (floor-anchored) and lets the agent send a $0 fee — the $0-offer bug.
      // A truly commission-only campaign has no fee band at all (max 0), which is
      // allowed; only min<=0 WITH max>0 is rejected.
      if (max > 0 && min <= 0)
        return err(
          n,
          "INVALID_ZERO_FLOOR",
          "Negotiation preferred budget must be greater than 0 when a maximum budget is set (a $0 floor opens the offer at $0).",
        );
      // PLU-129: a campaign must offer SOMETHING. A zero-width fee band (max<=0 —
      // the canonical commission-only shape) with no positive commission is
      // "neither fee nor commission" — reject it so the builder can't publish a
      // deal with nothing to negotiate or pay. This also enforces "a positive
      // commission is required when the fixed fee is off" (the toggle's off state
      // persists max:0). Ordered AFTER the bounds check so a garbage commission
      // surfaces as INVALID_COMMISSION_RATE (0..100 bound) rather than here; we
      // only ask "is there a POSITIVE commission".
      const commission = cfg["commissionRate"];
      const hasCommission = typeof commission === "number" && commission > 0;
      if (max <= 0 && !hasCommission)
        return err(
          n,
          "MISSING_COMPENSATION",
          "This campaign has no fixed fee and no commission. Add a budget range or a commission rate greater than 0.",
        );
      return null;
    }
    case "CONTENT_BRIEF": {
      // Review fix (PLU-143): a "pluvus_builder" campaign attaches the
      // rendered CampaignBrief at send time, never briefFileRef — see
      // GraphValidationOptions.briefDeliveryMethod's own doc comment.
      if (briefDeliveryMethod !== "pluvus_builder" && !nonEmpty(cfg["briefFileRef"]))
        return err(
          n,
          "MISSING_BRIEF_ATTACHMENT",
          "Content Brief requires an uploaded Campaign Brief PDF.",
        );
      // BUG-W1: commissionRate is mirrored onto this node from the negotiation
      // node — bound it here too so a hand-crafted POST can't slip a 500%
      // commission onto the paying node.
      const commissionIssue = validatePercent(
        n,
        cfg["commissionRate"],
        "INVALID_COMMISSION_RATE",
        "commission rate",
      );
      if (commissionIssue) return commissionIssue;
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// BUG-W1 — server-side bounds on the money/loop knobs.
// ---------------------------------------------------------------------------
// Each knob is optional (an absent value uses a safe code default), so ONLY a
// present value out of range is an error. Bounds:
//   maxRounds             ∈ [1, 10]   (integer; 0/absent = code default 5)
//   commissionRate        ∈ [0, 100]  (a percentage)
//   overCeilingTolerance  ∈ [0, 100]  (a percentage of the ceiling)

const MAX_ROUNDS_MIN = 1;
const MAX_ROUNDS_MAX = 10;

function validateNegotiationBounds(
  n: GNode,
  cfg: Record<string, unknown>,
): ValidationIssue | null {
  const maxRounds = cfg["maxRounds"];
  if (maxRounds !== undefined && maxRounds !== null) {
    if (
      typeof maxRounds !== "number" ||
      !Number.isInteger(maxRounds) ||
      maxRounds < MAX_ROUNDS_MIN ||
      maxRounds > MAX_ROUNDS_MAX
    ) {
      return err(
        n,
        "INVALID_MAX_ROUNDS",
        `Negotiation maxRounds must be a whole number between ${MAX_ROUNDS_MIN} and ${MAX_ROUNDS_MAX}.`,
      );
    }
  }

  const commissionIssue = validatePercent(
    n,
    cfg["commissionRate"],
    "INVALID_COMMISSION_RATE",
    "commission rate",
  );
  if (commissionIssue) return commissionIssue;

  const toleranceIssue = validatePercent(
    n,
    cfg["overCeilingTolerance"],
    "INVALID_OVER_CEILING_TOLERANCE",
    "over-ceiling tolerance",
  );
  if (toleranceIssue) return toleranceIssue;

  return null;
}

/** Validate an optional percentage field is a number in [0, 100]. Absent → ok. */
function validatePercent(
  n: GNode,
  value: unknown,
  code: string,
  label: string,
): ValidationIssue | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    return err(n, code, `Negotiation ${label} must be a number between 0 and 100.`);
  }
  return null;
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

function hasCycle(nodes: GNode[], outMap: Map<string, string[]>): boolean {
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
  for (const n of nodes) if ((color.get(n.id) ?? WHITE) === WHITE && visit(n.id)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function label(byId: Map<string, GNode>, id: string): string {
  const n = byId.get(id);
  return n ? TYPE_LABEL[n.type] ?? n.type : id;
}

function phaseMessage(source: string, target: string): string {
  if (target === "PAYMENT_INFO")
    return "Payment Info can't come before the agreement is approved (it follows Reward Setup).";
  if (target === "CONTENT_BRIEF")
    return "Content Brief can't come before the creator accepts (it follows the negotiation).";
  if (target === "NEGOTIATION" && phaseOf(source) > phaseOf("NEGOTIATION"))
    return "Negotiation can't come after the deal is already finalized.";
  return `"${TYPE_LABEL[target] ?? target}" can't come after "${TYPE_LABEL[source] ?? source}" — it belongs earlier in the workflow.`;
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
function err(n: GNode, code: string, message: string): ValidationIssue {
  return { code, message, nodeId: n.id, severity: "error" };
}
