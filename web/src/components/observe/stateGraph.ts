// ---------------------------------------------------------------------------
// stateGraph — the workflow state machine as a typed graph, for observability.
// ---------------------------------------------------------------------------
// One source of truth for the nodes + edges the Observability canvas renders,
// with each edge classified so the canvas can style it:
//   kind "primary"     — the main happy-path pipeline (brighter, thicker)
//   kind "branch"      — a conditional fork off the main path (muted, dashed)
//   kind "loop"        — a self-loop / back-edge (dashed, subtle)
// Positions are NOT here — ELK computes them (see useElkLayout). This module is
// pure data, no React.
import type { InstanceState } from "../../api/types";

export type EdgeKind = "primary" | "branch" | "loop";

export interface StateEdge {
  from: InstanceState;
  to: InstanceState;
  kind: EdgeKind;
}

// The ordered happy path down the main pipeline. Used to mark primary edges and
// to give ELK a stable spine.
export const PRIMARY_PATH: InstanceState[] = [
  "ENROLLED",
  "OUTREACH_QUEUED",
  "OUTREACH_SENT",
  "AWAITING_REPLY",
  "REPLY_RECEIVED",
  "NEGOTIATING",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "CONTENT_BRIEF_SENT",
];

const PRIMARY_SET = new Set(PRIMARY_PATH.map((s) => s));

function isPrimaryEdge(from: InstanceState, to: InstanceState): boolean {
  const i = PRIMARY_PATH.indexOf(from);
  return i >= 0 && PRIMARY_PATH[i + 1] === to;
}

// The meaningful engine transitions (mirrors stateMachine.ts). Classification is
// derived: self-loop → loop; on the primary spine → primary; else → branch.
const RAW_EDGES: Array<[InstanceState, InstanceState]> = [
  ["ENROLLED", "OUTREACH_QUEUED"],
  ["OUTREACH_QUEUED", "OUTREACH_SENT"],
  // Legacy/retry compatibility for campaigns launched before queued outreach.
  ["ENROLLED", "OUTREACH_SENT"],
  ["OUTREACH_SENT", "AWAITING_REPLY"],
  ["AWAITING_REPLY", "FOLLOWED_UP"],
  ["FOLLOWED_UP", "AWAITING_REPLY"], // loop back
  ["AWAITING_REPLY", "REPLY_RECEIVED"],
  ["AWAITING_REPLY", "NO_RESPONSE"],
  ["REPLY_RECEIVED", "NEGOTIATING"],
  ["REPLY_RECEIVED", "REJECTED"],
  ["REPLY_RECEIVED", "MANUAL_REVIEW"],
  ["NEGOTIATING", "NEGOTIATING"], // self-loop (counter rounds)
  ["NEGOTIATING", "ACCEPTED"],
  ["NEGOTIATING", "REJECTED"],
  ["NEGOTIATING", "MANUAL_REVIEW"],
  ["ACCEPTED", "PAYMENT_PENDING"], // merged flow → content brief
  ["PAYMENT_PENDING", "CONTENT_BRIEF_SENT"], // creator submits payout → terminal
  ["ACCEPTED", "REWARD_PENDING"], // legacy reward setup
  ["REWARD_PENDING", "REWARD_PENDING"], // self-loop
  ["REWARD_PENDING", "REWARD_CONFIRMED"],
  ["REWARD_PENDING", "MANUAL_REVIEW"],
  ["REWARD_CONFIRMED", "PAYMENT_PENDING"], // legacy payment info
  ["PAYMENT_PENDING", "PAYMENT_RECEIVED"], // legacy payout form
  ["PAYMENT_PENDING", "MANUAL_REVIEW"],
  ["PAYMENT_RECEIVED", "CONTENT_BRIEF_SENT"], // legacy → content brief
  ["ACCEPTED", "NEEDS_DEAL_FINALIZATION"], // operator handoff branch
  ["NEEDS_DEAL_FINALIZATION", "HANDOFF_COMPLETE"],
];

export const STATE_EDGES: StateEdge[] = RAW_EDGES.map(([from, to]) => ({
  from,
  to,
  kind: from === to ? "loop" : isPrimaryEdge(from, to) ? "primary" : "branch",
}));

/** Incoming/outgoing transitions for a state (for the inspector). Excludes
 *  self-loops from the counts so "1 incoming" means a real predecessor. */
export function transitionsFor(state: InstanceState): {
  incoming: InstanceState[];
  outgoing: InstanceState[];
} {
  const incoming: InstanceState[] = [];
  const outgoing: InstanceState[] = [];
  for (const e of STATE_EDGES) {
    if (e.from === e.to) continue;
    if (e.to === state) incoming.push(e.from);
    if (e.from === state) outgoing.push(e.to);
  }
  return { incoming, outgoing };
}

export function isPrimaryState(state: InstanceState): boolean {
  return PRIMARY_SET.has(state);
}
